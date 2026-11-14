# NEOROVO Instagram Connector (Cloudflare Worker)

This is a backend starter for the official Instagram API with Instagram Login. It is not deployed and cannot connect until you configure a Cloudflare account, KV namespace, Meta app and secrets.

## 1. Create a KV namespace
In Cloudflare dashboard, create a Workers KV namespace named `NEOROVO_IG`. Copy its namespace ID into `wrangler.toml` instead of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 2. Configure Worker secrets and variables
Set these in Worker Settings → Variables and Secrets (never commit them to GitHub):
- `IG_APP_ID`: Instagram App ID shown in Meta's Instagram API setup.
- `IG_APP_SECRET`: corresponding Instagram App Secret.
- `CONNECT_SETUP_CODE`: a long random one-time-admin password used only to initiate connection and disconnect.
- `TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte random key for AES-GCM encryption of the stored access token.

Set these ordinary variables:
- `FRONTEND_ORIGIN`: exactly `https://zarmih64.github.io` (the origin only, no path).
- `IG_REDIRECT_URI`: `https://YOUR-WORKER-SUBDOMAIN.workers.dev/auth/instagram/callback`.

Generate a 32-byte encryption key with a local secure generator, for example:
```bash
openssl rand -base64 32
```
Do not send the output to anyone or add it to the repository.

## 3. Configure Meta
In Meta Developers, create/use an app and configure the Instagram API with Instagram Login / Business Login. Add the exact Worker callback URL above to the OAuth redirect URI allowlist. Use the Instagram App ID and Instagram App Secret from that Instagram login setup screen (do not assume they are interchangeable with other app credentials).

The worker currently requests only these permissions:
- `instagram_business_basic`
- `instagram_business_content_publish`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Add optional permissions only after confirming the current Meta dashboard and official docs support them for the selected login path. Do not assume Insights uses the same permission names as the Facebook Login path.

## 4. Deploy
Install Wrangler locally, authenticate with Cloudflare, then from this directory:
```bash
npm install -g wrangler
wrangler login
wrangler deploy
```
Copy the resulting `workers.dev` URL into the NEOROVO panel's Worker URL field.

## API
- `GET /health` — service check.
- `POST /api/connect/start` with JSON `{"setupCode":"..." }` — returns the Meta authorization URL.
- `GET /auth/instagram/callback` — OAuth callback; validates single-use state, exchanges the code, obtains a long-lived token, reads the profile, encrypts the token with AES-GCM and stores it in KV.
- `GET /api/status` — reports connection/profile metadata only, never the token.
- `POST /api/disconnect` with JSON setupCode — removes the stored token.

The worker restricts browser API requests to FRONTEND_ORIGIN, uses a 10-minute single-use OAuth state, does not return tokens to the browser, and stores tokens encrypted. Protect the setup code and encryption key as Cloudflare secrets. This starter has not yet been deployed or tested against a live Meta app; review current Meta dashboard requirements before production use.
