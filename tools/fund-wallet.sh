#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLN_REPO="https://github.com/bricktowers/midnight-local-network.git"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") <mnemonic|address>
      Fund a wallet with ~31 NIGHT tokens.
      Accepts a BIP-39 mnemonic (derives both shielded and unshielded addresses),
      a shielded address (mn_shield-addr_undeployed…), or
      an unshielded address (mn_addr_undeployed…).

  $(basename "$0") --dust <mnemonic>
      Fund the unshielded address AND register UTXOs for DUST generation.
      Requires a BIP-39 mnemonic (needs private key to sign the registration).

Options:
  -h, --help    Show this help message

Environment:
  MIDNIGHT_LOCAL_NETWORK_DIR   Path to an existing midnight-local-network checkout.
                               When unset the repo is cloned automatically into
                               tools/midnight-local-network on first run.

Prerequisites:
  The undeployed stack must be running:
    docker compose -f tools/compose-undeployed.yml up -d
EOF
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# Resolve the midnight-local-network directory.
# If MIDNIGHT_LOCAL_NETWORK_DIR is set, use it directly.
# Otherwise clone the repo into tools/midnight-local-network on first run.
if [[ -n "${MIDNIGHT_LOCAL_NETWORK_DIR:-}" ]]; then
  MLN_DIR="$MIDNIGHT_LOCAL_NETWORK_DIR"
  if [[ ! -d "$MLN_DIR" ]]; then
    echo "Error: MIDNIGHT_LOCAL_NETWORK_DIR does not exist: $MLN_DIR"
    exit 1
  fi
else
  MLN_DIR="$SCRIPT_DIR/midnight-local-network"
  if [[ ! -d "$MLN_DIR" ]]; then
    echo "midnight-local-network not found — cloning into $MLN_DIR ..."
    # Pinned to the latest tagged release (as of writing, also the tip of
    # main — bricktowers hasn't cut a newer tag) so this clone is
    # reproducible instead of silently tracking whatever main is at clone
    # time. Its bundled Midnight stack (proof-server 8.0.3, indexer 4.0.0,
    # node 0.22.1) trails the official support matrix; bump this ref if
    # bricktowers cuts a newer tag that catches up.
    git clone --branch 4.0.0 "$MLN_REPO" "$MLN_DIR"
    echo "Installing dependencies..."
    # The repo declares packageManager: yarn@x.y.z — use corepack to get the
    # exact version, which respects the yarn.lock and avoids version skew.
    (cd "$MLN_DIR" && corepack yarn install)
  fi
fi

cd "$MLN_DIR"

# Always run via corepack yarn so the version declared in package.json is used.
run_fund()      { exec corepack yarn fund "$@"; }
run_fund_dust() { exec corepack yarn fund-and-register-dust "$@"; }

if [[ "${1:-}" == "--dust" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    echo "Error: --dust requires a BIP-39 mnemonic argument."
    echo
    usage
    exit 1
  fi
  run_fund_dust "$@"
else
  run_fund "$@"
fi
