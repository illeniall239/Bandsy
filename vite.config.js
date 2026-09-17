import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3001", "/content": "http://localhost:3001", "/audio": "http://localhost:3001" } },
});
