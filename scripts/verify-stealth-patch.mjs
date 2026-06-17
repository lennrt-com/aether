// Verifies the blessGTM Stagehand stealth patch is actually applied to the
// installed @browserbasehq/stagehand. Runs as a `postinstall` hook AND on
// demand via `pnpm verify:patch`.
//
// Why this exists: the stealth depends on a pnpm patch
// (patches/@browserbasehq__stagehand@3.5.0.patch) that strips `Runtime.enable`
// from Stagehand's CDP hot path — without it, fingerprint.com/botd detect the
// JS agent at page load and LinkedIn flags the session. The patch is PINNED to
// stagehand 3.5.0; if the lockfile ever drifts to another version the patch
// silently stops applying. This check turns that silent failure into a loud one.
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const EXPECTED_VERSION = "3.5.0";
// Unique comment the patch injects into understudy/context.js. Present only when
// the patch applied; absent on a stock install.
const PATCH_MARKER = "blessGTM Phase 1";

function fail(reason) {
  console.error("");
  console.error("  ❌  Stagehand stealth patch is NOT applied.");
  console.error(`      ${reason}`);
  console.error("");
  console.error("  This means CDP `Runtime.enable` is live and the browser is");
  console.error("  detectable as automated — do not run signups/warmup until fixed.");
  console.error("");
  console.error("  Fix:");
  console.error("    1) From the repo root:  pnpm install --frozen-lockfile");
  console.error("    2) Re-check:            pnpm verify:patch");
  console.error("");
  console.error("  The patch is pinned to @browserbasehq/stagehand@" + EXPECTED_VERSION + ".");
  console.error("  Do NOT `pnpm update` stagehand — a newer version drops the patch.");
  console.error("  (Patch lives in: patches/@browserbasehq__stagehand@" + EXPECTED_VERSION + ".patch,");
  console.error("   declared in pnpm-workspace.yaml -> patchedDependencies.)");
  console.error("");
  process.exit(1);
}

let pkgJsonPath;
try {
  pkgJsonPath = require.resolve("@browserbasehq/stagehand/package.json");
} catch {
  fail("@browserbasehq/stagehand is not installed yet — run `pnpm install` first.");
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const pkgDir = path.dirname(pkgJsonPath);

if (pkg.version !== EXPECTED_VERSION) {
  fail(
    `installed version is ${pkg.version}, but the stealth patch only targets ${EXPECTED_VERSION}.`,
  );
}

// ESM build is what the runner imports ("type": "module"); it MUST carry the
// patch. The CJS build is checked too, but only if it ships in this version.
const esmContext = path.join(pkgDir, "dist/esm/lib/v3/understudy/context.js");
const cjsContext = path.join(pkgDir, "dist/cjs/lib/v3/understudy/context.js");

if (!existsSync(esmContext)) {
  fail(`expected file is missing: ${path.relative(pkgDir, esmContext)}`);
}
if (!readFileSync(esmContext, "utf8").includes(PATCH_MARKER)) {
  fail(`ESM build is unpatched (marker "${PATCH_MARKER}" not found in context.js).`);
}
if (existsSync(cjsContext) && !readFileSync(cjsContext, "utf8").includes(PATCH_MARKER)) {
  fail(`CJS build is unpatched (marker "${PATCH_MARKER}" not found in context.js).`);
}

console.log(
  `  ✅  Stagehand stealth patch verified — @browserbasehq/stagehand@${pkg.version} is patched ` +
    `(Runtime.enable suppressed).`,
);
