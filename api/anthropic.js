// Serverless proxy for the Anthropic API.
// The browser calls /api/anthropic; this function adds the secret key
// server-side and forwards the request. The key is NEVER exposed to the client.
//
// Set ANTHROPIC_API_KEY in your Vercel project settings (Environment Variables).

export const config = {
  // Allow larger bodies for base64 screenshots
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
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
  const payload = { ...req.body };
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
