import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only stand-in for api/anthropic.js so plain `npm run dev` works without
// the Vercel CLI. Same contract as the serverless function: the key stays
// server-side and the browser only ever talks to /api/anthropic.
function anthropicDevProxy(env) {
  return {
    name: "anthropic-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/anthropic", (req, res) => {
        const send = (status, obj) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return send(405, { error: { message: "Method not allowed" } });
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey || apiKey.includes("xxxx")) {
          return send(500, { error: { message: "ANTHROPIC_API_KEY is not set. Paste your real key into the .env file in the project root, then restart the dev server." } });
        }
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", async () => {
          try {
            const upstream = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body,
            });
            const text = await upstream.text();
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", "application/json");
            res.end(text);
          } catch (err) {
            send(500, { error: { message: err.message || "Proxy error" } });
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), anthropicDevProxy(env)],
    server: {
      port: 5173,
    },
  };
});
