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
│   ├── index.html       # Landing page + chat UI
│   ├── css/style.css    # Styles
│   ├── js/config.js     # MSAL + API config
│   ├── js/auth.js       # MSAL login/logout/session
│   ├── js/chat.js       # Chat UI + message handling
│   └── js/app.js        # Bootstrap
├── server.js            # Local dev server (+ /api/dev-agent)
├── README.md
└── .gitignore
```

## Local development

```bash
# Install Node.js (v18+), then:
node server.js
# Open: http://localhost:3000
# Entra redirect URI: http://localhost:3000
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local server port | `3000` |
| `FOUNDRY_API_KEY` | Foundry / Azure OpenAI API key | *(required for agent calls)* |
| `FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint | `https://fameshire-foundry-resource.services.ai.azure.com/api/projects/fameshire-foundry` |
| `AGENT_ID` | Foundry agent name | `momtv-developer` |
| `AGENT_API_VERSION` | Foundry API version | `2025-05-15-preview` |
| `GITHUB_PAT` | GitHub personal access token (repo + read:user) | *(required for repo context)* |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID | `8cce2fe7-7c75-4969-9da9-707aadd13e52` |
| `AZURE_TENANT_ID` | Azure AD tenant ID | `185b412d-bddc-454b-9987-40628582c63c` |

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

## Security notes

- Never commit API keys, PATs, or client secrets to this repo
- Use GitHub Secrets / Azure App Settings for all credentials
- The Microsoft access token is sent as `Authorization: Bearer <token>` to `/api/dev-agent`
- The backend validates the token via Microsoft Graph `/me`

## License

MIT
