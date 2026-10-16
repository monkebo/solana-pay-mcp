// `saw vault serve`: run the vault. Holds the key and policy; agents connect with session tokens.
import { createServer } from "node:http";
import { createHandler, ownerTokenFile } from "./http.js";
import { readPolicy, patchPolicy } from "./core/policy.js";
import { cluster, home } from "./core/config.js";

export async function startVault(args: string[]): Promise<void> {
  const flag = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const sub = args[0] === "serve" ? "serve" : args[0];
  if (sub !== "serve") {
    console.log("usage: saw vault serve [--port 3000] [--public-url https://...] [--auto-approve]");
    return;
  }
  const port = Number(flag("--port") ?? process.env.PORT ?? 3000);
  const publicUrl = (flag("--public-url") ?? process.env.SAW_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  if (!args.includes("--auto-approve") && !readPolicy().requirePairingApproval) patchPolicy({ requirePairingApproval: true });
  const server = createServer(createHandler({ publicUrl }));
  server.listen(port, () => {
    console.error(`saw vault listening on ${publicUrl}  (cluster ${cluster()}, home ${home()})`);
    console.error(`owner console: ${publicUrl}/   owner token: ${process.env.SAW_OWNER_TOKEN ? "from SAW_OWNER_TOKEN" : ownerTokenFile()}`);
    console.error(`agents: SAW_VAULT_URL=${publicUrl} saw auth signin   |   claude.ai connector: ${publicUrl}/mcp (Authorization: Bearer <session token>)`);
  });
}
