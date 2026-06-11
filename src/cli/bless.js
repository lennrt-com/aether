#!/usr/bin/env node
// Bin shim: run the TypeScript CLI through tsx.
import { register } from "tsx/esm/api";

register();
await import("./index.ts");
