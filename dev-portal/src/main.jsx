import React from "react";
import { createRoot } from "react-dom/client";
import { initializeAuth } from "./auth.js";
import { ChatWorkspace } from "./workspace.jsx";
import "../css/style.css";

const root = createRoot(document.getElementById("chat-root"));

window.initChat = (account) => {
  root.render(account ? <ChatWorkspace account={account} /> : null);
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("dev-agent:theme", theme);
  const toggle = document.getElementById("themeToggle");
  toggle.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  toggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  document.querySelector('meta[name="theme-color"]').content =
    theme === "dark" ? "#09090d" : "#f5f3f8";
}

const savedTheme = localStorage.getItem("dev-agent:theme");
const initialTheme =
  savedTheme || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
applyTheme(initialTheme);

document.getElementById("themeToggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

initializeAuth((account) => window.initChat(account)).catch((error) => {
  console.error("Portal initialization failed:", error);
  const message = document.getElementById("loginError");
  message.textContent = "The sign-in service could not be initialized. Refresh the page and try again.";
  message.hidden = false;
});
