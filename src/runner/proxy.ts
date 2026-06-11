import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

export interface ProxyRelay {
  server: string;
  close: () => Promise<void>;
}

// Bridges an authenticated upstream proxy through a local unauthenticated relay
// (Chrome's --proxy-server cannot carry credentials).
export async function startProxyRelay(opts: {
  server: string;
  username?: string;
  password?: string;
}): Promise<ProxyRelay> {
  const host = opts.server.includes("://")
    ? opts.server.slice(opts.server.indexOf("://") + 3)
    : opts.server;
  const auth = opts.username
    ? `${encodeURIComponent(opts.username)}${opts.password ? `:${encodeURIComponent(opts.password)}` : ""}@`
    : "";
  const relayUrl = await anonymizeProxy(`http://${auth}${host}`);
  return {
    server: relayUrl,
    close: async () => {
      await closeAnonymizedProxy(relayUrl, true);
    },
  };
}
