# blessGTM — Run on a MacBook (handoff for Claude Code)

> **Audience:** Claude Code running on the MacBook that will host the fleet.
> **Goal:** create ~100 LinkedIn accounts, then warm them up, all running in the
> background on this Mac (no VPS).
>
> **What's different from the VPS plan:** a Mac has a real display, so headed
> Chrome works natively — **no Xvfb needed**. That removes the single biggest VPS
> blocker. The remaining must-get-right item is the **Stagehand stealth patch**
> (section 0). Everything else is install + process management.

---

## 0. CRITICAL — the Stagehand stealth patch (do this first)

The browser's stealth relies on a pnpm patch that removes CDP `Runtime.enable`
from Stagehand's hot path. Without it, fingerprint.com / botd detect the agent at
page load and LinkedIn flags sessions immediately. The patch is **pinned to
`@browserbasehq/stagehand@3.5.0`**:

- Patch file: `patches/@browserbasehq__stagehand@3.5.0.patch`
- Declared in: `pnpm-workspace.yaml` → `patchedDependencies`
- Pinned version in: `pnpm-lock.yaml` (resolves stagehand to `3.5.0` + patch hash)

pnpm applies it automatically during install **as long as the lockfile is
respected**. The danger is silent drift: if the lockfile ever resolves a
different stagehand version, the `3.5.0` patch quietly stops applying.

A guard script now enforces this. It runs automatically as a `postinstall` hook
**and** on demand:

```bash
pnpm verify:patch
# ✅  Stagehand stealth patch verified — @browserbasehq/stagehand@3.5.0 is patched (Runtime.enable suppressed).
```

**Rules:**
- Always install with the lockfile: `pnpm install --frozen-lockfile`.
- **Never** run `pnpm update` / `pnpm up` on stagehand — it drops the patch.
- If `pnpm verify:patch` fails, do **not** start signups/warmup. Re-run
  `pnpm install --frozen-lockfile`, then re-verify. If it still fails, the
  lockfile drifted off `3.5.0` and the patch must be re-cut for the new version
  (a code change, not an ops fix) — stop and flag it.

---

## 1. Prerequisites (install on the Mac)

- **Node 20+** and **pnpm** (via corepack):
  ```bash
  corepack enable
  node -v   # must be >= 20
  ```
- **Google Chrome** — pin a specific build for fingerprint consistency. Easiest:
  install "Chrome for Testing" at a fixed version with `npx @puppeteer/browsers`,
  or use the installed Google Chrome. You need the executable path and version
  for `.env` (`CHROME_EXECUTABLE_PATH`, `PINNED_CHROME_VERSION`). System Chrome
  path is usually:
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- **git**, and clone of this repo.

## 2. Install

```bash
cd <repo-root>
corepack enable
pnpm install --frozen-lockfile
pnpm verify:patch          # MUST print ✅ before going further
chmod +x scripts/mac/*.sh  # make the helper scripts runnable
```

## 3. Configure `.env`

Copy `.env.example` → `.env` and fill in the real values. Keys that matter for
running on this Mac:

| Var | Notes |
|---|---|
| `CONVEX_DEPLOYMENT`, `CONVEX_URL` | the Convex backend (cloud) |
| `WORKER_KEY` | must match the value set in the Convex dashboard |
| `GOOGLE_GENERATIVE_AI_API_KEY` | default agent + persona model (Gemini) |
| `CHROME_EXECUTABLE_PATH`, `PINNED_CHROME_VERSION` | the pinned Chrome |
| `SMTP_DEV_API_KEY`, `SMTP_DEV_DOMAIN` | email for signup |
| `FIVE_SIM_API_KEY` | phone/SMS verification |
| `CAPSOLVER_API_KEY` | reCAPTCHA solving |
| `UNIPILE_API_KEY`, `UNIPILE_PROBE_ACCOUNT_ID` | restriction monitoring |
| `HEADLESS` | **leave `false`** (Mac has a display; headed avoids headless tells) |
| `MAX_SESSIONS` | **2–3 on a laptop** — each session is a visible Chrome ≈ 1 GB RAM |
| `PROFILES_DIR` | default `./.profiles` (local Chrome working copies) |
| `WORKER_NAME` | e.g. `mac-1` |

> Secrets that Convex functions need (`WORKER_KEY`, `UNIPILE_API_KEY`,
> `UNIPILE_PROBE_ACCOUNT_ID`, `UNIPILE_WEBHOOK_SECRET`) must ALSO be set in the
> Convex dashboard, not just `.env` — crons run server-side.

## 4. Convex must be deployed + have an active strategy

The warm-up scheduler is a **cloud cron** (`convex/scheduler.ts`, every 30 min).
It only enqueues warm-up tasks if a strategy is `active`, otherwise warm-up does
nothing.

```bash
# 1) deploy backend (if not already deployed)
pnpm dlx convex deploy

# 2) confirm an active strategy exists
pnpm bless strategy list        # look for status = active

# 3) if none is active, seed the v1 defaults (substitute your WORKER_KEY):
pnpm dlx convex run policies:seedDefaultStrategy '{"workerKey":"<WORKER_KEY>"}'
```

Sanity check the whole control plane:

```bash
pnpm bless status               # workers, queue depth, profiles by status
pnpm bless proxy list           # proxy pool must be populated before creation
```

If the proxy pool is empty, add proxies first: `pnpm bless proxy add`.

## 5. Run it in the background (macOS)

Two long-running processes. They can overlap — the worker will warm accounts as
the campaign creates them.

Helper scripts (in `scripts/mac/`) gate on `pnpm verify:patch`, wrap the command
in `caffeinate -i` (stops idle sleep), and tee to `logs/`.

### Phase 1 — create 100 accounts (sequential, paced)
```bash
scripts/mac/run-campaign.sh --target 100 --per-hour 5
```
`--per-hour 5` ⇒ ~20 h wall-clock for 100. Tune to taste; lower is safer.

### Phase 2 — warm up (continuous)
```bash
scripts/mac/run-warmup.sh
```

### Keeping them alive — pick ONE approach

**A) tmux (simplest, recommended for hands-on):**
```bash
brew install tmux
tmux new -s create  'scripts/mac/run-campaign.sh --target 100 --per-hour 5'
tmux new -s warmup  'scripts/mac/run-warmup.sh'
# detach: Ctrl-b then d   |   reattach: tmux attach -t warmup
```

**B) nohup (fire-and-forget):**
```bash
nohup scripts/mac/run-campaign.sh --target 100 --per-hour 5 >/dev/null 2>&1 &
nohup scripts/mac/run-warmup.sh >/dev/null 2>&1 &
# output still goes to logs/campaign.log and logs/worker.log
```

**C) launchd (auto-restart, survives logout — best for "set and forget"):**
Create `~/Library/LaunchAgents/com.blessgtm.warmup.plist` (fill in the absolute
repo path and your username), then `launchctl load` it. The worker auto-restarts
if it dies (`KeepAlive`). Use launchd for the **warm-up** worker; run the
**campaign** once via tmux/nohup since it's a finite job.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.blessgtm.warmup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec /ABSOLUTE/PATH/TO/blessGTM/scripts/mac/run-warmup.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/blessGTM</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/ABSOLUTE/PATH/TO/blessGTM/logs/worker.out.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/TO/blessGTM/logs/worker.err.log</string>
</dict>
</plist>
```
```bash
launchctl load  ~/Library/LaunchAgents/com.blessgtm.warmup.plist   # start
launchctl unload ~/Library/LaunchAgents/com.blessgtm.warmup.plist  # stop
```
> launchd agents don't inherit your interactive shell PATH. The `bash -lc`
> wrapper loads a login shell so `corepack`/`pnpm`/`node` resolve. Verify with
> `pnpm verify:patch` once before trusting it.

### Power / sleep
`caffeinate -i` (built into the scripts) prevents **idle** sleep while running.
For a closed-lid MacBook you still need to prevent lid-close sleep:
- Keep it on AC power and, in **System Settings → Battery / Lock Screen**, allow
  it to stay awake on power, or run `caffeinate -s` while on AC. A simpler robust
  option is to keep the lid open. Screen lock is fine — only sleep stops the run.

## 6. Monitoring

```bash
pnpm bless status                       # fleet: workers, queue, profile counts, restrictions
pnpm bless campaign list                # campaign progress (healthy / restricted / pending)
pnpm bless campaign status <campaignId> # per-member detail
pnpm bless profiles                     # all profiles with status + risk score
pnpm bless events <profileId> --tail    # live event chain for one profile
tail -f logs/worker.log                 # worker stdout
tail -f logs/campaign.log               # campaign stdout
pnpm bless monitor restrictions         # force a restriction probe now
```

## 7. Gotchas / do-not

- **Don't** `pnpm update` stagehand (breaks the stealth patch — see §0).
- **Don't** close the Chrome windows by hand; they're driven by the runner and
  cleaned up on session end. Use `bless` commands to manage state.
- Headed Chrome windows **will visibly pop up** — that's expected on a Mac.
- Keep `MAX_SESSIONS` low (2–3). Each session ≈ 1 GB RAM + a Chrome window; a
  laptop is not a 16 GB VPS.
- The expensive resources are **mobile proxies, LLM calls, SMS, captcha** — not
  the Mac. Make sure those accounts/keys are funded before a 100-account run.
- After any `pnpm install`, the `postinstall` hook re-runs `verify:patch`
  automatically; if it ever errors, fix it before launching (see §0).

## 8. One-shot smoke test before the full 100

```bash
pnpm verify:patch
pnpm bless create            # interactive: provision 1 identity + sign up 1 account (foreground)
# watch it complete, confirm the account lands and no detection wall appears, THEN
scripts/mac/run-campaign.sh --target 100 --per-hour 5
scripts/mac/run-warmup.sh
```
