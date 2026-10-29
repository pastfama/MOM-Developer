// ── MSAL auth ──
let msalInstance = null;
let currentAccount = null;
let msalReady = false;
const msalReadyCallbacks = [];
let msalLoadError = null;

function log(...args) {
  console.log("[DevAgent Auth]", ...args);
}

function onMSALReady(fn) {
  if (msalReady) {
    fn();
  } else if (msalLoadError) {
    console.error("[DevAgent Auth] MSAL failed to load:", msalLoadError);
  } else {
    msalReadyCallbacks.push(fn);
  }
}

function initMSAL() {
  if (typeof window === "undefined" || typeof window.Msal === "undefined") {
    setTimeout(initMSAL, 100);
    return;
  }
  if (typeof msalConfig === "undefined") {
    setTimeout(initMSAL, 100);
    return;
  }
  try {
    const ClientClass = window.Msal.ClientApplication || window.Msal.PublicClientApplication;
    if (!ClientClass) {
      throw new Error("Neither ClientApplication nor PublicClientApplication found on window.Msal");
    }
    msalInstance = new ClientClass(msalConfig);
    msalReady = true;
    log("MSAL initialized successfully");
    msalReadyCallbacks.forEach((fn) => fn());
  } catch (e) {
    msalLoadError = e;
    console.error("[DevAgent Auth] Failed to initialize MSAL:", e);
  }
}

initMSAL();

// Timeout: if MSAL hasn't loaded in 10 seconds, report it
setTimeout(() => {
  if (!msalReady && !msalLoadError) {
    msalLoadError = new Error("MSAL library timed out loading (10s)");
    console.error("[DevAgent Auth]", msalLoadError);
  }
}, 10000);

function updateUI(account) {
  currentAccount = account;
  const userBox = document.getElementById("userBox");
  const landing = document.getElementById("landing");
  const chat = document.getElementById("chat");
  const userName = document.getElementById("userName");
  const sessionInfo = document.getElementById("sessionInfo");

  if (!userBox || !landing || !chat) {
    return;
  }

  if (account) {
    msalInstance.setActiveAccount(account);
    userBox.style.display = "flex";
    userName.textContent = account.name || account.username || "Signed in";
    landing.style.display = "none";
    chat.style.display = "flex";
    sessionInfo.textContent = "Signed in";
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.onclick = logout;
    if (typeof initChat === "function") initChat(account);
  } else {
    userBox.style.display = "none";
    landing.style.display = "block";
    chat.style.display = "none";
    sessionInfo.textContent = "No session";
  }
}

async function login() {
  log("Login button clicked");
  onMSALReady(async () => {
    try {
      log("Attempting loginPopup...");
      const response = await msalInstance.loginPopup(loginRequest);
      updateUI(msalInstance.getActiveAccount() || response.account);
    } catch (err) {
      log("Login popup failed:", err.message, "- falling back to redirect");
      msalInstance.loginRedirect(loginRequest);
    }
  });
}

async function logout() {
  onMSALReady(async () => {
    try {
      await msalInstance.logoutPopup();
    } catch (e) {
      console.warn("[DevAgent Auth] Logout popup failed:", e && e.message);
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
      log("Redirect promise resolved");
      if (tokenResponse && tokenResponse.account) {
        msalInstance.setActiveAccount(tokenResponse.account);
        updateUI(tokenResponse.account);
        return;
      }
      const accounts = msalInstance.getAllAccounts();
      updateUI(accounts.length ? accounts[0] : null);
    })
    .catch((err) => {
      console.error("[DevAgent Auth] Redirect response error:", err);
      const accounts = msalInstance.getAllAccounts();
      updateUI(accounts.length ? accounts[0] : null);
    });
});

const loginBtn = document.getElementById("loginBtn");
if (loginBtn) {
  loginBtn.addEventListener("click", (e) => {
    log("loginBtn click event fired");
    e.preventDefault();
    login();
  });
} else {
  log("WARNING: loginBtn element not found!");
}

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
          console.error("[DevAgent Auth] Token acquisition failed:", e2 && e2.message);
          resolve(null);
        }
      }
    });
  });
};
