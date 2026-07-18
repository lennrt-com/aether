// One-time setup: install global `bless` shims and ensure bin dirs are on user PATH.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function pnpmGlobalBinDir() {
  try {
    const fromConfig = run("pnpm config get global-bin-dir");
    if (fromConfig && !fromConfig.includes("undefined")) {
      return path.resolve(fromConfig);
    }
  } catch {
    // fall through
  }
  return path.join(os.homedir(), "AppData", "Local", "pnpm");
}

function npmGlobalBinDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm");
  }
  try {
    const prefix = run("npm config get prefix");
    if (prefix && !prefix.includes("undefined")) {
      return path.join(path.resolve(prefix), "bin");
    }
  } catch {
    // fall through
  }
  return path.join(os.homedir(), ".local", "bin");
}

function shimTargetDirs() {
  const dirs = new Set([pnpmGlobalBinDir(), npmGlobalBinDir()]);
  if (process.platform === "win32" && process.env["ProgramFiles"]) {
    dirs.add(path.join(process.env["ProgramFiles"], "nodejs"));
  }
  return [...dirs].map((d) => path.resolve(d));
}

function pathEntries(envPath) {
  return envPath.split(path.delimiter).filter(Boolean);
}

function readUserPath() {
  if (process.platform === "win32") {
    return run(
      "powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('Path','User')\"",
    );
  }
  return process.env.PATH ?? "";
}

function ensureOnUserPath(dirs) {
  const userPath = readUserPath();
  const entries = pathEntries(userPath);
  let changed = false;

  for (const dir of dirs) {
    const normalized = path.resolve(dir);
    if (entries.some((e) => path.resolve(e) === normalized)) {
      console.log(`User PATH already includes ${normalized}`);
      continue;
    }
    if (process.platform === "win32") {
      entries.push(normalized);
      changed = true;
      console.log(`Will add to user PATH: ${normalized}`);
    } else {
      console.log(`Add to shell profile: export PATH="${normalized}:$PATH"`);
    }
  }

  if (changed && process.platform === "win32") {
    const newPath = entries.join(";");
    const escaped = newPath.replace(/'/g, "''");
    run(
      `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path','${escaped}','User')"`,
    );
    console.log("User PATH updated.");
  }

  return changed;
}

function installShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

  if (process.platform === "win32") {
    const cmdPath = path.join(binDir, "aether.cmd");
    const ps1Path = path.join(binDir, "aether.ps1");
    const cmdContent =
      `@echo off\r\ncd /d "${projectRoot}"\r\nnode "${tsxCli}" "${cliEntry}" %*\r\n`;
    const ps1Content =
      `Set-Location -LiteralPath '${projectRoot.replace(/'/g, "''")}'\r\n& node "${tsxCli.replace(/'/g, "''")}" "${cliEntry.replace(/'/g, "''")}" @args\r\n`;
    fs.writeFileSync(cmdPath, cmdContent, "utf8");
    fs.writeFileSync(ps1Path, ps1Content, "utf8");
    console.log(`Installed: ${cmdPath}`);
    return;
  }

  const shimPath = path.join(binDir, "aether");
  const shimContent = `#!/usr/bin/env sh\ncd "${projectRoot}" && exec node "${tsxCli}" "${cliEntry}" "$@"\n`;
  fs.writeFileSync(shimPath, shimContent, "utf8");
  try {
    fs.chmodSync(shimPath, 0o755);
  } catch {
    // best effort
  }
  console.log(`Installed: ${shimPath}`);
}

const targetDirs = shimTargetDirs();
console.log(`project: ${projectRoot}`);
console.log("Installing shims to:");
for (const dir of targetDirs) {
  console.log(`  ${dir}`);
  try {
    installShim(dir);
  } catch (err) {
    console.warn(`  skipped ${dir}: ${String(err)}`);
  }
}

const pathChanged = ensureOnUserPath(targetDirs);

console.log("\nDone.");

if (process.platform === "win32") {
  console.log("\nReload PATH in this PowerShell session (paste once):");
  console.log(
    "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
  );
  console.log("\nThen run:  aether --help");
  if (pathChanged) {
    console.log("(Or open a new terminal — PATH is already saved for future sessions.)");
  }
}

console.log("\nIn this repo without global PATH:  pnpm aether   or   .\\aether");
console.log("Note: PowerShell never runs .\\aether.ps1 as bare `aether` from the project folder.");
