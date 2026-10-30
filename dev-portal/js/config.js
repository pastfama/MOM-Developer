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
};
// Silent token acquisition must NOT include "prompt" — MSAL will use the
// cached account silently. Only interactive login (loginPopup) should ever
// show the account chooser, and only when there's no cached session.
const silentRequest = {
  scopes: ["User.Read"],
};

// API backend.
// Prod: same origin. Azure Static Web Apps proxies /api/* to the linked API,
// so there is no separate hostname to hardcode (the previous value,
// momtv-api.azurewebsites.net, has no DNS record and broke every call).
// Dev: the local node server.
const API_BASE = window.location.origin.includes("localhost")
  ? "http://localhost:3000"
  : "";
