# Aether

Anti-detect AI browser agent: real Chrome over CDP, Stagehand hybrid agents, async jobs with webhooks.

## Quick start

1. Copy `.env.example` → `.env` and fill in Convex, LLM keys, `AETHER_API_KEY`, `WORKER_KEY`.
2. Deploy Convex: `npx convex dev` (or your production deploy).
3. Set Convex dashboard env vars: `WORKER_KEY`, `AETHER_API_KEY`, `AETHER_WEBHOOK_SECRET` (optional global webhook HMAC secret).
4. Run a worker locally: `pnpm worker`
5. Submit a job:

```bash
curl -X POST "$CONVEX_SITE_URL/v1/jobs" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AETHER_API_KEY" \
  -d '{
    "startUrl": "https://example.com",
    "instructions": "Summarize the page title and main heading.",
    "webhookUrl": "https://your-server.example/hooks/aether",
    "model": "gemini-3-flash-preview"
  }'
```

Poll status: `GET $CONVEX_SITE_URL/v1/jobs/<jobId>` with the same API key.

Or use the CLI:

```bash
pnpm aether run \
  --start-url https://example.com \
  --instructions "Summarize the page" \
  --webhook-url https://your-server.example/hooks/aether \
  --poll
```

## Vaultwarden credentials + MCP (invoice download flow)

Point the worker at your self-hosted Vaultwarden and install the Bitwarden CLI (`bw`) on the worker host.

Worker env (see `.env.example`):

- `BW_SERVER_URL` — Vaultwarden base URL
- `BW_CLIENTID` / `BW_CLIENTSECRET` — personal API key for `bw login --apikey`
- `BW_PASSWORD` — master password for `bw unlock`, or set `BW_SESSION` if pre-unlocked

Register MCP connections (e.g. Bitwarden for mid-run TOTP, Gmail for OTP):

```bash
pnpm aether mcp add
# stdio example: npx -y @bitwarden/mcp-server with env BW_SESSION,BW_SERVER_URL
```

Example n8n-style job body — download a Cursor invoice using vault creds:

```bash
curl -X POST "$CONVEX_SITE_URL/v1/jobs" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AETHER_API_KEY" \
  -d '{
    "startUrl": "https://cursor.com/settings/billing",
    "instructions": "Log in if needed, open billing, download the latest invoice PDF.",
    "webhookUrl": "https://n8n.example/webhook/aether-done",
    "secretRefs": {
      "username": "bw:Cursor Plan/username",
      "password": "bw:Cursor Plan/password"
    },
    "mcpServers": ["bitwarden"],
    "metadata": { "workflow": "cursor-invoice" }
  }'
```

On completion the webhook includes `artifacts[]` with signed download URLs for any files the browser saved — n8n can fetch each URL and upload to Google Drive.

## VPS (Docker + Xvfb)

```bash
docker compose up -d --build
```

The worker image starts Xvfb on `:99` and runs headed Chrome for stealth. Mount `aether-profiles` for persistent browser state.

Required env in `.env`:

- `CONVEX_URL`, `WORKER_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY` and/or `ANTHROPIC_API_KEY`
- `CAPSOLVER_API_KEY` (for captcha tool)
- Proxy vars or per-job `proxy` in API payload
- `BW_*` vars if using `secretRefs`

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/jobs` | Create agent job (`webhookUrl` required) |
| GET | `/v1/jobs/:id` | Job status + result |
| POST | `/v1/jobs/:id/cancel` | Cancel pending job |
| GET | `/v1/mcp-connections` | List MCP connections |
| PUT | `/v1/mcp-connections` | Create/update MCP connection |
| DELETE | `/v1/mcp-connections/:name` | Remove MCP connection |

Webhook payload (HMAC `X-Aether-Signature: sha256=...`):

```json
{
  "jobId": "...",
  "status": "done",
  "summary": "...",
  "steps": 12,
  "finalUrl": "...",
  "error": null,
  "metadata": {},
  "artifacts": [
    {
      "name": "invoice.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 12345,
      "storageId": "...",
      "url": "https://..."
    }
  ]
}
```

Job payload fields:

- `secretRefs` — map of variable names to `bw:VaultItem/field` refs (mutually exclusive with inline `login`)
- `mcpServers` — array of registered connection names to attach as agent tools

## CLI

```bash
pnpm aether worker          # claim queue, spawn browser runners
pnpm aether experiment      # foreground agent on a profile
pnpm aether stealthtest     # open URL in stealth browser
pnpm aether proxy add       # manage proxy pool
pnpm aether mcp list        # manage MCP connections
```
