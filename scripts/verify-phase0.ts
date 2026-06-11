import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("CONVEX_URL not set");

const client = new ConvexHttpClient(url);
const res = await client.query(api.ping.ping, {});
if (!res.ok) throw new Error("ping returned not-ok");
console.log(`phase 0 OK — ping ts=${res.ts}`);
