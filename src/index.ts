#!/usr/bin/env node
// solana-pay-mcp: let Claude invoice, get paid, and pay in USDC on Solana.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";

import { type PaymentRequest, solanaPayUrl, toBaseUnits } from "./pay.js";
import * as store from "./store.js";
import * as contacts from "./contacts.js";
import { cluster, explorerUrl, findPayment, newReference, recipient } from "./solana.js";
import { dailyCapUnits, execute, keygen, signerAddress, signerPath, spentLast24h } from "./signer.js";
import { fromBaseUnits } from "./pay.js";

// `solana-pay-mcp keygen` writes a new agent keypair and exits. Never prints the secret.
if (process.argv[2] === "keygen") {
  const addr = await keygen(process.argv[3]);
  console.log(`Agent key created. Address: ${addr}`);
  console.log(`Fund it with a little SOL (fees) and USDC, then set SOLANA_PAY_SIGNER=<path> and SOLANA_PAY_DAILY_CAP=<usdc>.`);
  process.exit(0);
}

const server = new McpServer({ name: "solana-pay-mcp", version: "0.1.0" });

const amountSchema = z
  .string()
  .describe('USDC amount as a decimal string, e.g. "3000" or "12.50"')
  .refine((a) => {
    try {
      return toBaseUnits(a) > 0n;
    } catch {
      return false;
    }
  }, "amount must be a positive USDC decimal with at most 6 decimals");

async function present(req: PaymentRequest, verb: string) {
  const url = solanaPayUrl(req);
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `${verb} ${req.amount} USDC on ${req.cluster} (id ${req.id})`,
          `To: ${req.recipient}`,
          `Memo: ${req.memo}`,
          `Pay link (open in Phantom/Solflare/Backpack): ${url}`,
          "",
          qr,
          `Then run check_payment with id ${req.id}.`,
        ].join("\n"),
      },
    ],
    structuredContent: { ...req, url },
  };
}

server.registerTool(
  "create_invoice",
  {
    title: "Create USDC invoice",
    description:
      "Create an invoice your client pays in USDC on Solana. Returns a Solana Pay link and QR. " +
      "Money goes straight to SOLANA_PAY_RECIPIENT (your wallet). Follow with check_payment.",
    inputSchema: { amount: amountSchema, memo: z.string().min(1).max(120).describe("What it is for") },
  },
  async ({ amount, memo }) => {
    const req: PaymentRequest = {
      id: `inv_${randomUUID().slice(0, 8)}`,
      kind: "invoice",
      recipient: recipient(),
      amount,
      memo,
      reference: await newReference(),
      cluster: cluster(),
      createdAt: new Date().toISOString(),
    };
    store.put(req);
    return present(req, "Invoice for");
  },
);

server.registerTool(
  "send_payment",
  {
    title: "Pay someone in USDC",
    description:
      "Pay a person or business in USDC on Solana. " +
      "With an agent signer configured (SOLANA_PAY_SIGNER), call once to get a preview, then call again with " +
      "confirm=true to sign and send within the daily cap. Without a signer, returns a Solana Pay link/QR you approve in your own wallet.",
    inputSchema: {
      to: z.string().describe("Saved contact name (e.g. 'kevin') or a Solana wallet address"),
      amount: amountSchema,
      memo: z.string().min(1).max(120).describe("What it is for"),
      confirm: z.boolean().optional().describe("Set true to actually sign and send from the agent wallet"),
    },
  },
  async ({ to, amount, memo, confirm }) => {
    const req: PaymentRequest = {
      id: `pay_${randomUUID().slice(0, 8)}`,
      kind: "payment",
      recipient: contacts.resolve(to),
      amount,
      memo,
      reference: await newReference(),
      cluster: cluster(),
      createdAt: new Date().toISOString(),
    };
    if (!signerPath()) {
      store.put(req);
      return present(req, "Payment of");
    }
    const from = await signerAddress();
    const cap = fromBaseUnits(dailyCapUnits());
    const spent = fromBaseUnits(spentLast24h());
    if (!confirm) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `PREVIEW, nothing sent.`,
              `Pay ${amount} USDC to ${to} on ${req.cluster}`,
              `From agent wallet ${from}`,
              `Memo: ${memo}`,
              `Daily cap ${cap} USDC, spent ${spent} in last 24h.`,
              `Call send_payment again with the same arguments and confirm=true to send.`,
            ].join("\n"),
          },
        ],
        structuredContent: { ...req, from, cap, spent, preview: true },
      };
    }
    store.put(req);
    const done = await execute(req);
    req.paidTx = done.tx;
    req.paidAt = new Date().toISOString();
    req.matchedBy = "signer";
    store.put(req);
    return {
      content: [
        {
          type: "text" as const,
          text: `SENT. ${amount} USDC to ${to} from ${done.from}. Remaining daily cap ${done.remainingCap} USDC.\n${explorerUrl(done.tx)}`,
        },
      ],
      structuredContent: { ...req, from: done.from, remainingCap: done.remainingCap },
    };
  },
);

server.registerTool(
  "pay_many",
  {
    title: "Pay several people in USDC",
    description:
      "Batch payments from the agent wallet: payroll, bounties, splits. Each item is a contact name or address plus amount. " +
      "Call once for a preview (total vs daily cap), then again with confirm=true to send. One transaction per recipient.",
    inputSchema: {
      payments: z
        .array(z.object({ to: z.string(), amount: amountSchema, memo: z.string().min(1).max(120) }))
        .min(1)
        .max(200),
      confirm: z.boolean().optional(),
    },
  },
  async ({ payments, confirm }) => {
    if (!signerPath()) throw new Error("pay_many needs an agent signer. Run `solana-pay-mcp keygen` and set SOLANA_PAY_SIGNER.");
    const reqs: PaymentRequest[] = [];
    for (const p of payments) {
      reqs.push({
        id: `pay_${randomUUID().slice(0, 8)}`,
        kind: "payment",
        recipient: contacts.resolve(p.to),
        amount: p.amount,
        memo: p.memo,
        reference: await newReference(),
        cluster: cluster(),
        createdAt: new Date().toISOString(),
      });
    }
    const total = reqs.reduce((a, r) => a + toBaseUnits(r.amount), 0n);
    const left = dailyCapUnits() - spentLast24h();
    const rows = payments.map((p, i) => `${p.amount} USDC → ${p.to} (${reqs[i].recipient.slice(0, 6)}…) ${p.memo}`);
    if (!confirm) {
      const over = total > left ? `\nOVER CAP: only ${fromBaseUnits(left)} USDC left today.` : "";
      return {
        content: [{ type: "text" as const, text: `PREVIEW, nothing sent.\n${rows.join("\n")}\nTotal ${fromBaseUnits(total)} USDC, ${fromBaseUnits(left)} USDC left in daily cap.${over}\nCall again with confirm=true to send.` }],
      };
    }
    // ponytail: sequential, one tx each; batch several transfers per tx if payroll > ~50 rows gets slow.
    const out: string[] = [];
    for (const req of reqs) {
      store.put(req);
      try {
        const done = await execute(req);
        req.paidTx = done.tx;
        req.paidAt = new Date().toISOString();
        req.matchedBy = "signer";
        store.put(req);
        out.push(`SENT ${req.amount} USDC → ${req.recipient.slice(0, 6)}… ${explorerUrl(done.tx)}`);
      } catch (e) {
        out.push(`FAILED ${req.amount} USDC → ${req.recipient.slice(0, 6)}…: ${(e as Error).message}`);
        break; // stop on first failure (cap, no funds); nothing after it is attempted
      }
    }
    return { content: [{ type: "text" as const, text: out.join("\n") }] };
  },
);

server.registerTool(
  "add_contact",
  {
    title: "Save a contact",
    description: "Save a name for a wallet address so you can say 'pay kevin 5 USDC'.",
    inputSchema: { name: z.string().min(1).max(40), address: z.string() },
  },
  async ({ name, address: addr }) => {
    contacts.save(name, addr);
    return { content: [{ type: "text" as const, text: `Saved ${name.toLowerCase()} → ${addr}` }] };
  },
);

server.registerTool(
  "list_contacts",
  { title: "List contacts", description: "Saved names and their wallet addresses." },
  async () => {
    const c = contacts.all();
    const text = Object.keys(c).length ? Object.entries(c).map(([n, a]) => `${n} → ${a}`).join("\n") : "No contacts yet.";
    return { content: [{ type: "text" as const, text }] };
  },
);

server.registerTool(
  "wallet_status",
  { title: "Agent wallet status", description: "Which wallet receives invoices, whether an agent signer is configured, its address, and the daily cap." },
  async () => {
    const lines = [`Cluster: ${cluster()}`, `Invoices paid to: ${recipient()}`];
    if (signerPath()) {
      lines.push(`Agent signer: ${await signerAddress()}`);
      lines.push(`Daily cap: ${fromBaseUnits(dailyCapUnits())} USDC, spent last 24h: ${fromBaseUnits(spentLast24h())} USDC`);
    } else {
      lines.push("Agent signer: none. Payments return a QR for your own wallet. Run `solana-pay-mcp keygen` to enable.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "check_payment",
  {
    title: "Check if an invoice or payment settled",
    description: "Look on-chain for a USDC transfer matching the request. Works for invoices and payments.",
    inputSchema: { id: z.string().describe("Invoice or payment id, e.g. inv_1a2b3c4d") },
  },
  async ({ id }) => {
    const req = store.get(id);
    if (!req) return { content: [{ type: "text", text: `No request with id ${id}.` }], isError: true };
    if (!req.paidTx) {
      const found = await findPayment(req);
      if (found) {
        req.matchedBy = found.matchedBy;
        req.paidTx = found.tx;
        req.paidAt = found.blockTime ? new Date(found.blockTime * 1000).toISOString() : new Date().toISOString();
        store.put(req);
      }
    }
    const text = req.paidTx
      ? `PAID. ${req.amount} USDC to ${req.recipient} at ${req.paidAt}` +
        (req.matchedBy === "inflow" ? " (matched by inflow: the wallet dropped the reference key)" : "") +
        `.\n${explorerUrl(req.paidTx)}`
      : `UNPAID. No USDC transfer of ${req.amount} to ${req.recipient} found yet (reference ${req.reference}).`;
    return { content: [{ type: "text", text }], structuredContent: { ...req, paid: Boolean(req.paidTx) } };
  },
);

server.registerTool(
  "list_requests",
  { title: "List invoices and payments", description: "All requests this server created, newest last." },
  async () => {
    const rows = store.all();
    const text = rows.length
      ? rows.map((r) => `${r.id} ${r.kind} ${r.amount} USDC → ${r.recipient.slice(0, 6)}… ${r.paidTx ? "PAID" : "unpaid"} ${r.memo}`).join("\n")
      : "No requests yet.";
    return { content: [{ type: "text", text }], structuredContent: { requests: rows } };
  },
);

await server.connect(new StdioServerTransport());
