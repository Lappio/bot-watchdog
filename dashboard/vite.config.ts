import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  base: "/dashboard/",
  build: { outDir: "dist/dashboard", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/hb", "/rerun", "/admin", "/healthz"].map((path) => [
        path,
        "http://127.0.0.1:8787",
      ]),
    ),
  },
});
