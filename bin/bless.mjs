#!/usr/bin/env node
// Package bin entry — run the TypeScript CLI through the project's tsx.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

const result = spawnSync("node", [tsxCli, cliEntry, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
