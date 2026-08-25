#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLD_REPO="https://github.com/midnightntwrk/midnight-local-dev.git"
MLD_COMMIT="8b44aabc5ea65e4c5d4cd855017517600bc90e8a"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") <mnemonic> [<mnemonic> ...]
      Fund one or more BIP-39 mnemonics with 50,000 NIGHT each and register
      each for DUST generation. NIGHT and DUST always happen together --
      the official tooling's non-interactive mode has no NIGHT-only option.

Options:
  -h, --help    Show this help message

Environment:
  MIDNIGHT_LOCAL_DEV_DIR   Path to an existing midnight-local-dev checkout.
                           When unset the repo is cloned automatically into
                           tools/midnight-local-dev on first run.

Prerequisites:
  The undeployed stack must already be running, with container names
  midnight-node / midnight-indexer / midnight-proof-server (the tool
  detects and reuses an already-running stack by those names -- otherwise
  it starts its own, which would port-collide with this one):
    docker compose -f tools/compose-undeployed.yml up -d
EOF
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# Resolve the midnight-local-dev directory.
# If MIDNIGHT_LOCAL_DEV_DIR is set, use it directly.
# Otherwise clone the repo into tools/midnight-local-dev on first run.
if [[ -n "${MIDNIGHT_LOCAL_DEV_DIR:-}" ]]; then
  MLD_DIR="$MIDNIGHT_LOCAL_DEV_DIR"
  if [[ ! -d "$MLD_DIR" ]]; then
    echo "Error: MIDNIGHT_LOCAL_DEV_DIR does not exist: $MLD_DIR"
    exit 1
  fi
else
  MLD_DIR="$SCRIPT_DIR/midnight-local-dev"
  if [[ ! -d "$MLD_DIR" ]]; then
    echo "midnight-local-dev not found — cloning into $MLD_DIR ..."
    # This is midnightntwrk's own official local-network tool (replaces the
    # third-party bricktowers/midnight-local-network this repo used before).
    # It has no tags yet -- pin to a specific commit for reproducibility
    # instead of tracking main.
    git clone "$MLD_REPO" "$MLD_DIR"
    (cd "$MLD_DIR" && git checkout "$MLD_COMMIT")
    echo "Installing dependencies..."
    (cd "$MLD_DIR" && npm install)
  fi
fi

# node_modules can go missing even when the checkout is present (e.g. a
# workspace-wide clean sweep, or manual pruning) -- reinstall rather than
# fail with a confusing ERR_MODULE_NOT_FOUND deep inside the tool.
if [[ ! -d "$MLD_DIR/node_modules" ]]; then
  echo "node_modules missing in $MLD_DIR — reinstalling dependencies..."
  (cd "$MLD_DIR" && npm install)
fi

# Build a temporary accounts.json from the given mnemonics -- the tool's
# non-interactive mode (--fund-config) always funds NIGHT + registers DUST
# for every account listed in the file. The config path must resolve inside
# the tool's own working directory (it rejects paths outside process.cwd()),
# so the temp file is created inside $MLD_DIR rather than under /tmp.
ACCOUNTS_FILE="$(mktemp -p "$MLD_DIR" --suffix=.json)"
trap 'rm -f "$ACCOUNTS_FILE"' EXIT

node -e '
const mnemonics = process.argv.slice(1);
const accounts = mnemonics.map((mnemonic, i) => ({ name: `acct${i}`, mnemonic }));
process.stdout.write(JSON.stringify({ accounts }));
' "$@" >"$ACCOUNTS_FILE"

cd "$MLD_DIR"
node --experimental-specifier-resolution=node --loader ts-node/esm src/index.ts --fund-config "$ACCOUNTS_FILE"
