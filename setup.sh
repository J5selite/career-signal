#!/usr/bin/env bash
# Quick local setup. Run:  bash setup.sh
set -e

echo "→ Installing dependencies..."
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠  Created .env — open it and paste your real ANTHROPIC_API_KEY before running."
  echo ""
fi

echo "→ Done. Next steps:"
echo "   1. Make sure your key is in .env"
echo "   2. Install the Vercel CLI if you haven't:  npm i -g vercel"
echo "   3. Run the full app (frontend + API):       vercel dev"
echo ""
echo "   (Plain 'npm run dev' serves the UI but the AI calls will 404 —"
echo "    you need 'vercel dev' so the /api function runs too.)"
