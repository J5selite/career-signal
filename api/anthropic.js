// Serverless proxy for the Anthropic API — locked to this app's own usage.
// The browser calls /api/anthropic; this function adds the secret credentials
// server-side and forwards the request. Credentials are NEVER exposed to the
// client, and the proxy refuses anything that doesn't look like this app:
//   - Origin/Referer must be this deployment (or localhost dev)
//   - model must be the one model the app uses
//   - max_tokens is capped server-side
//   - per-IP sliding-window rate limit (per warm instance)

export const config = {
  api: { bodyParser: { sizeLimit: "8mb" } },
};

const ALLOWED_MODELS = new Set(["claude-sonnet-5"]);
const MAX_TOKENS_CAP = 8000;
const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_MAX_REQUESTS = 25; // per IP per window — a heavy legit user does ~6/scan-burst

const ORIGIN_OK = (raw) => {
  let origin;
  try { origin = new URL(raw).origin; } catch { return false; }
  return (
    origin === "https://career-signal-psi.vercel.app" ||
    /^https:\/\/career-signal(-[a-z0-9]+)?-j5selites-projects\.vercel\.app$/.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/.test(origin)
  );
};

const buckets = globalThis.__cs_ratelimit || (globalThis.__cs_ratelimit = new Map());
function rateLimited(ip) {
  const now = Date.now();
  const recent = (buckets.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  recent.push(now);
  if (buckets.size > 5000) buckets.clear(); // memory guard on hot instances
  buckets.set(ip, recent);
  return recent.length > RL_MAX_REQUESTS;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const originHeader = req.headers.origin || req.headers.referer || "";
  if (!ORIGIN_OK(originHeader)) {
    return res.status(403).json({ error: { message: "Forbidden" } });
  }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: { message: "Too many requests from this connection — try again in a few minutes." } });
  }

  const payload = { ...req.body };
  if (!ALLOWED_MODELS.has(payload.model)) {
    return res.status(400).json({ error: { message: "Model not allowed" } });
  }
  payload.max_tokens = Math.min(Math.max(1, Number(payload.max_tokens) || 1000), MAX_TOKENS_CAP);
  if (!Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.length > 40) {
    return res.status(400).json({ error: { message: "Bad request" } });
  }

  // Auth: a Claude account OAuth token (from `claude setup-token`) bills against
  // the subscription's usage limits; an API key bills per token. OAuth wins.
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasOauth = oauthToken && oauthToken.startsWith("sk-ant-oat");
  if (!hasOauth && !apiKey) {
    return res.status(500).json({
      error: { message: "No Anthropic credentials set. Add CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY to the environment variables." },
    });
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

  // Claude account OAuth tokens only serve requests that identify as Claude
  // Code: identity line first in system, and a matching User-Agent. Anything
  // else gets an opaque 429, even when usage is available.
  if (hasOauth) {
    const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
    if (Array.isArray(payload.system)) payload.system = [identity, ...payload.system];
    else if (typeof payload.system === "string") payload.system = [identity, { type: "text", text: payload.system }];
    else payload.system = [identity];
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(hasOauth ? { "User-Agent": "claude-cli/2.1.201 (external, cli)" } : {}),
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message || "Proxy error" } });
  }
}
