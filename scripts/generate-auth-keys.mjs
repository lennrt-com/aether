import { spawnSync } from "node:child_process";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

function setConvexEnv(name, value) {
  const result = spawnSync(
    "pnpm",
    ["exec", "convex", "env", "set", name],
    {
      input: value,
      stdio: ["pipe", "inherit", "inherit"],
      shell: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to set ${name}`);
  }
}

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
const jwtPrivateKey = privateKey.trimEnd().replace(/\n/g, " ");

setConvexEnv("JWT_PRIVATE_KEY", jwtPrivateKey);
setConvexEnv("JWKS", jwks);

console.log("Set JWT_PRIVATE_KEY and JWKS on the Convex dev deployment.");
