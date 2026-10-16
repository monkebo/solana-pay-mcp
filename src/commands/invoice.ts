import { z } from "zod";
import QRCode from "qrcode";
import { amount, define, optNum, optStr, str } from "../core/registry.js";
import { createInvoice, invoiceView, invoices, rebuildFromChain, refreshInvoice } from "../core/invoice.js";
import { solanaPayUrl } from "../core/pay.js";
import { orders } from "../core/orders.js";
import { exec } from "../core/registry.js";
import { isPending } from "../core/gate.js";

define({
  name: "invoice.create",
  cli: "invoice create",
  title: "Create a USDC invoice",
  description: "Invoice a client in USDC on Solana. Returns a Solana Pay link and QR that any wallet can pay (Phantom, Solflare, Backpack, Binance). Money goes straight to this wallet (or SOLANA_PAY_RECIPIENT). Follow with `invoice status`.",
  access: "session",
  write: false,
  params: { amount: amount("USDC amount, e.g. 3000 or 12.50"), memo: str("What it is for (max 120 chars)") },
  async run(_ctx, { amount: amt, memo }) {
    const inv = await createInvoice(amt, memo.slice(0, 120));
    const url = solanaPayUrl(inv);
    return { ...invoiceView(inv), qrSvg: await QRCode.toString(url, { type: "svg", margin: 1 }), qrText: await QRCode.toString(url, { type: "terminal", small: true }) };
  },
});

define({
  name: "invoice.status",
  cli: "invoice status",
  title: "Check an invoice",
  description: "Look on-chain for the payment. UNPAID, CONFIRMED (seen) or SETTLED (finalized), with confidence exact (reference key) or probable (matching inflow) and the payer when identifiable.",
  access: "session",
  write: false,
  positional: ["id"],
  params: { id: str("Invoice id, e.g. inv_1a2b3c4d") },
  async run(ctx, { id }) {
    return invoiceView(await refreshInvoice(ctx, id));
  },
});

define({
  name: "invoice.list",
  cli: "invoice list",
  title: "List invoices",
  description: "All invoices with their settlement state.",
  access: "session",
  write: false,
  params: { limit: optNum("Default 50"), unpaid: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional() },
  async run(_ctx, { limit, unpaid }) {
    let list = invoices.all().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (unpaid) list = list.filter((i) => !i.paidTx);
    return list.slice(0, limit ?? 50).map(invoiceView);
  },
});

define({
  name: "ledger.rebuild",
  cli: "ledger rebuild",
  title: "Rebuild settlement state from the chain",
  description: "Drop cached settlement for every invoice and re-derive it from Solana. Lets anyone verify the ledger is not fabricated.",
  access: "session",
  write: false,
  params: {},
  async run(ctx) {
    return rebuildFromChain(ctx);
  },
});

define({
  name: "ledger.list",
  cli: "ledger list",
  title: "Ledger",
  description: "Everything this control plane did, across all backends: sends, swaps, orders, x402, external signatures, forwarded DeFi. Plus invoices received.",
  access: "session",
  write: false,
  params: { limit: optNum("Default 50"), kind: optStr("Filter by kind: send | swap | limit | x402 | contract-call | sign-message | defi | prediction | revoke"), backend: optStr("Filter by backend") },
  async run(_ctx, { limit, kind, backend }) {
    let out = orders.all().filter((o) => !kind || o.kind === kind).filter((o) => !backend || o.backend === backend);
    out = out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit ?? 50);
    return { out: out.map(({ action: _a, signedTx: _s, ...o }) => o), in: invoices.all().filter((i) => i.paidTx).map(invoiceView).slice(0, limit ?? 50) };
  },
});

define({
  name: "ledger.export",
  cli: "ledger export",
  title: "Export CSV",
  description: "CSV of outgoing orders and incoming invoices for a period, for accountants.",
  access: "session",
  write: false,
  params: { startTime: optNum("ms timestamp"), endTime: optNum("ms timestamp") },
  async run(_ctx, { startTime, endTime }) {
    const inRange = (t: number) => (!startTime || t >= startTime) && (!endTime || t <= endTime);
    const rows = [["direction", "id", "date", "kind", "status", "backend", "amountUsd", "summary", "txHash", "counterparty"]];
    for (const o of orders.all()) if (inRange(o.createdAt)) rows.push(["out", o.id, new Date(o.createdAt).toISOString(), o.kind, o.status, o.backend ?? "", String(o.usdValue ?? ""), o.summary, o.txHash ?? "", String((o.details as { recipient?: string }).recipient ?? "")]);
    for (const i of invoices.all()) if (i.paidTx && i.paidAt && inRange(Date.parse(i.paidAt))) rows.push(["in", i.id, i.paidAt, "invoice", i.settlement ?? "confirmed", "", i.amount, i.memo, i.paidTx, i.payerLabel ?? i.payer ?? ""]);
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return { csv: rows.map((r) => r.map(esc).join(",")).join("\n"), rows: rows.length - 1 };
  },
});

define({
  name: "wallet.pay-many",
  cli: "wallet pay-many",
  title: "Pay several people",
  description: "Batch payments: payroll, bounties, splits. Each item is a contact or address, an amount and a memo. Runs as sequential `wallet send`s under policy; stops at the first failure. Items needing owner confirmation are queued.",
  access: "session",
  write: true,
  params: {
    payments: z.preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.array(z.object({ to: z.string(), amount: z.string(), memo: z.string().optional() })).min(1).max(200)).describe("JSON array of {to, amount, memo}"),
    tokenAddress: optStr("Mint or SOL/USDC/USDT (default USDC)"),
    dryRun: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
  },
  async run(ctx, { payments, tokenAddress, dryRun }) {
    const rows: Record<string, unknown>[] = [];
    let total = 0;
    for (const p of payments) {
      try {
        const r = (await exec(ctx, "wallet.send", { amount: p.amount, recipient: p.to, tokenAddress: tokenAddress ?? "USDC", memo: p.memo, dryRun })) as Record<string, unknown>;
        total += Number(r.amountUsd ?? 0);
        rows.push({ to: p.to, amount: p.amount, memo: p.memo ?? null, status: isPending(r) ? "PENDING_CONFIRMATION" : dryRun ? "PREVIEW" : String(r.status), txHash: r.txHash ?? null, orderId: r.orderId ?? null, reasons: r.reasons ?? r.message ?? null });
        if (isPending(r)) break; // the lock holds until the owner decides
      } catch (e) {
        rows.push({ to: p.to, amount: p.amount, memo: p.memo ?? null, status: "FAILED", error: (e as Error).message });
        break;
      }
    }
    return { rows, totalUsd: Number(total.toFixed(2)), completed: rows.filter((r) => r.status === "BROADCASTED" || r.status === "PREVIEW").length, of: payments.length };
  },
});
