#!/usr/bin/env node
// solana-pay-mcp: compatibility entry. The wallet lives in `saw`; this keeps the original commands working.
//   solana-pay-mcp            MCP over stdio (Claude Code, Claude Desktop)   == saw mcp
//   solana-pay-mcp serve      vault + MCP over HTTP (claude.ai connectors)   == saw vault serve
//   solana-pay-mcp keygen     create the local key                           == saw owner keygen
import { runCli } from "./cli/main.js";

const cmd = process.argv[2];
if (cmd === "serve") {
  const { startVault } = await import("./vault.js");
  await startVault(process.argv.slice(3));
} else if (cmd === "keygen") {
  process.exitCode = await runCli(["owner", "keygen", ...process.argv.slice(3)]);
} else {
  const { startStdio } = await import("./mcp.js");
  await startStdio();
}
