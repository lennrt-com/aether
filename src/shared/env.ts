// Loads .env.local (Convex CLI convention) then .env; first file wins on conflicts.
import "./suppressAiSdkWarnings.js";
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
