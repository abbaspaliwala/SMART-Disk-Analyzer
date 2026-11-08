#!/usr/bin/env bash
#
# Optional: allow your user to run smartctl without a password so the analyzer
# can stay unprivileged and only elevate the SMART tool itself.
#
#   sudo ./bin/setup-sudoers.sh
#
# This writes /etc/sudoers.d/smart-analyzer allowing NOPASSWD for smartctl and
# nothing else. Undo with:  sudo rm /etc/sudoers.d/smart-analyzer

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo:  sudo ./bin/setup-sudoers.sh" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-${1:-}}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "Could not determine the unprivileged user. Pass it explicitly:" >&2
  echo "  sudo ./bin/setup-sudoers.sh <username>" >&2
  exit 1
fi

SMARTCTL_BIN="$(command -v smartctl || echo /usr/sbin/smartctl)"
if [[ ! -x "$SMARTCTL_BIN" ]]; then
  echo "smartctl not found - install smartmontools first." >&2
  exit 1
fi

RULE_FILE=/etc/sudoers.d/smart-analyzer
cat > "$RULE_FILE" <<EOF
# Installed by SMART Disk Analyzer - allows $TARGET_USER to read SMART data
# only, without a password. Remove this file to revoke the permission.
$TARGET_USER ALL=(root) NOPASSWD: $SMARTCTL_BIN
EOF
chmod 0440 "$RULE_FILE"

if visudo -cf "$RULE_FILE" >/dev/null 2>&1; then
  echo "Installed $RULE_FILE"
  echo "$TARGET_USER may now run: $SMARTCTL_BIN (no password)"
  echo "Start the app with:  npm run elevated"
else
  echo "Generated rule failed validation - removing it again." >&2
  rm -f "$RULE_FILE"
  exit 1
fi
