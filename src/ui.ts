// Builds the MCP App HTML once: ui/wallet.html with the ext-apps App bundle inlined (the host iframe CSP blocks CDNs).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let cached: string | undefined;

export function walletHtml(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  // The bundle is an ES module ending in `export{...,X as App}`. Swap the export for a global.
  const m = /export\s*\{([^}]*)\};?\s*$/.exec(bundle);
  const appName = m && /(\w+|\$\w*) as App\b/.exec(m[1])?.[1];
  if (!m || !appName) throw new Error("Unexpected ext-apps bundle shape; cannot inline App");
  const inlined = bundle.slice(0, m.index) + `globalThis.__McpExtApp=${appName};`;
  const page = readFileSync(new URL("../ui/wallet.html", import.meta.url), "utf8");
  cached = page.replace("/*__APP_BUNDLE__*/", () => inlined);
  return cached;
}
