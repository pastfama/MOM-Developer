// ── Microsoft Entra ID config (fameshire-dev-portal app registration) ──
// Tenant: 185b412d-bddc-454b-9987-40628582c63c
// Client (app) id: 10749343-b8fa-4f91-bffc-d5feec907d6e
const msalConfig = {
  auth: {
    clientId: "10749343-b8fa-4f91-bffc-d5feec907d6e",
    authority: "https://login.microsoftonline.com/185b412d-bddc-454b-9987-40628582c63c",
    // Redirect URI must match one registered in the Entra app.
    // Dev: http://localhost:3000 | Prod: https://dev.fameshire.com
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

const loginRequest = {
  scopes: ["User.Read"],
  prompt: "select_account",
};

// API backend (local dev server or Azure Function App)
// Dev: http://localhost:3000/api/dev-agent | Prod: https://momtv-api.azurewebsites.net/api/dev-agent
const API_BASE = window.location.origin.includes("localhost")
  ? "http://localhost:3000"
  : "https://momtv-api.azurewebsites.net";
