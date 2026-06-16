// Stagehand + AI SDK log system-role messages in `messages` and warn on every LLM step.
// We can't pass allowSystemInMessages through Stagehand — filter the known warning only.
const originalWarn = console.warn.bind(console);

console.warn = (...args: unknown[]) => {
  const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  if (msg.includes("System messages in the prompt or messages fields")) return;
  originalWarn(...args);
};
