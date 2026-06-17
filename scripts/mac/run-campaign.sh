#!/usr/bin/env bash
# Phase 1 — account creation (macOS).
# Sequential signups, one Chrome at a time, paced by --per-hour. Keeps the Mac
# awake (caffeinate) and tees output to logs/campaign.log.
#
# Usage:
#   scripts/mac/run-campaign.sh --target 100 --per-hour 5
#   scripts/mac/run-campaign.sh --id <campaignId>          # resume an existing campaign
#
# Run it inside tmux, or background it:
#   nohup scripts/mac/run-campaign.sh --target 100 --per-hour 5 >/dev/null 2>&1 &
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
mkdir -p logs

# Hard gate: never run if the stealth patch is missing.
pnpm verify:patch

echo "[run-campaign] $(date '+%Y-%m-%d %H:%M:%S') starting — args: $* (logs: logs/campaign.log)"
# caffeinate -i: prevent idle sleep while creation runs (screen may still lock).
caffeinate -i pnpm bless campaign run "$@" 2>&1 | tee -a logs/campaign.log
