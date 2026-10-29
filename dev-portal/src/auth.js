import { PublicClientApplication } from "@azure/msal-browser";
import { loginRequest, msalConfig } from "./config.js";

const msalInstance = new PublicClientApplication(msalConfig);
let onAccountChange = () => {};

function updateUI(account) {
  const userBox = document.getElementById("userBox");
  const landing = document.getElementById("landing");
  const chat = document.getElementById("chat");
  const sessionInfo = document.getElementById("sessionInfo");
  const loginError = document.getElementById("loginError");

  if (account) {
    msalInstance.setActiveAccount(account);
    userBox.hidden = false;
    document.getElementById("userName").textContent = account.name || account.username || "Signed in";
    landing.hidden = true;
    chat.hidden = false;
    sessionInfo.textContent = "Loading saved conversations…";
    loginError.hidden = true;
  } else {
    userBox.hidden = true;
    landing.hidden = false;
    chat.hidden = true;
    sessionInfo.textContent = "No session";
  }
  onAccountChange(account);
}

async function login() {
  try {
    const response = await msalInstance.loginPopup(loginRequest);
    updateUI(msalInstance.getActiveAccount() || response.account);
  } catch (error) {
    console.error("Microsoft sign-in failed:", error);
    const message = document.getElementById("loginError");
    message.textContent = "Sign-in failed. Please try again or check the browser console.";
    message.hidden = false;
  }
}

async function logout() {
  const account = msalInstance.getActiveAccount();
  try {
    await msalInstance.logoutPopup({ account });
    updateUI(null);
  } catch (error) {
    console.error("Microsoft sign-out failed:", error);
    const message = document.getElementById("loginError");
    message.textContent = "Sign-out failed. Please try again.";
    message.hidden = false;
  }
}

export async function initializeAuth(onChange) {
  onAccountChange = onChange;
  await msalInstance.initialize();

  const response = await msalInstance.handleRedirectPromise();
  const accounts = msalInstance.getAllAccounts();
  const account = response?.account || msalInstance.getActiveAccount() || accounts[0] || null;
  if (account) msalInstance.setActiveAccount(account);

  document.getElementById("loginBtn").addEventListener("click", login);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  updateUI(account);
}

window.getAccessToken = async () => {
  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0] || null;
  if (!account) throw new Error("Please sign in again to continue.");
  msalInstance.setActiveAccount(account);

  try {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    return result.accessToken;
  } catch (error) {
    console.warn("Silent token acquisition failed; requesting user interaction:", error);
    const result = await msalInstance.acquireTokenPopup({ ...loginRequest, account });
    return result.accessToken;
  }
};
