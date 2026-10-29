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
    // Without this, acquireTokenSilent() has no account after a page reload
    // and every API call goes out without a bearer token.
    msalInstance.setActiveAccount(account);
    userBox.style.display = "flex";
    userName.textContent = account.name || account.username || "Signed in";
    landing.style.display = "none";
    chat.style.display = "flex";
    sessionInfo.textContent = "Signed in";
    document.getElementById("logoutBtn").onclick = logout;
    initChat(account);
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
    updateUI(msalInstance.getActiveAccount() || response.account);
  } catch (err) {
    console.error("Login popup failed, falling back to redirect:", err);
    msalInstance.loginRedirect(loginRequest);
  }
}

async function logout() {
  try {
    await msalInstance.logoutPopup();
  } catch (e) {
    console.warn("Logout popup failed:", e && e.message);
  }
  updateUI(null);
  const messages = document.getElementById("messages");
  if (messages) messages.innerHTML = "";
}

// Handle the redirect callback before anything else touches the session.
msalInstance
  .handleRedirectPromise()
  .then((tokenResponse) => {
    if (tokenResponse && tokenResponse.account) {
      msalInstance.setActiveAccount(tokenResponse.account);
      updateUI(tokenResponse.account);
      return;
    }
    const accounts = msalInstance.getAllAccounts();
    updateUI(accounts.length ? accounts[0] : null);
  })
  .catch((err) => {
    console.error("Redirect response error:", err);
    const accounts = msalInstance.getAllAccounts();
    updateUI(accounts.length ? accounts[0] : null);
  });

document.getElementById("loginBtn").addEventListener("click", login);

// Expose token getter for the chat module.
window.getAccessToken = async () => {
  const account =
    msalInstance.getActiveAccount() || (msalInstance.getAllAccounts() || [])[0] || null;
  if (!account) return null;
  msalInstance.setActiveAccount(account);
  try {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    return result.accessToken;
  } catch (e) {
    try {
      const result = await msalInstance.acquireTokenPopup({ ...loginRequest, account });
      return result.accessToken;
    } catch (e2) {
      console.error("Token acquisition failed:", e2 && e2.message);
      return null;
    }
  }
};
