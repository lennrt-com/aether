# blessGTM — Execution Plan

> Companion to `architecture.md`. That document says **what** we're building and why; this one says **in which order, in which files, with which exact decisions already made**.
>
> This plan is written to be executed by a coding model (e.g. Composer) phase by phase. Decisions are pre-made and pinned. The builder's job is transcription and wiring, not design.

---

## How to use this plan with a coding model

1. **One phase per session.** Start a fresh chat per phase. Paste the *Global Rules* section + the single phase you want built. Never give it the whole plan.
2. **Verify the Definition of Done (DoD) before moving on.** Every phase has a verification script or manual check. Do not start phase N+1 until phase N's DoD passes.
3. **Commit per phase.** One commit (or small series) per phase, message `phase N: <name>`.
4. **The builder must not touch files outside the phase's file list.** If it claims it needs to, stop and check this plan — the answer is usually "no, that belongs to a later phase."
5. **If the builder proposes an alternative approach — reject it.** All trade-offs were already evaluated in `architecture.md`. Deviations need to come back to a design conversation, not be decided mid-build.

---

## Global Rules (paste into every builder session)

```
RULES — read before writing any code:

- Package manager: pnpm (pnpm dlx instead of npx). Node >= 20, TypeScript strict, ESM ("type": "module").
- Validation: zod where Convex validators don't apply. Inside Convex functions use `v` from "convex/values".
- Convex: use the modern function syntax — query({ args, handler }), mutation({ args, handler }),
  internalMutation/internalQuery/internalAction where specified. Crons go in convex/crons.ts.
- Every event written to the `events` table goes through ONE helper (convex/events.ts:append /
  src/runner/emit.ts). NEVER insert into `events` directly anywhere else.
- Worker-facing Convex functions take a `workerKey: v.string()` arg, checked against the
  WORKER_KEY environment variable (set in the Convex dashboard). Throw on mismatch.
- Do NOT add dependencies beyond the ones pinned in the plan for the current phase.
- Do NOT modify convex/schema.ts except in the phase that explicitly owns the change.
- Do NOT build any UI/dashboard. Do NOT implement fingerprint spoofing. Do NOT write
  LinkedIn-specific CSS selectors — browser interaction goes through Stagehand act/observe/extract
  with natural-language instructions only.
- Secrets only via environment variables (.env locally, Convex env vars for Convex functions).
  Never hardcode, never commit .env.
- No try/catch that swallows errors silently. Errors either fail the task (recorded via events)
  or propagate.
- Keep comments minimal; do not narrate code.
```

---

## Target repository layout (end state)

```
convex/
  schema.ts            # Appendix A — owned by Phase 1 (extended only where a phase says so)
  events.ts            # append + queries
  profiles.ts          # CRUD + state transitions
  tasks.ts             # enqueue / claim / heartbeat / complete / fail
  workers.ts           # register / heartbeat
  snapshots.ts         # profile snapshot pointers + upload URLs
  personas.ts
  launchConfigs.ts
  proxies.ts
  health.ts            # risk score + health transitions
  policies.ts          # strategyVersions
  incidents.ts         # dossier builder
  scheduler.ts         # persona-driven task generation
  http.ts              # Unipile webhook endpoint
  crons.ts
  lib/guards.ts        # transition map, worker auth check
src/
  shared/types.ts      # enums + event envelope types (mirror of schema unions)
  shared/constants.ts  # risk weights, prune lists, etc.
  worker/main.ts       # worker loop: claim → spawn runner → report
  runner/main.ts       # subprocess entry (one session per process, TZ set here)
  runner/session.ts    # Stagehand lifecycle
  runner/classify.ts   # page classification
  runner/emit.ts       # event emission helper (only path to events from runner)
  runner/proxy.ts      # moved from src/proxy.ts (exists today)
  profile-store/blobStore.ts        # interface
  profile-store/convexBlobStore.ts  # Convex file storage impl
  profile-store/snapshot.ts         # prune + tar + upload + commit
  profile-store/hydrate.ts          # marker check + download + extract
  identity/personaGen.ts
  identity/launchConfigGen.ts
  memory/hindsight.ts  # bank-per-profile client
  channels/unipile.ts
  channels/router.ts
scripts/
  verify-phase1.ts ... verify-phaseN.ts
  provision-profile.ts
architecture.md
executionplan.md
```

`src/index.ts` (current prototype) is retired in Phase 3. `src/proxy.ts` moves to `src/runner/proxy.ts` unchanged.

## Pinned dependencies (install only in the phase that introduces them)

| Dependency | Phase | Purpose |
|---|---|---|
| `convex` | 0 | client + backend |
| `tar` (v7+) | 4 | profile archives (built-in gzip; **zstd is explicitly out of scope for v1**) |
| `undici` | 3 | `ProxyAgent` for the egress-IP check through the session proxy |
| `unipile-node-sdk` | 8 | official API channel |
| `ai` + `@ai-sdk/google` | 5 | persona generation (structured output) |

Already present: `@browserbasehq/stagehand`, `proxy-chain`, `zod`, `dotenv`, `tsx`, `typescript`.

---

# Phases

Dependency chain: `0 → 1 → 2 → 3 → 4 → (5, 6 in either order) → 7 → 8 → 9 → 10`.
Phases 5 and 6 are independent of each other. Nothing else may be reordered.

---

## Phase 0 — Scaffold & Convex project

**Objective:** Convex wired into the repo; folder skeleton; shared types file.

**Tasks**
1. `pnpm add convex` and initialize (`pnpm dlx convex dev` once, creates `convex/` and env entries).
2. Create the folder skeleton above (empty files OK), `src/shared/types.ts` + `src/shared/constants.ts` with the enums from Appendix B/C.
3. Update `.env.example`: `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `WORKER_KEY`, keep existing proxy/model vars.
4. Set `WORKER_KEY` as a Convex environment variable (dashboard) and locally.

**DoD:** `pnpm dlx convex dev` runs without errors; `scripts/verify-phase0.ts` connects with `ConvexHttpClient` and calls a trivial `ping` query.

---

## Phase 1 — Schema + event log + profile state machine

**Objective:** The single source of truth exists: full schema, the only event-append path, guarded profile state transitions.

**Tasks**
1. `convex/schema.ts` — transcribe **Appendix A exactly**. Do not rename fields, do not add tables.
2. `convex/lib/guards.ts` — `assertWorkerKey(ctx-arg, key)` and the `ALLOWED_TRANSITIONS` map from Appendix C, with `assertTransition(from, to)`.
3. `convex/events.ts` — `append` mutation (workerKey-guarded): validates the envelope (Appendix B), inserts, returns id. Plus queries: `forProfile(profileId, sinceTs)`, `forSession(sessionId)`.
4. `convex/profiles.ts` — `create` (status `provisioning`, riskScore 0), `get`, `list`, `transition` mutation that uses `assertTransition` and **also appends a `ProfileStateChanged` event in the same mutation** (this is the pattern: state changes and their events are atomic, same mutation).

**Pinned decisions**
- Events are immutable. No update/delete functions for `events`. Do not create any.
- `transition` is the ONLY way to change `profiles.status`.

**DoD:** `scripts/verify-phase1.ts`: creates a profile → transitions `provisioning→warming` → appends 3 events → reads them back via `forProfile` → attempts an illegal transition (`warming→recovering`) and asserts it throws.

---

## Phase 2 — Task queue + worker coordination

**Objective:** Lease-based task claiming with single-session-per-profile, safe under concurrency.

**Tasks**
1. `convex/workers.ts` — `register(name)`, `heartbeat(workerId)`; stale = no heartbeat for 120s.
2. `convex/tasks.ts` (all workerKey-guarded where worker-called):
   - `enqueue({ profileId, type, payload, dueAt, priority })`
   - `claimNext({ workerId })` — single mutation that: finds oldest `pending` task with `dueAt <= now`, whose profile has `activeSessionId == null` AND status in `["warming","active","cooldown"]`; sets task `claimed`, `claimedBy`, `leaseExpiresAt = now + 10min`; creates a `sessions` row (status `running`); sets `profiles.activeSessionId`; appends `SessionStarted` event. Returns the full identity bundle: task + profile + persona + launchConfig + proxyBinding + currentSnapshot metadata. Returns `null` if nothing claimable.
   - `heartbeatTask({ taskId })` — extends lease 10min.
   - `complete({ taskId, outcome })` / `fail({ taskId, error })` — close task + session, clear `activeSessionId`, append `SessionEnded`. `fail` increments `attempts`; re-queue as `pending` with `dueAt = now + 30min * attempts` if `attempts < 3`, else mark `failed`.
3. `convex/crons.ts` — every minute: `reclaimExpiredLeases` (lease past due → treat as `fail` with error `"lease expired"`).

**Pinned decisions**
- Convex mutations are serializable — `claimNext` being one mutation IS the concurrency control. No extra locks, no optimistic-retry code.
- Lease = 10 min. Heartbeat every 2 min from worker. Max 3 attempts. Don't make these configurable yet.

**DoD:** `scripts/verify-phase2.ts`: enqueues 5 tasks across 2 profiles, runs 10 parallel `claimNext` calls; asserts no task is double-claimed and at most one claimed task per profile; lets a lease expire (use a 5s lease override via env for the test) and asserts reclaim re-queues it.

---

## Phase 3 — Worker + session runner (replace the prototype)

**Objective:** End-to-end loop: worker claims a task → spawns runner subprocess → real Chrome via Stagehand → enveloped events stream to Convex → task completes.

**Tasks**
1. Move `src/proxy.ts` → `src/runner/proxy.ts` (unchanged).
2. `src/runner/emit.ts` — `createEmitter({ convex, profileId, sessionId, taskId, ctx })` returning `emit(type, data, actionId?)`; fills the envelope (Appendix B) on every call. Buffer nothing; one mutation call per event (volume is low).
3. `src/runner/session.ts` — given the identity bundle: resolve proxy (relay), launch Stagehand:
   ```ts
   new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: {
     userDataDir, executablePath, headless: false,
     locale: launchConfig.locale,
     viewport: { width: launchConfig.windowWidth, height: launchConfig.windowHeight },
     proxy: { server: relay.server } } })
   ```
   Before any navigation: egress-IP check — `fetch("https://api.ipify.org?format=json", { dispatcher: new ProxyAgent(relayUrl) })` (undici), write IP onto the session (`sessions.egressIp` via a small mutation) and into the `SessionStarted` ctx.
4. `src/runner/main.ts` — subprocess entry: reads a single JSON arg (bundle + env), runs the task, emits `ActionStarted/Succeeded/Failed` around each agent step, exits 0/1. **`TZ` is NOT set here — it's set by the worker when spawning.**
5. `src/worker/main.ts` — loop: register → poll `claimNext` every 15s (plain polling; no subscriptions in v1) → on claim, `child_process.spawn("node", ["--import","tsx","src/runner/main.ts"], { env: { ...process.env, TZ: launchConfig.timezone } })` → heartbeat task every 2 min while child runs → `complete`/`fail` from exit code. Concurrency: `MAX_SESSIONS` env, default 2.
6. Task types for v1: `browse` (instruction in payload, executed via `stagehand.agent` hybrid mode like the current prototype). Delete `src/index.ts`.

**Pinned decisions**
- One subprocess per session (crash isolation + per-profile TZ). Worker never launches Chrome in-process.
- Polling, not Convex subscriptions, in v1.
- For now `userDataDir` is a plain local dir `./.profiles/<profileId>` (persistence comes in Phase 4) and `executablePath` is unset (system Chrome). Do not implement snapshotting in this phase.

**DoD:** enqueue a `browse` task (`START_URL=https://example.com`, instruction "summarize the page"), run `pnpm worker`, watch it complete; verify in Convex dashboard: session row with egressIp, event chain `SessionStarted → ActionStarted → ... → SessionEnded`, task `done`, `activeSessionId` cleared.

---

## Phase 4 — Chrome profile persistence

**Objective:** Profiles survive restarts and move between machines: hydrate → run → prune → archive → commit pointer.

**Tasks**
1. `src/profile-store/blobStore.ts` — interface: `put(data: ReadableStream|Buffer): Promise<{ ref: string }>`, `getUrl(ref): Promise<string>`, `del(ref): Promise<void>`.
2. `src/profile-store/convexBlobStore.ts` — impl via Convex file storage: `snapshots.generateUploadUrl` mutation → POST file → `storageId` is the ref; `getUrl` via `snapshots.getDownloadUrl` query.
3. `convex/snapshots.ts` — `generateUploadUrl`, `getDownloadUrl`, `commit({ profileId, sessionId, storageId, contentHash, chromeVersion, sizeBytes })` (inserts `profileSnapshots` row + updates `profiles.currentSnapshotId` atomically), `latestFor(profileId)`, `listFor(profileId)`.
4. `src/profile-store/snapshot.ts` — after Stagehand fully closed: delete prune-list dirs (Appendix C), `tar.create({ gzip: true, cwd: profileDir })` of the remainder, sha256 hash, upload, `commit`. Write `.blessgtm-snapshot` marker file (the hash) into the local dir.
5. `src/profile-store/hydrate.ts` — compare marker file hash to `latestFor().contentHash`; on match reuse local dir; else wipe local dir, download, extract, write marker.
6. Wire both into `src/runner/main.ts` (hydrate before launch, snapshot after close). Emit `FingerprintLoaded` (with launchConfig hash) after hydrate and `SnapshotCommitted` after archive.
7. `convex/crons.ts` — daily retention: per profile keep the 5 newest snapshots + the newest per ISO-week for the last 8 weeks; delete other rows AND their storage objects.
8. Linux launch flag: add `--password-store=basic` to Stagehand `args` (harmless on Windows dev).

**Pinned decisions**
- tar + gzip via the `tar` package. No zstd, no shelling out to system tar.
- Never archive while Chrome runs — snapshot is called only after `stagehand.close()` resolves.
- Prune/keep lists are exactly Appendix C. `Local State` at the root MUST be kept (cookie encryption key).

**DoD:** `scripts/verify-phase4.ts`: run a `browse` task against a page that sets localStorage + a cookie (use `https://example.com` + `page.evaluate` in the script's task payload, or any stable site); snapshot commits; delete `./.profiles/<id>` entirely; run a second task; assert the cookie/localStorage value survived (extract via Stagehand). Check `profileSnapshots` has 2 rows.

---

## Phase 5 — Identity provisioning (personas, launch configs, proxies)

**Objective:** `scripts/provision-profile.ts` creates a complete identity bundle in one run.

**Tasks**
1. `convex/personas.ts`, `convex/launchConfigs.ts`, `convex/proxies.ts` — create/get/list, plus `attachToProfile` mutations that set the FK on `profiles` and append `ProfileProvisioned`-family events.
2. `src/identity/personaGen.ts` — `generateObject` (ai SDK, model `google/gemini-3-flash-preview`) against the persona zod schema (Appendix D). Input: seed + target geo + role archetype. Output stored verbatim in `personas`.
3. `src/identity/launchConfigGen.ts` — deterministic from inputs, no LLM: timezone = proxy geo timezone (param), locale from geo, window size picked from the pinned list `[1920×1080, 1536×864, 1440×900, 2560×1440]` seeded by profileId hash, chromeVersion = env `PINNED_CHROME_VERSION`.
4. `scripts/provision-profile.ts` — CLI: `--name --geo --tz --proxy-server --proxy-user --proxy-pass` → creates profile → persona → launchConfig → proxyBinding → transitions to `warming`. Prints the bundle.

**Pinned decisions**
- Launch configs are deterministic; only personas use an LLM.
- Proxy credentials stored in the `proxyBindings` table (internal system; revisit only if the threat model changes).
- Hindsight bank creation is **Phase 7**, not here — leave `hindsightBankId` null.

**DoD:** provision one real profile with a Coronium proxy; run a `browse` task; verify the egress IP logged in the session is the mobile proxy's IP and `TZ`/locale/viewport match the launch config (instruct the task to extract `Intl.DateTimeFormat().resolvedOptions().timeZone` and `navigator.language` from a test page).

---

## Phase 6 — Health state machine + soft signals

**Objective:** Early-warning system: every page classified, risk score computed, scheduler-relevant states transition automatically.

**Tasks**
1. `src/runner/classify.ts` — after every navigation/major action, one cheap `extract` call with schema `{ pageState: enum }` over the classification enum (Appendix B: `normal | login | captcha | checkpoint | restriction_notice | error_page | unknown`). Emit `PageObserved` with the result; additionally emit `ChallengeDetected` for captcha/checkpoint, `RestrictionDetected` for restriction_notice.
2. `convex/health.ts` —
   - `riskScore(profileId)` query: sum over last 14 days of signal events: `weight * 0.5^(ageHours/72)` with weights from Appendix C.
   - `evaluate(profileId)` internalMutation: recompute, store on profile, transition: `score >= 40 && status in [warming, active, cooldown] → warning`; `RestrictionDetected event → restricted` (immediate, regardless of score); `status == warning && score < 20 → active`.
3. Trigger `evaluate` from `events.append` whenever the appended event type is a signal type (same transaction).
4. `claimNext` already filters claimable statuses — verify `warning`/`restricted` profiles are not claimable (they are, per Phase 2 status list — no change needed, just assert in tests).

**Pinned decisions**
- Weights/thresholds/half-life live in `src/shared/constants.ts` + duplicated as constants in `convex/health.ts` (Convex can't import from src/). Appendix C values are final for v1 — the builder does not tune them.
- No ML, no anomaly detection beyond the weighted decay sum. Latency-based signals: out of scope v1.

**DoD:** `scripts/verify-phase6.ts`: append synthetic `ChallengeDetected` events (3 captchas) → assert riskScore ≈ 45, profile transitions to `warning`, `claimNext` returns null for it; append nothing for simulated time (insert events with old timestamps instead) → assert recovery path works; append `RestrictionDetected` → status `restricted`.

---

## Phase 7 — Hindsight integration

**Objective:** Bank per profile; recall-before-act; distilled retain-after-task; fleet bank exists with directives.

**Tasks**
1. `src/memory/hindsight.ts` — thin fetch client for the Hindsight HTTP API (`HINDSIGHT_API_URL`, `HINDSIGHT_API_KEY` envs): `createBank(bankId)`, `retain(bankId, content, tags, context)`, `recall(bankId, query, tags?)`, `reflect(bankId, query, responseSchema?)`, `createDirective(bankId, name, content)`. Bank naming: `profile-<convexProfileId>`, fleet bank: `fleet-main`.
2. Extend `scripts/provision-profile.ts`: create bank, seed 3–6 `retain`s from the persona backstory, set one directive ("You are <name>. Voice: <tone>. …"), store `hindsightBankId` on the profile.
3. Runner integration: before executing a task with a `target` (person/company in payload), `recall` for that target and inject the result into the agent's instruction context; after task completion, `retain` ONE distilled summary (2–4 sentences: what was done, outcome, anything learned about the target). Tag with `task:<type>`.
4. One-time `scripts/setup-fleet-bank.ts`: create `fleet-main` + directives: "Weight recent incidents heavily; LinkedIn detection evolves. Distrust learnings older than 90 days."

**Pinned decisions**
- Raw logs NEVER go to Hindsight — Convex is the ledger, Hindsight gets interpretations (one summary per task, dossiers in Phase 10).
- Hindsight calls are best-effort for task success: a failed `retain` logs an `ActionFailed(memory)` event but does not fail the task. A failed `recall` proceeds without memory context.
- Confirm exact Hindsight REST endpoints from its docs at build time; the wrapper signatures above are fixed regardless.

**DoD:** provision profile → bank exists with seeded memories; run a `browse` task with a target → `recall` result appears in the runner log, post-task memory visible via `recall` in `scripts/verify-phase7.ts`.

---

## Phase 8 — Unipile channel + router

**Objective:** API-first channel live; webhooks feed the same event log; router decides channel per action type.

**Tasks**
1. `src/channels/unipile.ts` — wrapper over `unipile-node-sdk` (`UNIPILE_DSN`, `UNIPILE_API_KEY`): `sendMessage`, `sendInvitation`, `getProfile`, `listRelations`. Each call emits `ActionStarted/Succeeded/Failed` with `channel: "api"` through a Convex-side emitter (the worker calls these, not the runner).
2. `convex/http.ts` — `POST /unipile/webhook`: validate shared secret header, map webhook → `events.append` (`channel: "api"`, types like `MessageReceived`, `InvitationAccepted`). Resolve profileId via `profiles` lookup by `unipileAccountId` (add this optional field to schema — **this is a sanctioned schema change owned by this phase**).
3. `src/channels/router.ts` — pinned map, no logic beyond lookup:
   ```ts
   const CHANNEL: Record<TaskType, "api" | "browser"> = {
     send_message: "api", send_invitation: "api", fetch_profile: "api",
     browse: "browser", warmup_feed: "browser", engage_post: "browser",
   };
   ```
4. Worker: tasks routed to `"api"` are executed in-process (no subprocess, no browser); `"browser"` tasks spawn the runner as before.
5. New task types in shared enums: `send_message`, `send_invitation`, `fetch_profile`, `warmup_feed`, `engage_post`.

**Pinned decisions**
- Unipile account connection (auth flow per profile) is manual via Unipile's hosted auth for v1 — store the resulting `unipileAccountId` on the profile by hand/CLI. No automated reconnection logic.
- API tasks still create a `sessions` row (channel `api`, no egressIp/snapshot) — one audit trail, one shape.

**DoD:** with one Unipile-connected account: `fetch_profile` task completes via API with full event chain; an incoming message produces a webhook event row in Convex.

---

## Phase 9 — Persona-driven scheduler + strategy versions

**Objective:** The system generates its own work: tasks from persona schedules under versioned policy budgets, with jitter and auditable policy decisions.

**Tasks**
1. `convex/policies.ts` — `createDraft(params, basedOnIncidentIds?, notes)`, `approve(id)` (sets `active`, retires previous active for the cohort), `getActive()`. Params shape is **exactly** Appendix E. Seed mutation `seedDefaultStrategy` with Appendix E's default values, version 1, status `active`.
2. `convex/scheduler.ts` + cron (every 30 min): for each profile in `[warming, active]`:
   - compute today's budget = persona `actionBudget` × strategy `budgetMultiplier` × warmup curve factor (Appendix E) by account age;
   - count today's completed tasks per type; if under budget AND now is inside persona active hours (profile timezone), enqueue at most ONE task with `dueAt = now + random(0..25min)` jitter;
   - whenever a task is NOT enqueued because of budget/hours/health, append a `PolicyDecision` event with the reason. Cap: skip `PolicyDecision` spam by emitting at most one per profile per cron run.
3. Task type selection: weighted random from persona action mix; `warmup_feed` dominates for `warming` profiles (weights in Appendix E).
4. Stamp `strategyVersionId` into every session/event ctx (extend `claimNext` bundle + emitter ctx — sanctioned touch of Phase 2/3 files, limited to adding this field).

**Pinned decisions**
- One strategy active globally for v1 (cohorts exist in the schema as `cohortTag` but only `"default"` is used).
- The scheduler enqueues; it never executes. Budgets enforced at enqueue time only (claim-time re-checks: out of scope).

**DoD:** `scripts/verify-phase9.ts`: provision 2 profiles with different active hours; run scheduler cron repeatedly with mocked "now" across a simulated day (call the internal function directly with a time arg); assert tasks respect hours, budgets, jitter spread, and that `PolicyDecision` events explain every skip.

---

## Phase 10 — Learning loop (incident → dossier → proposal)

**Objective:** Restrictions become structured dossiers; Hindsight reflects them into draft strategy proposals; approval is human.

**Tasks**
1. `convex/incidents.ts` — `openIncident(profileId, triggerEventId)` internalMutation, called from `health.evaluate` on transition to `restricted` (and on sustained `warning` ≥ 72h, checked by a daily cron). Builds the dossier **in Convex**: last 14 days of events for the profile, aggregated: action counts/day by type, session times, proxy/egress changes, launchConfig hash changes, strategyVersionId, soft-signal timeline, snapshot ids. Store as `incidents.dossier` (structured object, not prose).
2. `src/learning/dossier.ts` (new folder, sanctioned) — worker-side daily job: for each new incident: render dossier to a compact narrative (deterministic template, no LLM) → `retain` to `fleet-main` tagged `incident:<id>`, `strategy:<version>`.
3. `src/learning/propose.ts` — manual CLI for v1 (`pnpm tsx src/learning/propose.ts`): `reflect` on `fleet-main` with the question "What behavioral parameter changes would reduce restriction risk, based on all incident dossiers?" and `response_schema` = Appendix E params + `confidence` + `rationale` + `citedIncidents`. Writes result via `policies.createDraft`. **No auto-approval — drafts only.**
4. Attribution query: `policies.restrictionRateByVersion` — incidents per active-profile-day per strategyVersion.

**Pinned decisions**
- Dossier assembly is deterministic Convex code; only the cross-incident synthesis uses Hindsight `reflect`.
- Approval is a human running `policies.approve` (dashboard or CLI). Do not build auto-apply, even behind a flag.

**DoD:** `scripts/verify-phase10.ts`: synthetic events → force a restriction → incident row with complete dossier; run dossier job → memory in fleet bank; run propose → draft strategyVersion exists with citations; `restrictionRateByVersion` returns sane numbers.

---

# Appendix A — Convex schema (transcribe exactly in Phase 1)

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const profileStatus = v.union(
  v.literal("provisioning"), v.literal("warming"), v.literal("active"),
  v.literal("cooldown"), v.literal("warning"), v.literal("restricted"),
  v.literal("recovering"), v.literal("retired"));

const taskStatus = v.union(
  v.literal("pending"), v.literal("claimed"), v.literal("done"),
  v.literal("failed"), v.literal("cancelled"));

export default defineSchema({
  profiles: defineTable({
    name: v.string(),
    status: profileStatus,
    riskScore: v.number(),
    accountAgeDays: v.number(),            // for warmup curve; bump via daily cron
    personaId: v.optional(v.id("personas")),
    launchConfigId: v.optional(v.id("launchConfigs")),
    proxyBindingId: v.optional(v.id("proxyBindings")),
    currentSnapshotId: v.optional(v.id("profileSnapshots")),
    activeSessionId: v.optional(v.id("sessions")),
    hindsightBankId: v.optional(v.string()),
    unipileAccountId: v.optional(v.string()),   // added in Phase 8
    cohortTag: v.string(),                       // "default" for v1
    chromeVersion: v.string(),
  }).index("by_status", ["status"]),

  personas: defineTable({
    profileId: v.id("profiles"),
    version: v.number(),
    data: v.any(),            // validated by zod (Appendix D) before insert
  }).index("by_profile", ["profileId"]),

  launchConfigs: defineTable({
    profileId: v.id("profiles"),
    version: v.number(),
    timezone: v.string(),
    locale: v.string(),
    windowWidth: v.number(),
    windowHeight: v.number(),
    chromeVersion: v.string(),
    hash: v.string(),         // sha256 of the above, stamped into event ctx
  }).index("by_profile", ["profileId"]),

  proxyBindings: defineTable({
    profileId: v.id("profiles"),
    provider: v.literal("coronium"),
    server: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    geo: v.string(),
    status: v.union(v.literal("active"), v.literal("unhealthy"), v.literal("retired")),
  }).index("by_profile", ["profileId"]),

  tasks: defineTable({
    profileId: v.id("profiles"),
    type: v.string(),
    payload: v.any(),
    status: taskStatus,
    priority: v.number(),
    dueAt: v.number(),
    claimedBy: v.optional(v.id("workers")),
    leaseExpiresAt: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_status_dueAt", ["status", "dueAt"])
    .index("by_profile", ["profileId"]),

  sessions: defineTable({
    profileId: v.id("profiles"),
    taskId: v.id("tasks"),
    workerId: v.id("workers"),
    channel: v.union(v.literal("browser"), v.literal("api")),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    egressIp: v.optional(v.string()),
    launchConfigHash: v.optional(v.string()),
    strategyVersionId: v.optional(v.id("strategyVersions")),
    outcome: v.optional(v.string()),
  }).index("by_profile", ["profileId"]).index("by_task", ["taskId"]),

  events: defineTable({
    profileId: v.id("profiles"),
    sessionId: v.optional(v.id("sessions")),
    taskId: v.optional(v.id("tasks")),
    actionId: v.optional(v.string()),
    type: v.string(),                 // Appendix B taxonomy
    ts: v.number(),
    channel: v.union(v.literal("browser"), v.literal("api"), v.literal("system")),
    data: v.any(),
    ctx: v.object({
      egressIp: v.optional(v.string()),
      launchConfigHash: v.optional(v.string()),
      personaVersion: v.optional(v.number()),
      strategyVersionId: v.optional(v.id("strategyVersions")),
      model: v.optional(v.string()),
      stagehandVersion: v.optional(v.string()),
    }),
    artifactRefs: v.optional(v.array(v.string())),
  }).index("by_profile_ts", ["profileId", "ts"])
    .index("by_session", ["sessionId"])
    .index("by_type_ts", ["type", "ts"]),

  profileSnapshots: defineTable({
    profileId: v.id("profiles"),
    sessionId: v.id("sessions"),
    storageId: v.string(),
    contentHash: v.string(),
    chromeVersion: v.string(),
    sizeBytes: v.number(),
  }).index("by_profile", ["profileId"]),

  incidents: defineTable({
    profileId: v.id("profiles"),
    triggerEventId: v.id("events"),
    status: v.union(v.literal("open"), v.literal("dossier_retained"), v.literal("closed")),
    strategyVersionId: v.optional(v.id("strategyVersions")),
    dossier: v.any(),
  }).index("by_profile", ["profileId"]).index("by_status", ["status"]),

  strategyVersions: defineTable({
    version: v.number(),
    cohortTag: v.string(),
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("retired")),
    params: v.any(),          // Appendix E, zod-validated before insert
    basedOnIncidentIds: v.optional(v.array(v.id("incidents"))),
    notes: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
  }).index("by_cohort_status", ["cohortTag", "status"]),

  workers: defineTable({
    name: v.string(),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
    maxSessions: v.number(),
  }),
});
```

# Appendix B — Event taxonomy + envelope

Event types (closed list for v1 — adding a type requires editing `src/shared/types.ts` AND this plan):

```
SessionStarted · SessionEnded · ActionPlanned · ActionStarted · ActionSucceeded · ActionFailed
PageObserved · ChallengeDetected · AnomalyObserved · RestrictionDetected
ProfileStateChanged · ProfileProvisioned · ProxyChanged · FingerprintLoaded · SnapshotCommitted
PolicyDecision · MessageReceived · InvitationAccepted
```

Page classification enum: `normal | login | captcha | checkpoint | restriction_notice | error_page | unknown`.

Envelope = the `events` table shape in Appendix A. Rules: `ts` is set by the emitter (client time) AND Convex `_creationTime` exists as server truth; correlation ids are filled whenever available; `data` is type-specific and small (no blobs — use `artifactRefs`).

# Appendix C — State transitions, risk scoring, prune lists

**Allowed transitions** (everything else throws):

```
provisioning → warming
warming      → active | warning | restricted | retired
active       → cooldown | warning | restricted | retired
cooldown     → active | warning | restricted
warning      → active | restricted | retired
restricted   → recovering | retired
recovering   → warming | restricted | retired
```

**Risk weights** (summed with decay `0.5^(ageHours/72)` over a 14-day window):

| Signal event | Weight |
|---|---|
| `ChallengeDetected` (captcha) | 15 |
| `ChallengeDetected` (checkpoint) | 30 |
| `RestrictionDetected` | 100 (also: immediate transition to `restricted`) |
| `AnomalyObserved` | 5 |
| `ActionFailed` with HTTP 429 | 10 |

Thresholds: `>= 40` → `warning`; `< 20` while in `warning` → `active`.

**Snapshot prune list** (delete before archiving): `Default/Cache`, `Default/Code Cache`, `Default/GPUCache`, `GrShaderCache`, `ShaderCache`, `Crashpad`, `BrowserMetrics`.
**Must keep:** `Local State` (root — cookie encryption key), `Default/Network/Cookies`, `Default/Local Storage`, `Default/IndexedDB`, `Default/Preferences`.

# Appendix D — Persona zod schema (Phase 5)

```ts
const PersonaSchema = z.object({
  fullName: z.string(),
  role: z.string(),
  industry: z.string(),
  geo: z.string(),
  backstory: z.string().max(1200),
  tone: z.string(),               // e.g. "warm, direct, lightly informal"
  interests: z.array(z.string()).min(3).max(8),
  behavior: z.object({
    timezone: z.string(),
    activeHours: z.array(z.object({ start: z.number().min(0).max(23),
                                    end: z.number().min(1).max(24) })).min(1).max(3),
    weekdayActivity: z.array(z.number().min(0).max(1)).length(7),
    sessionsPerDay: z.object({ min: z.number().min(0), max: z.number().max(6) }),
    actionMix: z.object({          // relative weights, scheduler normalizes
      warmup_feed: z.number(), engage_post: z.number(),
      send_invitation: z.number(), send_message: z.number(), fetch_profile: z.number(),
    }),
  }),
});
```

# Appendix E — Strategy params shape + v1 defaults (Phases 9–10)

```ts
const StrategyParamsSchema = z.object({
  budgetMultiplier: z.number(),                    // default 1.0
  dailyBudgets: z.object({                         // hard caps per profile/day
    send_invitation: z.number(),                   // default 5
    send_message: z.number(),                      // default 10
    engage_post: z.number(),                       // default 8
    warmup_feed: z.number(),                       // default 3 (sessions)
    fetch_profile: z.number(),                     // default 20
  }),
  minDelayBetweenSessionsMin: z.number(),          // default 90
  warmupCurve: z.array(z.object({                  // by accountAgeDays on platform
    maxAgeDays: z.number(), factor: z.number(),
  })),                                             // default: [{14,0.2},{30,0.5},{60,0.8},{99999,1.0}]
  warmingActionMixOverride: z.object({             // dominates while status=warming
    warmup_feed: z.number(),                       // default 0.8
    engage_post: z.number(),                       // default 0.2
  }),
});
```

---

## Out of scope for v1 (do not let the builder start these)

- Fingerprint spoofing of any kind (escalation path only, evidence-driven)
- zstd compression, cold event archiving, R2/S3 blob store (interface exists; swap later)
- Convex subscriptions for workers (polling is fine)
- Cohort-level strategies (schema supports it; logic doesn't)
- Restriction recovery playbook (`recovering` state exists; workflow is a separate design pass)
- Dashboards/UI of any kind
- Worker affinity scheduling (single worker until the VPS fleet exists; revisit at 2+ workers)
- Automated Unipile account connection flows
