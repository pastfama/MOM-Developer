// ── MSAL auth ──
const msalInstance = new msal.ClientApplication(msalConfig);
let currentAccount = null;

function updateUI(account) {
  currentAccount = account;
  const userBox = document.getElementById("userBox");
  const landing = document.getElementById("landing");
  const chat = document.getElementById("chat");
  const userName = document.getElementById("userName");
  const sessionInfo = document.getElementById("sessionInfo");

  if (account) {
    userBox.style.display = "flex";
    userName.textContent = account.name || account.username;
    landing.style.display = "none";
    chat.style.display = "block";
    sessionInfo.textContent = "Session: " + (account.homeAccountId || "unknown").substring(0, 12);
    document.getElementById("logoutBtn").onclick = logout;
    initChat();
  } else {
    userBox.style.display = "none";
    landing.style.display = "block";
    chat.style.display = "none";
    sessionInfo.textContent = "No session";
  }
}

async function login() {
  try {
    const response = await msalInstance.loginPopup(loginRequest);
    const account = msalInstance.getActiveAccount() || response.account;
    updateUI(account);
  } catch (err) {
    console.error("Login failed:", err);
    // Fallback to redirect if popup is blocked
    msalInstance.loginRedirect(loginRequest);
  }
}

async function logout() {
  try {
    await msalInstance.logoutPopup();
  } catch (e) {}
  updateUI(null);
  // Clear chat
  const messages = document.getElementById("messages");
  if (messages) messages.innerHTML = "";
}

// Handle redirect callback
msalInstance.handleRedirectPromise().then(handleRedirectResponse).catch((err) => {
  console.error("Redirect response error:", err);
});

function handleRedirectResponse(tokenResponse) {
  if (tokenResponse !== null && tokenResponse.account !== null) {
    updateUI(tokenResponse.account);
  } else {
    updateUI(null);
  }
}

document.getElementById("loginBtn").addEventListener("click", login);

// Check for existing session on load
window.addEventListener("DOMContentLoaded", () => {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    updateUI(accounts[0]);
  }
});

// Expose token getter for chat module
window.getAccessToken = async () => {
  const account = msalInstance.getActiveAccount();
  if (!account) return null;
  try {
    const result = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account: account,
    });
    return result.accessToken;
  } catch (e) {
    // Silent failed, try popup
    try {
      const result = await msalInstance.acquireTokenPopup({
        ...loginRequest,
        account: account,
      });
      return result.accessToken;
    } catch (e2) {
      console.error("Token acquisition failed:", e2);
      return null;
    }
  }
};
