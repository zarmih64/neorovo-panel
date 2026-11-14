const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages"
];

function corsHeaders(origin, env) {
  const allowed = env.FRONTEND_ORIGIN;
  if (!origin || !allowed || origin !== allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}
function response(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin, env), "cache-control": "no-store" }
  });
}
function redirect(url) {
  return Response.redirect(url, 302);
}
function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}
function b64(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function encryptionKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  return crypto.subtle.importKey("raw", unb64(env.TOKEN_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptSecret(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return JSON.stringify({ iv: b64(iv), data: b64(encrypted) });
}
async function decryptSecret(value, env) {
  const record = JSON.parse(value);
  const key = await encryptionKey(env);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(record.iv) }, key, unb64(record.data));
  return new TextDecoder().decode(clear);
}
function frontendUrl(env, params = {}) {
  const url = new URL(env.FRONTEND_ORIGIN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    const headers = corsHeaders(origin, env);
    if (!headers["access-control-allow-origin"]) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return response({ ok: true, service: "NEOROVO Instagram connector", connected: !!(await env.IG_KV.get("instagram_token")) }, 200, origin, env);
  }
  if (url.pathname === "/api/connect/start" && request.method === "POST") {
    if (origin !== env.FRONTEND_ORIGIN) return response({ error: "Origin not allowed" }, 403, origin, env);
    let body;
    try { body = await request.json(); } catch { return response({ error: "Invalid JSON" }, 400, origin, env); }
    if (!env.CONNECT_SETUP_CODE || body.setupCode !== env.CONNECT_SETUP_CODE) return response({ error: "Setup code is incorrect" }, 401, origin, env);
    if (!env.IG_APP_ID || !env.IG_REDIRECT_URI) return response({ error: "Meta App ID or Redirect URI is not configured on the Worker" }, 503, origin, env);
    const state = randomState();
    await env.IG_KV.put("oauth_state:" + state, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: 600 });
    const auth = new URL("https://www.instagram.com/oauth/authorize");
    auth.searchParams.set("client_id", env.IG_APP_ID);
    auth.searchParams.set("redirect_uri", env.IG_REDIRECT_URI);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", SCOPES.join(","));
    auth.searchParams.set("state", state);
    return response({ authorizeUrl: auth.toString() }, 200, origin, env);
  }
  if (url.pathname === "/auth/instagram/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const savedState = state ? await env.IG_KV.get("oauth_state:" + state) : null;
    if (!code || !savedState) return redirect(frontendUrl(env, { ig_connect: "failed", reason: "invalid_state" }));
    await env.IG_KV.delete("oauth_state:" + state);
    try {
      const form = new URLSearchParams({
        client_id: env.IG_APP_ID,
        client_secret: env.IG_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: env.IG_REDIRECT_URI,
        code
      });
      const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form
      });
      const shortData = await shortResponse.json();
      if (!shortResponse.ok || !shortData.access_token) throw new Error(shortData.error_message || "Instagram code exchange failed");
      const longUrl = new URL("https://graph.instagram.com/access_token");
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", env.IG_APP_SECRET);
      longUrl.searchParams.set("access_token", shortData.access_token);
      const longResponse = await fetch(longUrl);
      const longData = await longResponse.json();
      if (!longResponse.ok || !longData.access_token) throw new Error(longData.error?.message || "Long-lived token exchange failed");
      const token = longData.access_token;
      const profileUrl = new URL("https://graph.instagram.com/me");
      profileUrl.searchParams.set("fields", "id,user_id,username,account_type");
      profileUrl.searchParams.set("access_token", token);
      const profileResponse = await fetch(profileUrl);
      const profile = await profileResponse.json();
      if (!profileResponse.ok || !profile.id) throw new Error(profile.error?.message || "Could not read Instagram profile");
      const expiresAt = Date.now() + (Number(longData.expires_in) || 5184000) * 1000;
      const record = { token, profile: { id: profile.id, username: profile.username || "", accountType: profile.account_type || "PROFESSIONAL" }, expiresAt, connectedAt: new Date().toISOString() };
      await env.IG_KV.put("instagram_token", await encryptSecret(JSON.stringify(record), env));
      return redirect(frontendUrl(env, { ig_connect: "success" }));
    } catch (error) {
      console.error("Instagram OAuth callback failed:", error.message);
      return redirect(frontendUrl(env, { ig_connect: "failed", reason: "token_exchange" }));
    }
  }
  if (url.pathname === "/api/status" && request.method === "GET") {
    const stored = await env.IG_KV.get("instagram_token");
    if (!stored) return response({ connected: false }, 200, origin, env);
    try {
      const record = JSON.parse(await decryptSecret(stored, env));
      return response({ connected: true, profile: record.profile, expiresAt: record.expiresAt, connectedAt: record.connectedAt }, 200, origin, env);
    } catch {
      return response({ connected: false, error: "Stored token could not be decrypted; check TOKEN_ENCRYPTION_KEY" }, 500, origin, env);
    }
  }
  if (url.pathname === "/api/disconnect" && request.method === "POST") {
    if (origin !== env.FRONTEND_ORIGIN) return response({ error: "Origin not allowed" }, 403, origin, env);
    let body;
    try { body = await request.json(); } catch { return response({ error: "Invalid JSON" }, 400, origin, env); }
    if (!env.CONNECT_SETUP_CODE || body.setupCode !== env.CONNECT_SETUP_CODE) return response({ error: "Setup code is incorrect" }, 401, origin, env);
    await env.IG_KV.delete("instagram_token");
    return response({ connected: false }, 200, origin, env);
  }
  return response({ error: "Not found" }, 404, origin, env);
}
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (error) {
      console.error("Worker error:", error.message);
      const origin = request.headers.get("Origin");
      return response({ error: "Internal connector error" }, 500, origin, env);
    }
  }
};
