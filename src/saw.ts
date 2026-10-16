#!/usr/bin/env node
// saw: Solana Agentic Wallet CLI. `saw help` lists commands; every command supports --json.
import { runCli } from "./cli/main.js";

const cmd = process.argv[2];
if (cmd === "mcp") {
  const { startStdio } = await import("./mcp.js");
  await startStdio();
} else if (cmd === "vault") {
  const { startVault } = await import("./vault.js");
  await startVault(process.argv.slice(3));
} else {
  process.exitCode = await runCli(process.argv.slice(2));
}
