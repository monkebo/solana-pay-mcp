#!/usr/bin/env node
// solana-pay-mcp: let Claude invoice, get paid, and pay in USDC/SOL on Solana.
//   solana-pay-mcp            stdio (Claude Code, Claude Desktop)
//   solana-pay-mcp serve      HTTP at /mcp/$SOLANA_PAY_HTTP_SECRET (claude.ai connectors, phone)
//   solana-pay-mcp keygen     create the agent keypair
import { createServer as createHttp } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { keygen } from "./signer.js";

const cmd = process.argv[2];

if (cmd === "keygen") {
  const addr = await keygen(process.argv[3]);
  console.log(`Agent key created. Address: ${addr}`);
  console.log(`Fund it with a little SOL (fees) and USDC, then set SOLANA_PAY_SIGNER=<path> and SOLANA_PAY_DAILY_CAP=<usdc>.`);
  process.exit(0);
}

if (cmd === "serve") {
  const secret = process.env.SOLANA_PAY_HTTP_SECRET;
  if (!secret || secret.length < 16) throw new Error("Set SOLANA_PAY_HTTP_SECRET (>=16 chars). It is the only thing between the internet and your agent wallet.");
  const port = Number(process.env.PORT ?? 3000);
  const path = `/mcp/${secret}`;
  createHttp(async (req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    // Stateless: one server + transport per request. Claude.ai reconnects freely; nothing to keep alive.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    try {
      await createServer().connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }).listen(port, () => console.error(`solana-pay-mcp listening on http://localhost:${port}${path}`));
} else {
  await createServer().connect(new StdioServerTransport());
}
