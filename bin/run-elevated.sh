#!/usr/bin/env bash
#
# Start the analyzer with the privileges smartctl needs.
#
#   ./bin/run-elevated.sh [extra server options]
#
# If a passwordless sudoers rule for smartctl exists (see setup-sudoers.sh) the
# server itself runs as your normal user and only smartctl is elevated. That is
# the safer default, so this script prefers it and falls back to running the
# whole server through sudo.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

SMARTCTL_BIN="${SMARTCTL_BIN:-$(command -v smartctl || echo /usr/sbin/smartctl)}"

if [[ ! -x "$SMARTCTL_BIN" ]]; then
  echo "smartctl not found. Install smartmontools first:" >&2
  echo "  sudo apt install smartmontools     # Debian/Ubuntu" >&2
  echo "  sudo dnf install smartmontools     # Fedora" >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  exec node server/index.js "$@"
fi

# Help / version output never needs device access.
for arg in "$@"; do
  case "$arg" in
    -h|--help) exec node server/index.js "$@" ;;
  esac
done

# Prefer the narrow sudoers rule: server as user, only smartctl elevated.
if sudo -n "$SMARTCTL_BIN" --version >/dev/null 2>&1; then
  echo "Using passwordless sudo for smartctl only."
  exec node server/index.js --sudo "$@"
fi

echo "No passwordless smartctl rule found; re-running the whole server with sudo."
echo "Tip: run 'sudo ./bin/setup-sudoers.sh' once to elevate only smartctl instead."
exec sudo --preserve-env=PATH node server/index.js "$@"
