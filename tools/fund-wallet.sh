#!/usr/bin/env bash
set -euo pipefail

# Resolve the midnight-local-network directory.
# Default: sibling directory of dstorage-sdk. Override via env var.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MLN_DIR="${MIDNIGHT_LOCAL_NETWORK_DIR:-"$SCRIPT_DIR/../../midnight-local-network"}"

if [[ ! -d "$MLN_DIR" ]]; then
  echo "Error: midnight-local-network not found at: $MLN_DIR"
  echo "Set MIDNIGHT_LOCAL_NETWORK_DIR to its path and retry."
  exit 1
fi

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
  MIDNIGHT_LOCAL_NETWORK_DIR   Path to the midnight-local-network repo
                               (default: sibling directory ../midnight-local-network)

Prerequisites:
  The undeployed stack must be running:
    docker compose -f tools/compose-undeployed.yml up -d
EOF
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "$MLN_DIR"

if [[ "${1:-}" == "--dust" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    echo "Error: --dust requires a BIP-39 mnemonic argument."
    echo
    usage
    exit 1
  fi
  exec yarn fund-and-register-dust "$@"
else
  exec yarn fund "$@"
fi
