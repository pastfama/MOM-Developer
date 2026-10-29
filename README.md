# MOM-Developer — Dev Agent Portal

**dev.fameshire.com** — A personal Dev Agent with Microsoft login that knows you, remembers everything, and has full context on your Azure estate and GitHub repositories.

## What it is

A landing page with Microsoft Entra ID (Azure AD) single sign-on, plus a chat interface to your personal Dev Agent. Once signed in:

- **Knows who you are** — Microsoft profile (name, email, Entra ID) flows into every agent session
- **Remembers everything** — Per-user conversation history persisted across sessions
- **Knows your Azure** — Live inventory of your Azure resources injected into the system prompt
- **Knows your GitHub** — All your repositories, languages, and descriptions available to the agent

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (no build step) |
| Auth | Microsoft Entra ID via MSAL Browser (`@azure/msal-browser`) |
| API | Node.js HTTP server (local) / Azure Functions (production) |
| LLM | Foundry agent `momtv-developer` (gpt-4.1-mini) via Responses API |
| Memory | In-memory sessions (local dev) / Cosmos DB (production) |
| Hosting | Azure Static Web Apps + Azure Functions |

## Project structure

```
MOM-Developer/
├── dev-portal/          # Frontend (served by Azure Static Web Apps)
│   ├── index.html       # Landing page + chat UI + saved-session sidebar
│   ├── css/style.css    # Styles
│   ├── js/config.js     # MSAL + API config
│   ├── js/auth.js       # MSAL login/logout/session
│   ├── js/chat.js       # Chat UI, saved sessions, history replay
│   └── js/app.js        # Bootstrap
├── lib/
│   ├── session-store.js # Disk-backed per-user conversation store
│   ├── apply-engine.js  # Writes the agent's file blocks into the repo
│   └── foundry-auth.js  # Keyless Entra ID auth (App Service + IMDS)
├── test/                # node:test suites (no dependencies)
├── server.js            # Local dev server + API
├── package.json         # Scripts only — zero dependencies
├── README.md
└── .gitignore
```

## How the agent finishes the job

The agent does not hand back snippets to paste. When a change needs code, it is
instructed to emit each file in full:

````
```file:dev-portal/js/chat.js
<complete file contents>
```
````

`lib/apply-engine.js` parses those blocks and writes them straight into the
repository, so a request ends with real files on disk instead of "let me know if
you need help integrating this". The UI shows which files were written (and any
it refused). Guards prevent it from touching `.git/`, `node_modules/`, `.env`
files, keys, binaries, or anything outside the repo, and the whole step can be
disabled with `DEV_AGENT_AUTO_APPLY=0`.

## Memory

Every turn is appended to disk per user, keyed to the Entra ID object id:

```
.data/sessions/users/<sha256(userKey)>/sessions/<sessionId>.json
```

History survives page reloads, browser restarts and server restarts, and is
replayed into the model on every turn. Sessions are listed in the sidebar so any
earlier conversation can be reopened.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/dev-agent` | Send a message; returns the reply plus files written |
| `GET` | `/api/dev-agent/history?sessionId=…` | Replay a stored thread |
| `GET` | `/api/sessions` | List this user's saved sessions |
| `POST` | `/api/sessions` | Start a new session |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `GET` | `/api/health` | Config check (key present, auto-apply, data dir) |

Static files are served from `dev-portal/` only. Unknown API routes return JSON,
never an HTML fallback.

## Tests

```bash
npm test        # node --test test/*.test.js
```

Covers session persistence across restarts, per-user isolation, path-traversal
and secret-file refusals in the apply engine, and an end-to-end turn with a
stubbed Foundry endpoint (files written, memory replayed on the next turn).

## Local development

```bash
# Install Node.js (v18+), then:
npm start                 # same as: node server.js
# Open: http://localhost:3000
# Entra redirect URI: http://localhost:3000

npm test                  # run the test suite
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local server port | `3000` |
| `FOUNDRY_API_KEY` | Fallback API key — **not needed** when a managed identity is available | *(optional)* |
| `FOUNDRY_AUTH` | `auto` (identity, then key) \| `entra` (identity only) \| `key` | `auto` |
| `FOUNDRY_TOKEN_SCOPE` | Entra scope for the agent endpoint | `https://ai.azure.com/.default` |
| `FOUNDRY_CLIENT_ID` | Client id of a *user-assigned* identity, if used | *(system-assigned)* |
| `FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint | `https://fameshire-foundry-resource.services.ai.azure.com/api/projects/fameshire-foundry` |
| `AGENT_ID` | Foundry agent name | `momtv-developer` |
| `AGENT_API_VERSION` | Foundry API version | `2025-05-15-preview` |
| `GITHUB_PAT` | GitHub personal access token (repo + read:user) | *(required for repo context)* |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID | `8cce2fe7-7c75-4969-9da9-707aadd13e52` |
| `AZURE_TENANT_ID` | Azure AD tenant ID | `185b412d-bddc-454b-9987-40628582c63c` |
| `DATA_DIR` | Where conversations are persisted | `.data` |
| `DEV_AGENT_AUTO_APPLY` | Write the agent's file blocks into the repo (`0` disables) | `1` |
| `DEV_AGENT_APPLY_ROOT` | Tree the agent may write into | repo root |

## Microsoft Entra ID setup

1. Register an app in Entra ID (Azure Portal → App registrations → New registration)
   - Name: `fameshire-dev-portal`
   - Supported account types: Accounts in this organizational directory only
   - Redirect URI (SPA): `http://localhost:3000` (dev) and `https://dev.fameshire.com` (prod)
2. Add API permission: Microsoft Graph → `User.Read`
3. Copy the **Application (client) ID** and **Directory (tenant) ID** into `dev-portal/js/config.js`
4. Create a client secret and set it as `FOUNDRY_API_KEY` (or use the API key for Foundry auth)

## Production deployment

### Frontend (Azure Static Web Apps)

Create a Static Web App pointing at this repo, with:
- App location: `/dev-portal`
- Output location: `.`
- Custom domain: `dev.fameshire.com` (CNAME → SWA default hostname)

### API (Azure Functions)

Deploy `server.js` (or the Function App equivalent) to an Azure Function App with:
- `FUNCTIONS_WORKER_RUNTIME=node`
- `WEBSITE_NODE_DEFAULT_VERSION=18`
- All environment variables above set as app settings
- CORS allowed origins: `https://dev.fameshire.com`

## Agent authentication (keyless by default)

The agent authenticates to Foundry with an **Entra ID managed identity**, so
production runs with no static secret at all. Both identity endpoints are
supported because they are not interchangeable:

| Host | Endpoint used |
|------|---------------|
| Azure App Service / Functions / Container Apps | `IDENTITY_ENDPOINT` + `IDENTITY_HEADER` (IMDS is unreachable here) |
| VM / AKS / Container Instances | IMDS `169.254.169.254` |

Tokens are cached in-process until 5 minutes before expiry, refreshed once and
retried automatically if Foundry answers `401`, and failed probes are remembered
for 30s so a host without an identity does not pay the timeout on every turn.

### Setup

```bash
# 1. Give the app an identity
az webapp identity assign -g <resource-group> -n momtv-api        # App Service
az functionapp identity assign -g <resource-group> -n momtv-api   # Functions

# 2. Grant it access to the Foundry resource (least privilege)
az role assignment create \
  --assignee <principalId-from-step-1> \
  --role "Cognitive Services User" \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<foundry>

# 3. Deploy with no key
#    FOUNDRY_AUTH=auto   (default)
#    FOUNDRY_API_KEY     unset
```

Scopes — set `FOUNDRY_TOKEN_SCOPE` if you are not on AI Foundry:

| Endpoint | Scope |
|----------|-------|
| `*.services.ai.azure.com` (AI Foundry) | `https://ai.azure.com/.default` |
| `*.openai.azure.com` / classic Azure OpenAI | `https://cognitiveservices.azure.com/.default` |

Local development has no identity, so either set `FOUNDRY_API_KEY` with
`FOUNDRY_AUTH=key`, or leave `auto` and the server will fall back to the key.
`GET /api/health` reports the resolved mode, scope and whether a key is present.

## Security notes

- Production uses managed identity — no Foundry key is deployed at all
- Never commit API keys, PATs, or client secrets to this repo
- Use GitHub Secrets / Azure App Settings for all credentials
- The Microsoft access token is sent as `Authorization: Bearer <token>` to `/api/dev-agent`
- The backend validates the token via Microsoft Graph `/me`

## License

MIT
