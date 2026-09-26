import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT || 5173),
    strictPort: true,
    // Sends /api calls to the Node.js backend, so the browser sees one origin.
    proxy: { "/api": process.env.API_PROXY_TARGET || "http://localhost:4000" },
  },
});
