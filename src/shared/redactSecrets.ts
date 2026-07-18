const SENSITIVE_KEYS =
  /^(password|passwd|secret|token|session|authorization|api[_-]?key|credential|totp|otp|bw_session)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.test(key);
}

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= 4) return "[REDACTED]";
    return `${value.slice(0, 2)}…[REDACTED]`;
  }
  return "[REDACTED]";
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = redactValue(val);
    } else if (typeof val === "object" && val !== null) {
      out[key] = redactSecrets(val, depth + 1);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Strip resolved credential values from agent job results before persistence. */
export function redactAgentResult(result: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(result) as Record<string, unknown>;
}
