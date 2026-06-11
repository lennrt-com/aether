// Unipile v2 setup CLI:
//   pnpm tsx scripts/setup-unipile-webhook.ts                  -> list accounts + register webhook
//   pnpm tsx scripts/setup-unipile-webhook.ts --link <profileId> <accountId>
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { createUnipileClient } from "../src/channels/unipile.js";

const apiKey = process.env.UNIPILE_API_KEY;
const secret = process.env.UNIPILE_WEBHOOK_SECRET;
const siteUrl = process.env.CONVEX_SITE_URL;
if (!apiKey || !secret || !siteUrl) {
  throw new Error("UNIPILE_API_KEY / UNIPILE_WEBHOOK_SECRET / CONVEX_SITE_URL must be set");
}

const unipile = createUnipileClient();

if (process.argv[2] === "--link") {
  const [, , , profileId, accountId] = process.argv;
  if (!profileId || !accountId) throw new Error("usage: --link <profileId> <accountId>");
  const convexUrl = process.env.CONVEX_URL;
  const workerKey = process.env.WORKER_KEY;
  if (!convexUrl || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
  const client = new ConvexHttpClient(convexUrl);
  await client.mutation(api.profiles.setUnipileAccount, {
    workerKey,
    profileId: profileId as Id<"profiles">,
    unipileAccountId: accountId,
  });
  console.log(`linked profile ${profileId} -> unipile account ${accountId}`);
  process.exit(0);
}

const accounts = await unipile.listAccounts();
console.log("connected Unipile accounts:");
for (const acc of accounts.items ?? []) {
  console.log(`  ${acc.id}  provider=${acc.provider ?? "?"}  name=${acc.name ?? "?"}`);
}
if (!accounts.items?.length) {
  console.log("  (none — connect a LinkedIn account via Unipile hosted auth first)");
}

const webhookUrl = `${siteUrl}/unipile/webhook?secret=${secret}`;
const baseUrl = process.env.UNIPILE_BASE_URL ?? "https://api.unipile.com";

const listRes = await fetch(`${baseUrl}/v2/webhooks/endpoints/`, {
  headers: { "X-API-KEY": apiKey, accept: "application/json" },
});
if (!listRes.ok) throw new Error(`list webhooks failed: HTTP ${listRes.status}`);
const existing = (await listRes.json()) as { items?: Array<{ id: string; url: string }> };
const already = existing.items?.find((w) => w.url === webhookUrl);
if (already) {
  console.log(`webhook endpoint already registered: ${already.id}`);
  process.exit(0);
}

const createRes = await fetch(`${baseUrl}/v2/webhooks/endpoints/`, {
  method: "POST",
  headers: {
    "X-API-KEY": apiKey,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify({
    url: webhookUrl,
    trigger_events: ["message.new", "relation.request.accept"],
    description: "blessGTM event log feed",
  }),
});
if (!createRes.ok) {
  throw new Error(`create webhook failed: HTTP ${createRes.status}: ${await createRes.text()}`);
}
const created = (await createRes.json()) as { id: string; secret: string };
console.log(`webhook endpoint registered: ${created.id}`);
console.log(`unipile-generated delivery secret: ${created.secret}`);
