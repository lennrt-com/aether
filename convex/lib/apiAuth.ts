export function assertApiKey(request: Request): void {
  const expected = process.env.AETHER_API_KEY;
  if (!expected) {
    throw new Response("AETHER_API_KEY not configured", { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const provided = request.headers.get("x-api-key") ?? bearer;
  if (!provided || provided !== expected) {
    throw new Response("unauthorized", { status: 401 });
  }
}

export function workerKeyFromEnv(): string {
  const key = process.env.WORKER_KEY;
  if (!key) throw new Error("WORKER_KEY is not configured on the deployment");
  return key;
}
