import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// Unipile v2 webhook deliveries. The shared secret is embedded in the
// registered URL (?secret=...) since v2 doesn't support custom headers;
// an x-webhook-secret header is accepted as well.
http.route({
  path: "/unipile/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.UNIPILE_WEBHOOK_SECRET;
    const url = new URL(request.url);
    const provided =
      request.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
    if (!expected || provided !== expected) {
      return new Response("unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    const result = await ctx.runMutation(internal.events.appendFromWebhook, { body });
    return Response.json(result);
  }),
});

export default http;
