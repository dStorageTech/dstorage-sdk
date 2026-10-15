#!/bin/bash
# dStorage SDK — Setup Script
# Run this once to install all dependencies and start the demo app.

set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   dStorage SDK — Demo Setup          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Node version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  echo "❌ Node.js 22+ required. Install from https://nodejs.org"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Install dependencies from root (hoisted workspace install)
echo ""
echo "→ Installing dependencies..."
npm install

echo ""
echo "✓ All dependencies installed."
echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Starting demo app...               ║"
echo "║   Open: http://localhost:5173        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Start the Vite dev server
npm run demo:run
