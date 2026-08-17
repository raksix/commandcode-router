# CommandCode Router

Anthropic-compatible API proxy. Claude Code (or any Anthropic SDK client) connects to the proxy with a **master API key** you generate; the proxy distributes requests **round-robin** across a **pool of CommandCode API keys**. Add 10 accounts and all 10 keys are used in rotation automatically. If an account errors, the proxy falls through to the next one; too many consecutive errors and the account is auto-banned.

```
Claude Code ──(masterKey)──► Router ──(round-robin)──► CommandCode account 1
   (Anthropic format)                 ├──► CommandCode account 2
                                     ├──► ...
                                     └──► CommandCode account 10
```

## Features

- **Anthropic-compatible endpoint** — `POST /v1/messages`, `GET /v1/models` (SSE streaming included)
- **OpenAI-compatible endpoint** — `POST /v1/chat/completions`
- **Round-robin distribution** — every request goes to the next account (order survives restarts)
- **Auto-fallback** — on 401/429/5xx switches to the next account (max 2 retries)
- **Auto-ban** — after 5 consecutive errors an account is disabled and can be removed from the panel
- **Multiple master API keys** — create named keys, copy/regenerate/delete each independently
- **Web panel** — add/remove/test accounts, manage keys, model list, per-account stats, request logs, API docs
- **Model prefix stripping** — strips gateway prefixes (`anthropic:cmd/...` → `cmd/...`) so the model name is never rejected upstream
- **OSS model conversion** — deepseek/gpt/... models sent via `/v1/messages` are auto-converted to OpenAI format (`/v1/chat/completions`)

## Setup

```bash
git clone https://github.com/raksix/commandcode-router.git
cd commandcode-router
npm install
npm start
```

On first launch `config.json` is generated automatically and the **Master API Key** + **Admin password** are printed to the console. Save these values (you can also view them later from the panel).

## Usage

1. Open the web panel (`http://localhost:<port>` — default `3025`) and sign in with the admin password.
2. In **Accounts**, add your CommandCode API keys. Each key is one "account".
3. Verify each account with the **Test** button (fetches the model list from CommandCode).
4. Create a master key in **API Keys** and point Claude Code at the proxy.

### Connecting Claude Code

```bash
# project-level .env or global settings (settings.json env block)
ANTHROPIC_BASE_URL=http://localhost:3025
ANTHROPIC_AUTH_TOKEN=<masterKey>
```

> ⚠️ Do **NOT** append `/v1` to `ANTHROPIC_BASE_URL` — Claude Code appends `/v1/messages` itself.

To pin a model, override it client-side:

```bash
ANTHROPIC_MODEL=deepseek/deepseek-v4-flash
```

### cURL test

```bash
curl http://localhost:3025/v1/models -H "Authorization: Bearer <masterKey>"

curl -X POST http://localhost:3025/v1/messages \
  -H "Authorization: Bearer <masterKey>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek/deepseek-v4-flash","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

> 💡 List the available models with `GET /v1/models`. Some models (e.g. `claude-sonnet-5`, `claude-opus-5`) require a **Provider plan**; Go-plan accounts can use `deepseek/...` or other OpenAI-format models.

## Configuration

Runtime configuration lives in `config.json` (auto-generated, gitignored, **never commit it**):

| Field | Description |
|---|---|
| `port` | Server port (default 3025) |
| `masterKeys` | Array of client API keys (`{ id, name, key, createdAt, lastUsedAt }`) |
| `adminPassword` | Web panel password |
| `accounts` | CommandCode key pool |
| `exposedModels` | Models advertised via `/v1/models` (empty = all) |
| `retry.maxRetries` | Fallback switches per request (2) |
| `retry.banAfter` | Auto-ban threshold (5 consecutive errors) |

## Security Notes

- API keys are stored **in plain text** in `config.json` (gitignored — acceptable for a self-hosted proxy).
- Every `/v1/*` endpoint requires a valid master key.
- The web panel uses a separate admin password + HttpOnly cookie session.
- If you expose the proxy to the internet, put an auth layer in front of it.

## Troubleshooting

- **`Model "X" is not supported on this endpoint`** → Use a model the account's plan supports (check `GET /v1/models`). Go-plan accounts: `deepseek/...` etc.
- **`permission_error` / "Your Go plan doesn't include API access"** → That CommandCode account has no API access (Provider plan required). Try another account/key.
- **`Model/provider not recognized: anthropic:...`** → A gateway sent a prefixed model name. The router strips these automatically (see `cleanModelPrefix` in `src/convert.js`); make sure you're running the latest code.
- **Responses arrive all at once instead of streaming** → nginx `proxy_buffering` must be `off` in the vhost (`proxy_buffering off; proxy_cache off; chunked_transfer_encoding on;`).
- **Port already in use** → `netstat -tlnp | grep 3025`, kill the process, then `npm start` again.
