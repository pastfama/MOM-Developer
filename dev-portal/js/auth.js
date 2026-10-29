// ── MSAL auth ──
let msalInstance = null;
let currentAccount = null;
let msalReady = false;
const msalReadyCallbacks = [];

function onMSALReady(fn) {
  if (msalReady) {
    fn();
  } else {
    msalReadyCallbacks.push(fn);
  }
}

function initMSAL() {
  if (typeof window === "undefined" || typeof window.Msal === "undefined") {
    setTimeout(initMSAL, 100);
    return;
  }
  msalInstance = new window.Msal.ClientApplication(msalConfig);
  msalReady = true;
  msalReadyCallbacks.forEach((fn) => fn());
}

initMSAL();

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
  onMSALReady(async () => {
    try {
      const response = await msalInstance.loginPopup(loginRequest);
      updateUI(msalInstance.getActiveAccount() || response.account);
    } catch (err) {
      console.error("Login popup failed, falling back to redirect:", err);
      msalInstance.loginRedirect(loginRequest);
    }
  });
}

async function logout() {
  onMSALReady(async () => {
    try {
      await msalInstance.logoutPopup();
    } catch (e) {
      console.warn("Logout popup failed:", e && e.message);
    }
    updateUI(null);
    const messages = document.getElementById("messages");
    if (messages) messages.innerHTML = "";
  });
}

// Handle the redirect callback before anything else touches the session.
onMSALReady(() => {
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
});

document.getElementById("loginBtn").addEventListener("click", login);

// Expose token getter for the chat module.
window.getAccessToken = async () => {
  return new Promise((resolve) => {
    onMSALReady(async () => {
      const account =
        msalInstance.getActiveAccount() ||
        (msalInstance.getAllAccounts() || [])[0] ||
        null;
      if (!account) {
        resolve(null);
        return;
      }
      msalInstance.setActiveAccount(account);
      try {
        const result = await msalInstance.acquireTokenSilent({
          ...loginRequest,
          account,
        });
        resolve(result.accessToken);
      } catch (e) {
        try {
          const result = await msalInstance.acquireTokenPopup({
            ...loginRequest,
            account,
          });
          resolve(result.accessToken);
        } catch (e2) {
          console.error("Token acquisition failed:", e2 && e2.message);
          resolve(null);
        }
      }
    });
  });
};
