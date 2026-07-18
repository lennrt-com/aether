#!/usr/bin/env bash
set -euo pipefail

Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99

# Wait briefly for the virtual display
sleep 1

case "${1:-worker}" in
  worker)
    shift || true
    exec pnpm worker "$@"
    ;;
  shell)
    exec bash
    ;;
  *)
    exec "$@"
    ;;
esac
