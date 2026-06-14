# Fingerprint Stealth — How the Stagehand browser passes as a real Chrome

This document explains, in replicable detail, the changes that make our **LOCAL
Stagehand** browser pass [fingerprint.com](https://fingerprint.com) /
anti-detect scanners without being flagged as a bot.

Three Fingerprint signals were the targets, and the end state we reach:

| Signal | Before | After | Fixed by |
| --- | --- | --- | --- |
| `bot` (`bot_type: "nodriver"`) | `bad` | `not_detected` | **Layer 1** — launch-flag hygiene (UA‑CH) |
| `developer_tools` (Fingerprint) | `true` | `false` | **Layer 3** — removing CDP `Runtime.enable` |
| `hasCDP` / `cdp` (fpscanner, deviceandbrowserinfo) | `true` | `false` | **Layer 3B** — transport-level `Runtime.enable` block |
| `tampering` | varies | `false` | **Layer 5** — truthful fingerprint + native masking |
| `vpn` / `proxy` (OS mismatch) | flagged | provider-dependent | **Layer 6** — WebRTC hardening + proxy choice |

> **Mental model.** Fingerprint computes most of this **server-side** from
> signals the browser emits. You don't beat it by lying loudly; you beat it by
> emitting a **coherent, real-Chrome signal set** and by **not leaving automation
> artifacts** (CDP side effects, injected globals, missing UA Client Hints).

---

## 0. The environment that makes this necessary

Stagehand's built-in "stealth" only exists on **Browserbase** (their cloud). In
`env: "LOCAL"` mode Stagehand launches real Chrome through `chrome-launcher` and
forwards **only** `localBrowserLaunchOptions.args` to the command line — it
applies **no** anti-detection of its own. So every hardening below is something
*we* add on top.

Key constructor settings (`src/runner/session.ts`):

```ts
new Stagehand({
  env: "LOCAL",
  model: "google/gemini-3-flash-preview",
  experimental: true,   // agent custom tools + output schema
  disableAPI: true,     // never call Browserbase
  localBrowserLaunchOptions: { userDataDir, headless, args, ignoreDefaultArgs, ... },
});
```

- **Stagehand version:** `@browserbasehq/stagehand@3.5.0` (pinned by the pnpm
  patch — see Layer 3/4).
- **Launcher:** `chrome-launcher` with a **real, pinned Chrome** (148.x), never
  Chromium and never `--headless` for production runs.

---

## Layer 1 — Launch-flag hygiene: the `nodriver` / UA‑Client‑Hints fix ⭐

**This was the single change that cleared `bot: bad` → `not_detected`.**

### The problem

`chrome-launcher` (and Stagehand) inject a large set of **testing-oriented
default flags**: `--disable-background-networking`,
`--disable-features=...`, `--disable-component-update`,
`--disable-back-forward-cache`, variations disables, etc. Individually harmless,
**collectively they suppress Chrome's variations seed** — the mechanism that
populates **User-Agent Client Hints (UA‑CH)**.

With the variations seed suppressed, Fingerprint reads:

```
browser_details:      "Chromium-Based Browser"
browser_full_version: "Not Available"
```

A "Chromium-Based Browser" with a missing full version, **combined with CDP
automation present**, is exactly the signature Fingerprint attributes to
`ultrafunkamsterdam/nodriver` → `bot_type: "nodriver"`, `bot: bad`.

A real Chrome reports `Chrome / 148.0.0.0` with full UA‑CH brand list. The fix
is to stop suppressing that.

### The fix

Strip `chrome-launcher`'s + Stagehand's default flags and re-add **only** a tiny
curated set that is provably **not observable by page JS / UA‑CH**.

`src/runner/session.ts` (defaults to stripping; escape hatch to restore):

```ts
// ignoreDefaultArgs:true strips chrome-launcher's + Stagehand's defaults so the
// variations seed survives and native UA-CH is reported.
const ignoreDefaultArgs: boolean | undefined =
  process.env.LAUNCH_INHERIT_DEFAULTS === "1" ? undefined : true;
```

`src/runner/chromeFlags.ts` re-adds the curated, page-invisible flags:

```ts
const CURATED_BASE_FLAGS = [
  "--no-first-run",            // skip first-run UI; not page-visible
  "--no-default-browser-check",// suppress "set as default" prompt
  "--password-store=basic",    // portable credential storage; not page-visible
  "--disable-dev-shm-usage",   // Linux/Docker stability; memory-only
  "--remote-allow-origins=*",  // allow the CDP websocket; debug-port only
];
```

These are merged so that **caller args always win** (`mergeArgs` dedupes by
switch key). Deliberately **NOT** re-added: `--site-per-process` — it isn't a
UA‑CH signal, but it was absent from the proven-clean A/B run, so we keep the
default guaranteed-clean and only add it back (vetted) if a flow needs
cross-origin iframe automation.

### How it was proven (so you can re-bisect)

A/B flag-bisecting against Fingerprint:

1. **Test 1 — `EXP_MINIMAL`**: strip *all* chrome-launcher + Stagehand defaults
   → `bot: not_detected`, identity `Chrome / 148.0.0`. ✅ Proves a default flag
   is the culprit, **not** CDP itself.
2. **Partial exclusions**: removing only subsets did **not** clear it → it's the
   *aggregate* variations suppression, not one flag.
3. **Final**: `ignoreDefaultArgs:true` + `CURATED_BASE_FLAGS` → clean **and**
   CDP automation still works.

> **Takeaway for replication:** if you ever see `bot_type: "nodriver"` with
> `browser_details: "Chromium-Based Browser"`, your launcher is suppressing the
> variations seed. Strip its default flags; re-add only page-invisible ones.

---

## Layer 2 — `navigator.webdriver` / AutomationControlled

`src/runner/chromeFlags.ts`, `stealthFlags()`:

```ts
"--disable-blink-features=AutomationControlled"
```

Without it, `navigator.webdriver === true` whenever Chrome runs headless and the
AutomationControlled blink signals can surface under CDP. This flag makes
`navigator.webdriver` read like a real browser **with no inconsistency**, in both
headful and headless. Highest-value, lowest-risk single stealth flag.
(Diagnostic toggle: `EXP_NO_AUTOMATION_CONTROLLED=1` omits it.)

---

## Layer 3 — Killing the CDP `Runtime.enable` leak: `developer_tools` AND `hasCDP` ⭐

**This cleared `developer_tools: true` → `false` (Fingerprint) and `hasCDP:
true` → `false` (fpscanner / deviceandbrowserinfo).**

### The problem

Sending the CDP command **`Runtime.enable`** has observable side effects in the
page: console object serialization invokes `Error.stack` getters and exposes the
runtime to the debugger. Detectors probe for this:
- Fingerprint's `developer_tools` signal.
- The open-source `hasCDP` check (`fpscanner`, `deviceandbrowserinfo`,
  Fingerprint botd): create an `Error`, define a `stack` getter that flips a
  flag, `console.debug(err)`, and see if the getter fired — it only fires while
  the Runtime domain is enabled.

Once `Runtime.enable` is sent on a session it stays enabled for that target's
lifetime, so a **single** call anywhere makes the page CDP-detectable.

### Fix part A — remove the obvious call sites (pnpm patch)

Remove `Runtime.enable` from Stagehand's understudy layer and rely on the
already-present `Page.enable` + `DOM.enable` + `Target.setAutoAttach` +
`getMainWorldExecutionContextId()` path. Applied via a **pnpm patch** so it
survives reinstalls.

Patched files (both `dist/cjs` **and** `dist/esm`):

| File | What was removed |
| --- | --- |
| `understudy/context.js` | `Runtime.enable` from the pre-resume op queue (kept `Page.enable`, `Target.setAutoAttach`) |
| `understudy/executionContextRegistry.js` | `Runtime.enable` fallback in `getMainWorld` |
| `understudy/frame.js` | `Runtime.enable` before `evaluate` |
| `understudy/locator.js` | `Runtime.enable` in `count()`, `resolveNode()`, `resolveNodesForMask()` (kept `DOM.enable`) |
| `understudy/page.js` | `Runtime.enable` in console handler, `title()`, `evaluate()` |
| `understudy/piercer.js` | `Runtime.enable` before injecting the piercer script |

Wiring (`pnpm-workspace.yaml`):

```yaml
patchedDependencies:
  '@browserbasehq/stagehand@3.5.0': patches/@browserbasehq__stagehand@3.5.0.patch
```

The patch file `patches/@browserbasehq__stagehand@3.5.0.patch` contains the diffs
above. After editing node_modules you regenerate it with:

```bash
pnpm patch @browserbasehq/stagehand@3.5.0
# ...edit the files in the temp dir...
pnpm patch-commit <temp-dir>
```

### Fix part B — block `Runtime.enable` at the transport (the real guarantee) ⭐

The patch above is **not enough on its own**: it only covered the call sites we
knew about. Stagehand calls `Runtime.enable` in *more* places on the agent hot
path that the patch missed — the accessibility snapshot
(`a11y/snapshot/a11yTree.js`, used by `ariaTree` / `extract` / `observe`),
`activeElement.js` and `coordinateResolver.js` (used when the agent clicks),
`clipboard.js`, and `frameLocator.js`. That is exactly why `hasCDP` stayed
`true` during agent runs even though `developer_tools` was already `false`: the
agent's first `ariaTree` tool re-enabled Runtime.

Chasing call sites is whack-a-mole and broke once already on a version bump. So
we drop `Runtime.enable` at the **single CDP transport chokepoint** instead.
Every CDP message — root-level and per-session (`page.sendCDP`, `session.send`)
— funnels through `CdpConnection.send` / `CdpConnection._sendViaSession` on the
one connection instance (`stagehand.context.conn`). We wrap both right after
`stagehand.init()` and short-circuit `Runtime.enable` to a resolved empty
result, so **no call site — present or future — can enable the domain**.

`src/runner/session.ts`, `suppressRuntimeEnable()` (called from `launchSession`
after init):

```ts
const conn = (stagehand.context as unknown as { conn?: CdpConnLike }).conn;
const isBlocked = (m: string) => m === "Runtime.enable";
const send = conn.send.bind(conn);
conn.send = (m, p) => (isBlocked(m) ? Promise.resolve({}) : send(m, p));
const viaSession = conn._sendViaSession.bind(conn);
conn._sendViaSession = (sid, m, p) => (isBlocked(m) ? Promise.resolve({}) : viaSession(sid, m, p));
```

This lives in **our** code (no patch fragility across Stagehand versions) and is
a single, auditable point. Escape hatch: `STEALTH_ALLOW_RUNTIME_ENABLE=1`
restores stock behavior for debugging/A-B.

> **Why automation still works:** `Runtime.evaluate` / `Runtime.callFunctionOn`
> do **not** require `Runtime.enable`. With the domain off, `executionContextCreated`
> events never fire, so `executionContextRegistry.waitForMainWorld` hits its
> 800ms timeout and callers fall back to a **context-less** `Runtime.evaluate`
> (evaluates in the target's default world — correct for top frame + each
> auto-attached OOPIF). The only cost is up to 800ms per coordinate/eval lookup
> on the click path — a fine trade for stealth.

---

## Layer 4 — Hiding the Stagehand piercer artifacts

### The problem

Stagehand injects a **piercer** script on every new document
(`Page.addScriptToEvaluateOnNewDocument`) to see into closed shadow roots. The
stock script leaves automation tells:

- `window.__stagehandV3__` and `window.__stagehandV3Injected` as **enumerable**
  globals (visible to `Object.keys`, `for…in`, `JSON.stringify(window)`).
- `Element.prototype.attachShadow` replaced with a JS function whose
  `.name` !== `"attachShadow"` and whose `.toString()` reveals JS source
  instead of `[native code]`.
- `console.info("[v3-piercer] …")` debug logging.

### The fix

The script content (`dist/{esm,cjs}/lib/v3/dom/build/scriptV3Content.js`,
exported as `v3ScriptContent`) was rewritten so the piercer is invisible:

- A `hide(obj, key, value)` helper defines properties **non-enumerable**
  (`enumerable:false`) → globals don't show up in enumeration/serialization.
- `Object.defineProperty(patchedAttachShadow, "name", {value:"attachShadow"})`
  and matching `.length`.
- A `Function.prototype.toString` **Proxy** that returns the captured native
  string (`NS = Function.prototype.toString.call(AS)`) when called on the
  patched `attachShadow` → `attachShadow.toString()` === `"function attachShadow() { [native code] }"`.
- `__v3Patched` / `__v3State` defined non-enumerable on the patched function.
- `debug:false` → no `[v3-piercer]` console output.

The actual injected string (minified, identical in esm + cjs):

```js
(()=>{function s(c={}){let AS=Element.prototype.attachShadow,NS=Function.prototype.toString.call(AS),
hide=(o,k,v)=>{try{Object.defineProperty(o,k,{value:v,configurable:!0,writable:!0,enumerable:!1})}catch{}},
r=e=>{let{hostToRoot:o}=e;hide(window,"__stagehandV3__",{getClosedRoot:a=>o.get(a),
stats:()=>({installed:!0,url:location.href,isTop:window.top===window,open:e.openCount,closed:e.closedCount})})},
n=AS;if(n.__v3Patched&&n.__v3State){n.__v3State.debug=!1,r(n.__v3State);return}
let t={hostToRoot:new WeakMap,openCount:0,closedCount:0,debug:!1},l=n,
d=function(e){let o=e?.mode??"open",a=l.call(this,e);try{t.hostToRoot.set(this,a),
o==="closed"?t.closedCount++:t.openCount++}catch{}return a};
hide(d,"__v3Patched",!0),hide(d,"__v3State",t);
try{Object.defineProperty(d,"name",{value:"attachShadow",configurable:!0})}catch{}
try{Object.defineProperty(d,"length",{value:AS.length,configurable:!0})}catch{}
try{let T=Function.prototype.toString,P=new Proxy(T,{apply:(g,thisArg,args)=>thisArg===d?NS:Reflect.apply(g,thisArg,args)});
Object.defineProperty(Function.prototype,"toString",{value:P,configurable:!0,writable:!0})}catch{}
if(Object.defineProperty(Element.prototype,"attachShadow",{configurable:!0,writable:!0,value:d}),c.tagExisting)
try{let e=document.createTreeWalker(document,NodeFilter.SHOW_ELEMENT);for(;e.nextNode();){let o=e.currentNode;
o.shadowRoot&&(t.hostToRoot.set(o,o.shadowRoot),t.openCount++)}}catch{}
hide(window,"__stagehandV3Injected",!0),r(t)}s({debug:!1,tagExisting:!1});})();
```

> ### Durability — baked into the pnpm patch ✅
> This rewrite is now captured in `patches/@browserbasehq__stagehand@3.5.0.patch`
> (alongside the Layer 3 `Runtime.enable` removals), so a fresh `pnpm install`
> re-applies it automatically. It was previously a raw `node_modules` edit that a
> reinstall would have silently reverted.
>
> If you bump the Stagehand version, re-derive it:
> ```bash
> pnpm patch "@browserbasehq/stagehand@<version>"
> # overwrite dist/esm/.../scriptV3Content.js AND dist/cjs/.../scriptV3Content.js
> # with the stealth string above, then:
> pnpm patch-commit "<edit-dir printed by pnpm patch>"
> ```
> Verify both files in the edit dir contain `enumerable:!1` before committing.
>
> Note: Layer 1 (UA‑CH) was what actually cleared the `bot` flag; this layer did
> **not** flip `bot` on its own in testing. Keep it anyway — it removes globals
> that *other* detectors (and future Fingerprint signal versions) look for.

---

## Layer 5 — Truthful fingerprint with native masking (`tampering: false`)

`src/runner/fingerprint/patch.ts` is injected via `context.addInitScript` before
page scripts. Its philosophy: **do not misrepresent the hardware** (that triggers
`tampering`); only inject **deterministic, sub-perceptual noise** so naive
client-side hashes differ per profile, and mask the patched functions so they
look native.

What it does, keyed off a per-profile `seed`:

- **Canvas**: ±1 on ~1/8 of pixels in `getImageData` / `toDataURL` / `toBlob`.
- **WebGL**: ±1 on `readPixels` output bytes.
- **Audio**: ±1e-4 / ±1e-7 noise on a fraction of `getFloatFrequencyData` /
  `getChannelData` samples.
- **navigator**: `hardwareConcurrency`, `deviceMemory`, `languages`/`language`
  set from the launch config.
- **Native masking**: a `Function.prototype.toString` Proxy + `makeNative()` so
  every patched function reports `function X() { [native code] }`.

What it deliberately does **NOT** touch (would break consistency → `tampering`):
the **WebGL `UNMASKED_VENDOR`/`UNMASKED_RENDERER`** (real GPU), fonts, screen
metrics, UA/UA‑CH, TLS/JA3.

> **Important limitation:** because the noise is sub-threshold and the GPU string
> is truthful, **Fingerprint Pro's server-side `visitorId` does NOT change** from
> this alone on the same machine. The `visitorId` only varies when the **egress
> IP** changes. This layer is about `tampering: false`, *not* visitorId
> uniqueness. (See `architecture.md` / proxy notes.)

---

## Layer 6 — WebRTC IP hardening (proxy/VPN hygiene)

Prevents WebRTC from leaking the real IP over UDP that bypasses the session
proxy — replicating the "WebRTC Network Limiter" extension's
`disable_non_proxied_udp` policy natively. `src/runner/chromeFlags.ts`:

```ts
"--webrtc-ip-handling-policy=disable_non_proxied_udp"
"--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
```

Both switches are passed (neither alone is reliable on release Chrome), **plus**
`seedWebrtcPreference()` writes `webrtc.ip_handling_policy` into the profile's
`Default/Preferences` so a hydrated/snapshotted profile carries the policy on
disk too. This is belt-and-suspenders; the flags are primary.

---

## What we deliberately did NOT do (`OMITTED_STEALTH_FLAGS`)

These popular "stealth" flags make the fingerprint **worse** and are documented
in `chromeFlags.ts` so nobody "helpfully" re-adds them:

| Flag | Why it hurts |
| --- | --- |
| `--disable-gpu` | forces SwiftShader → fake WebGL vendor/renderer (classic bot tell) |
| `--no-sandbox` / `--disable-setuid-sandbox` | datacenter/automation signal |
| `--disable-web-security` | no real browser runs with this |
| `--user-agent=<spoofed>` | UA vs UA‑CH/navigator mismatch is highly detectable |
| `--use-gl` / `--use-angle` | overriding GL backend changes WebGL strings → inconsistent |
| `--disable-features=IsolateOrigins,site-per-process` | abnormal; Stagehand relies on site isolation |

General rule: **only add flags that are JS-observably indistinguishable from a
real browser.** When in doubt, don't.

---

## The launch sequence (how the layers compose)

`launchSession()` in `src/runner/session.ts`:

1. Start the proxy relay (if any) and resolve the **egress IP** before any nav.
2. `resolveWebrtcIpPolicy()` → `seedWebrtcPreference()` (Layer 6 pref seed).
3. `buildHardenedChromeArgs(args, policy)` → `CURATED_BASE_FLAGS` (Layer 1) +
   `--disable-blink-features=AutomationControlled` (Layer 2) + WebRTC flags
   (Layer 6), with caller args winning.
4. `new Stagehand({ env:"LOCAL", ignoreDefaultArgs:true, ... })` (Layer 1) — and
   the patched Stagehand (Layers 3A & 4) is what actually runs.
5. `stagehand.init()` → `suppressRuntimeEnable(stagehand)` (Layer 3B, transport
   block) → `applyFingerprint(context, cfg)` (Layer 5).

---

## How to verify / replicate the result

### Live, against detectors

- **Manual:** `pnpm cli launch --create` (or `--raw` for a no-CDP baseline).
- **Agent:** `pnpm cli agent-test --create` — drives a real agent and prints the
  scanner's `visitorId`.
- Point either at the scanner (`anti-detect-scanner-production.up.railway.app`)
  or your own Fingerprint dummy page and confirm: `bot: not_detected`,
  `developer_tools: false`, `tampering: false`.

### Automated preflight gate (`src/runner/preflight.ts`)

Runs before any LinkedIn action and aborts if anything looks automated/leaky:

- **Bot/headless:** `bot.sannysoft.com`, `arh.antoinevastel.com/bots/areyouheadless`,
  `deviceandbrowserinfo.com/are_you_a_bot`, `fpscanner.com/demo`.
- **Proxy/leak:** IPQualityScore, proxydetect.live, ip2proxy, browserleaks
  (ip + webrtc), dnsleaktest.

### Fingerprint signal gate (`src/runner/fingerprintCheck.ts`)

Reads the scanner's `visitorId` + `eventId`, optionally pulls the authoritative
server signals via the **Fingerprint Server API** (`Auth-API-Key`, `FINGERPRINT_API_KEY`),
asserts `tampering !== true`, and records the `visitorId` in Convex to detect
**cross-profile collisions**.

---

## Maintenance checklist (do not regress)

- [ ] Both Layer 3 (`Runtime.enable`) and Layer 4 (piercer) are now in the pnpm
      patch, so `pnpm install` re-applies them. Spot-check after install with:
      `Select-String node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/dom/build/scriptV3Content.js -Pattern "enumerable:!1"`.
- [ ] Keep the **pnpm patch** pinned to the exact Stagehand version. Bumping
      Stagehand requires re-deriving the patch (see Layer 4 for the steps).
- [ ] Never let a launcher/Stagehand upgrade silently restore default flags —
      keep `ignoreDefaultArgs:true` (Layer 1). Use `LAUNCH_INHERIT_DEFAULTS=1`
      only for debugging.
- [ ] Re-run the A/B (`EXP_MINIMAL=1`) bisect if `nodriver` ever reappears.
- [ ] Don't add anything from `OMITTED_STEALTH_FLAGS`.
- [ ] `hasCDP` / `developer_tools` regressed? Confirm `suppressRuntimeEnable()`
      still attaches (Layer 3B) — i.e. `stagehand.context.conn` still exposes
      `send` / `_sendViaSession`. If Stagehand renames the connection internals,
      update the `CdpConnLike` shape. Verify with `STEALTH_ALLOW_RUNTIME_ENABLE=1`
      (should make `hasCDP` go back to `true`, proving the block is what clears it).

---

## File reference

| Concern | File |
| --- | --- |
| Stagehand launch + `ignoreDefaultArgs` | `src/runner/session.ts` |
| Curated flags, stealth flag, WebRTC, omitted flags | `src/runner/chromeFlags.ts` |
| Deterministic fingerprint noise + native masking | `src/runner/fingerprint/patch.ts` |
| `Runtime.enable` removals (Layer 3A, call sites) | `patches/@browserbasehq__stagehand@3.5.0.patch` |
| `Runtime.enable` transport block (Layer 3B, all sites) | `src/runner/session.ts` (`suppressRuntimeEnable`) |
| Piercer stealth string (Layer 4) | `patches/@browserbasehq__stagehand@3.5.0.patch` (rewrites `dist/{esm,cjs}/lib/v3/dom/build/scriptV3Content.js`) |
| Patch wiring | `pnpm-workspace.yaml` (`patchedDependencies`) |
| Bot/proxy preflight | `src/runner/preflight.ts` |
| visitorId / tampering gate | `src/runner/fingerprintCheck.ts` |
