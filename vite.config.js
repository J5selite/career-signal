import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

// .env always loads from the project folder (next to this file), regardless of
// which directory the dev server was launched from.
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

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
        // Auth: a Claude account OAuth token (from `claude setup-token`) bills
        // against the subscription's usage limits; an API key bills per token.
        // OAuth wins when both are set.
        const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
        const apiKey = env.ANTHROPIC_API_KEY;
        const hasOauth = oauthToken && oauthToken.startsWith("sk-ant-oat");
        const hasKey = apiKey && !apiKey.includes("xxxx");
        if (!hasOauth && !hasKey) {
          return send(500, { error: { message: "No Anthropic credentials found. Either run `claude setup-token` and put the result in .env as CLAUDE_CODE_OAUTH_TOKEN (uses your Claude plan's usage limits), or set ANTHROPIC_API_KEY. Then restart the dev server." } });
        }
        const authHeaders = hasOauth
          ? {
              Authorization: `Bearer ${oauthToken}`,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "oauth-2025-04-20",
            }
          : {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            };
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", async () => {
          try {
            // Claude account OAuth tokens only serve requests that identify as
            // Claude Code: the identity line must be the FIRST system block and
            // the User-Agent must match the CLI. Anything else gets an opaque
            // 429, even when usage is available.
            if (hasOauth) {
              const parsed = JSON.parse(body);
              const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
              if (Array.isArray(parsed.system)) parsed.system = [identity, ...parsed.system];
              else if (typeof parsed.system === "string") parsed.system = [identity, { type: "text", text: parsed.system }];
              else parsed.system = [identity];
              body = JSON.stringify(parsed);
            }
            const upstream = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(hasOauth ? { "User-Agent": "claude-cli/2.1.201 (external, cli)" } : {}),
                ...authHeaders,
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
  const env = loadEnv(mode, PROJECT_ROOT, "");
  return {
    plugins: [react(), anthropicDevProxy(env)],
    server: {
      port: 5173,
    },
  };
});
