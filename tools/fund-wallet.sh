#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") <mnemonic-or-hex-seed> [<mnemonic-or-hex-seed> ...]
      Fund one or more wallets on the local undeployed devnet with 50,000 NIGHT
      each from the genesis wallet, and register each one's NIGHT for DUST
      generation so it can pay fees.

Options:
  -h, --help    Show this help message

Environment:
  INTEGRATION_NODE_WS_ENDPOINT, INTEGRATION_INDEXER_ENDPOINT,
  INTEGRATION_INDEXER_WS_ENDPOINT, INTEGRATION_PROOF_SERVER
      Override the devnet endpoints (default: the local compose stack).
  FUND_NIGHT_AMOUNT
      NIGHT to send each wallet (default 50000).

Prerequisites:
  The undeployed stack must already be running:
    docker compose -f tools/compose-undeployed.yml up -d
  and dependencies installed (npm install).
EOF
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "$SCRIPT_DIR/.."
exec npx tsx tools/fund-wallet.ts "$@"
