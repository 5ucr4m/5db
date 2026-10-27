#!/bin/sh
# Generates the throwaway keypair the test bastion trusts. Kept out of git so
# the repository never ships a private key; regenerated on demand.
set -e
cd "$(dirname "$0")/../docker/ssh"
[ -f test_ed25519 ] && exit 0
ssh-keygen -t ed25519 -N "" -C "5db test bastion" -f test_ed25519 -q
chmod 600 test_ed25519
echo "generated docker/ssh/test_ed25519 (test only)"
