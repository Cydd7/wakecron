#!/bin/bash
# Morning routine. Schedule it once:  ./wakecron add morning.sh 07:00
# Each `step` line runs one task, in order. A failed step doesn't stop the next one; if any step
# failed, the routine exits 1 and wakecron shows a notification.
# To add a task: put its script in scripts/morning/ and add a step line above `exit`.

cd "$(dirname "$0")" || exit 1
failed=0

step() {
  local name=$1
  shift
  echo "--- $(date +%H:%M:%S) $name"
  "$@"
  local code=$?
  if [ "$code" -eq 0 ]; then
    echo "--- $(date +%H:%M:%S) $name: ok"
  else
    echo "--- $(date +%H:%M:%S) $name: FAILED (exit $code)"
    failed=1
  fi
}

step "Back up Shortcuts" node morning/backup-shortcuts.js --to "$HOME/Documents/Backups/Shortcuts"

exit "$failed"
