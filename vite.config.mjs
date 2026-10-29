import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dev-portal",
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@assistant-ui/")) return "assistant-ui";
          if (id.includes("/node_modules/@azure/msal-browser/")) return "msal";
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "react-vendor";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
