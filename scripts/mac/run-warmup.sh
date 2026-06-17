#!/usr/bin/env bash
# Phase 2 — warm-up worker (macOS).
# Polls Convex for scheduled warmup_feed / engage_post / login / api tasks and
# runs up to MAX_SESSIONS Chrome sessions at once. Keeps the Mac awake
# (caffeinate) and tees output to logs/worker.log.
#
# The Convex scheduler cron (cloud-side) decides WHAT to warm and WHEN, honoring
# persona active hours + budgets. This process just executes claimed tasks, so
# leave it running continuously.
#
# Usage:
#   scripts/mac/run-warmup.sh
#
# Run it inside tmux, or background it:
#   nohup scripts/mac/run-warmup.sh >/dev/null 2>&1 &
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
mkdir -p logs

# Hard gate: never run if the stealth patch is missing.
pnpm verify:patch

echo "[run-warmup] $(date '+%Y-%m-%d %H:%M:%S') starting worker (MAX_SESSIONS=${MAX_SESSIONS:-2}, logs: logs/worker.log)"
# caffeinate -i: prevent idle sleep while the worker runs (screen may still lock).
caffeinate -i pnpm bless worker 2>&1 | tee -a logs/worker.log
