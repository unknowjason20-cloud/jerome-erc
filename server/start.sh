#!/usr/bin/env bash
# Start the Flow server (Codespace). Stdlib only — no pip installs.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v gflow >/dev/null 2>&1; then
  echo "ERROR: 'gflow' not found on PATH." >&2
  echo "In the Codespace, install the repo first: pip install --user -e ." >&2
  echo "(run from the repo root, ~/workspace/jerome-erc or the cloned repo)." >&2
  exit 1
fi

if [ -z "${DISPLAY:-}" ]; then
  echo "WARNING: DISPLAY is unset — headed Chrome needs a display." >&2
  echo "The .devcontainer sets DISPLAY=:1; if generations fail, check it." >&2
fi

exec python3 server.py
