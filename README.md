# Career Attack

Match Attack–style cards for LinkedIn career profiles. Screenshot a profile, the AI reads it, scores it across six stats, and writes a scouting report.

Built by Jammal & Claude.

---

## What changed from the Claude artifact version

Two things only worked inside Claude's artifact sandbox and have been swapped for real-world equivalents:

1. **Storage** — `window.storage` is replaced with `localStorage` (a small shim at the top of `src/App.jsx`). Cards now persist per-browser.
2. **The AI call** — instead of calling the Anthropic API directly from the browser (which would expose your key), the app calls `/api/anthropic`, a serverless function in `api/anthropic.js` that holds the key server-side and forwards the request.

Everything else is unchanged.

---

## Run it locally

You need [Node.js](https://nodejs.org) 18+ installed.

```bash
# 1. Install dependencies
npm install

# 2. Add your Anthropic API key
cp .env.example .env
#    then open .env and paste your real key

# 3. Run the dev server (a built-in proxy serves /api/anthropic locally)
npm run dev
```

`npm run dev` includes a dev proxy (see `vite.config.js`) that serves `/api/anthropic` locally and reads `ANTHROPIC_API_KEY` from `.env` — no Vercel CLI needed for local development. Restart the dev server after editing `.env`.

> `vercel dev` still works too and exercises the real serverless function in `api/anthropic.js` — useful before deploying.

---

## Run it as a claude.ai artifact (no API key)

`src/App.jsx` is dual-mode: it detects where it's running. As an artifact it uses the
sandbox's `window.storage` for persistence and calls the Anthropic API directly —
the artifact environment injects auth, so usage comes from your Claude subscription
and **no API key is needed**.

1. Open [claude.ai](https://claude.ai), start a new chat, and attach `src/App.jsx`.
2. Ask: *"Render this exact code as a React artifact. Don't change anything."*
3. Use the app in the artifact panel; publish/share the artifact link if you want
   friends to use it (their usage bills to their own Claude accounts).

Artifact-mode limitations: the share card's PNG download falls back to a
"take a screenshot" hint (no npm imports in the sandbox), and cards persist in the
artifact's storage rather than your browser.

---

## Deploy to Vercel

```bash
# 1. Push this folder to a GitHub repo
git init
git add .
git commit -m "Career Attack"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/career-attack.git
git push -u origin main
```

Then:

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import your repo.
2. Vercel auto-detects Vite — leave the build settings as default.
3. Before deploying, go to **Settings → Environment Variables** and add:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** your real Anthropic key
4. Deploy. The `/api/anthropic` function is picked up automatically from the `api/` folder.

That's it — you'll get a live URL.

---

## Notes

- **Model name:** the app uses `claude-sonnet-5` (set in `src/App.jsx`, two places). The previous `claude-sonnet-4-20250514` was retired in June 2026. If Anthropic returns a model error, update the string to a current model ID from the [Anthropic docs](https://docs.claude.com).
- **Image size:** the serverless proxy allows bodies up to 10MB. Very large screenshots may exceed this on Vercel's Hobby tier (4.5MB hard limit on the platform). If big screenshots fail, downscale them or split into smaller crops.
- **Where data lives:** cards are stored in the browser's `localStorage`, so they're per-device and not shared between users. When you're ready for a shared leaderboard, swap the `storage` shim in `src/App.jsx` for a real database (e.g. Vercel KV, Supabase, or Postgres).
- **Cost:** every analysis makes two API calls (extract + score). Keep an eye on your Anthropic usage.

---

## Project structure

```
career-attack/
├── api/
│   └── anthropic.js     serverless proxy (holds the API key)
├── src/
│   ├── App.jsx          the whole app
│   └── main.jsx         React entry point
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── .env.example
└── .gitignore
```
