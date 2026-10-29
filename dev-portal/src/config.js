export const msalConfig = {
  auth: {
    clientId: "10749343-b8fa-4f91-bffc-d5feec907d6e",
    authority: "https://login.microsoftonline.com/185b412d-bddc-454b-9987-40628582c63c",
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ["User.Read"],
  prompt: "select_account",
};
