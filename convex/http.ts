import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { auth } from "./auth";
import { assertApiKey } from "./lib/apiAuth";
import { workerKeyFromEnv } from "./lib/apiAuth";

const http = httpRouter();

auth.addHttpRoutes(http);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Response("invalid json", { status: 400 });
  }
}

http.route({
  path: "/v1/jobs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      assertApiKey(request);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const payload = {
      startUrl: String(body.startUrl ?? ""),
      instructions: String(body.instructions ?? body.goal ?? ""),
      model: typeof body.model === "string" ? body.model : undefined,
      proxy:
        body.proxy && typeof body.proxy === "object"
          ? (body.proxy as {
              server: string;
              username?: string;
              password?: string;
            })
          : undefined,
      login:
        body.login && typeof body.login === "object"
          ? (body.login as { username: string; password: string })
          : undefined,
      secretRefs:
        body.secretRefs && typeof body.secretRefs === "object" && !Array.isArray(body.secretRefs)
          ? (body.secretRefs as Record<string, string>)
          : undefined,
      mcpServers: Array.isArray(body.mcpServers)
        ? body.mcpServers.filter((v): v is string => typeof v === "string")
        : undefined,
      maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      webhookUrl: String(body.webhookUrl ?? ""),
      webhookSecret: typeof body.webhookSecret === "string" ? body.webhookSecret : undefined,
      preferredWorkerName:
        typeof body.preferredWorkerName === "string" && body.preferredWorkerName.trim()
          ? body.preferredWorkerName.trim()
          : undefined,
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata
          : undefined,
    };

    try {
      const created = await ctx.runMutation(internal.jobs.create, { payload });
      return jsonResponse(created, 201);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 400);
    }
  }),
});

http.route({
  pathPrefix: "/v1/jobs/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      assertApiKey(request);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const jobId = segments[segments.length - 1];
    if (!jobId || jobId === "jobs") {
      return jsonResponse({ error: "job id required" }, 400);
    }

    const job = await ctx.runQuery(api.jobs.getPublic, { taskId: jobId as never });
    if (!job) return jsonResponse({ error: "job not found" }, 404);
    return jsonResponse(job);
  }),
});

http.route({
  pathPrefix: "/v1/jobs/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      assertApiKey(request);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const url = new URL(request.url);
    if (!url.pathname.endsWith("/cancel")) {
      return jsonResponse({ error: "not found" }, 404);
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const cancelIndex = segments.indexOf("cancel");
    const jobId = cancelIndex > 0 ? segments[cancelIndex - 1] : null;
    if (!jobId) return jsonResponse({ error: "job id required" }, 400);

    try {
      const result = await ctx.runMutation(internal.jobs.cancel, { taskId: jobId as never });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 400);
    }
  }),
});

http.route({
  path: "/v1/mcp-connections",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      assertApiKey(request);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const workerKey = workerKeyFromEnv();
    const rows = await ctx.runQuery(api.mcpConnections.listWorker, { workerKey });
    return jsonResponse({ connections: rows });
  }),
});

http.route({
  path: "/v1/mcp-connections",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    try {
      assertApiKey(request);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const body = (await readJsonBody(request)) as Record<string, unknown>;
    if (!body.name || typeof body.name !== "string") {
      return jsonResponse({ error: "name is required" }, 400);
    }
    if (body.transport !== "stdio" && body.transport !== "http") {
      return jsonResponse({ error: "transport must be stdio or http" }, 400);
    }

    try {
      const workerKey = workerKeyFromEnv();
      const result = await ctx.runMutation(api.mcpConnections.upsertApi, {
        workerKey,
        name: body.name,
        transport: body.transport,
        command: typeof body.command === "string" ? body.command : undefined,
        args: Array.isArray(body.args)
          ? body.args.filter((v): v is string => typeof v === "string")
          : undefined,
        envFromWorker: Array.isArray(body.envFromWorker)
          ? body.envFromWorker.filter((v): v is string => typeof v === "string")
          : undefined,
        url: typeof body.url === "string" ? body.url : undefined,
        headersFromWorker: Array.isArray(body.headersFromWorker)
          ? (body.headersFromWorker as Array<{ header: string; envVar: string }>)
          : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      });
      return jsonResponse(result, 201);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 400);
    }
  }),
});

http.route({
  pathPrefix: "/v1/mcp-connections/",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    try {
      assertApiKey(request);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const name = decodeURIComponent(segments[segments.length - 1] ?? "");
    if (!name || name === "mcp-connections") {
      return jsonResponse({ error: "connection name required" }, 400);
    }

    try {
      const workerKey = workerKeyFromEnv();
      const result = await ctx.runMutation(api.mcpConnections.removeApi, { workerKey, name });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 400);
    }
  }),
});

export default http;
