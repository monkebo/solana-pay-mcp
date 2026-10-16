import { z } from "zod";
import { define, optNum, optStr, str } from "../core/registry.js";
import { gated, isPending } from "../core/gate.js";
import { decodeSettlement, loadX402, previewX402, signX402, x402Previews } from "../core/x402.js";
import { WalletError } from "../core/errors.js";
import { orders } from "../core/orders.js";

define({
  name: "x402-payment.preview",
  cli: "x402-payment preview",
  title: "Preview x402 payment options",
  description: "Parse a merchant's PaymentRequired (base64 PAYMENT-REQUIRED header or raw JSON) and rank the options: READY_TO_SIGN, ACTION_REQUIRED (e.g. insufficient balance), NOT_SIGNABLE (other chains, over x402 daily limit, token not allowed).",
  access: "session",
  write: false,
  params: { paymentRequirements: str("PaymentRequired JSON or base64 header value") },
  async run(ctx, { paymentRequirements }) {
    return previewX402(ctx, paymentRequirements);
  },
});

async function signOption(ctx: Parameters<typeof signX402>[0], paymentId: string, selectedIndex: number, orderId?: string) {
  const p = loadX402(paymentId);
  const opt = p.options.find((o) => o.index === selectedIndex);
  if (!opt) throw new WalletError("INVALID_PARAM", `selectedIndex ${selectedIndex} is not one of the preview options (1..${p.options.length}).`);
  if (opt.status === "NOT_SIGNABLE") throw new WalletError("NOT_SUPPORTED", `Option ${selectedIndex} cannot be signed: ${opt.reasons.join(", ")}.`);
  if (opt.status === "ACTION_REQUIRED") throw new WalletError("INSUFFICIENT_BALANCE", `Option ${selectedIndex} needs ${opt.amount} ${opt.tokenSymbol}; balance is ${opt.currentBalance}. Top up or swap first.`);
  const usd = Number(opt.amountUsd ?? 0);
  return gated(ctx, {
    orderId,
    kind: "x402",
    category: "x402",
    usd,
    summary: `x402 pay ${opt.amount} ${opt.tokenSymbol} to ${opt.payTo}${p.resource?.url ? ` for ${p.resource.url}` : ""}`,
    details: { paymentId, selectedIndex, resource: p.resource?.url ?? null, payTo: opt.payTo, amount: opt.amount, token: opt.tokenSymbol, tokenAddress: opt.tokenAddress, amountUsd: usd },
    command: "x402-payment.sign",
    params: { paymentId, selectedIndex },
    reasons: [],
    needsLock: false,
    async execute() {
      const s = await signX402(ctx, p, opt);
      x402Previews.remove(p.id);
      return { status: "COMPLETED", details: { signatureExpiresAt: s.signatureExpiresAt }, result: { ...s, approveTxHash: null, binanceChainId: null, orderId: "" } };
    },
  });
}

define({
  name: "x402-payment.sign",
  cli: "x402-payment sign",
  title: "Sign an x402 payment option",
  description: "Sign the selected option from preview. Returns the header to replay the original request with (PAYMENT-SIGNATURE for v2, X-PAYMENT for v1). One use, valid ~60 s; the merchant settles it. Counts against the x402 daily limit.",
  access: "session",
  write: true,
  params: { paymentId: str("From preview"), selectedIndex: z.coerce.number().int().min(1).describe("1-based option index"), orderId: optStr("internal") },
  async run(ctx, p) {
    const r = await signOption(ctx, p.paymentId, p.selectedIndex, p.orderId);
    if (isPending(r)) return { orderId: r.orderId, status: "PENDING_CONFIRMATION", message: r.message };
    return r;
  },
});

define({
  name: "x402-payment.pay",
  cli: "x402-payment pay",
  title: "Fetch a paid resource end to end",
  description: "Request a URL; on HTTP 402 preview the options, sign the best READY_TO_SIGN one (within policy) and replay with the payment header. Returns the response body (truncated) and the decoded settlement header. Confirm with the user before running: it spends.",
  access: "session",
  write: true,
  params: { url: str("Resource URL"), method: z.enum(["GET", "POST"]).optional(), body: optStr("Request body for POST"), maxChars: optNum("Max response characters returned (default 4000)") },
  async run(ctx, { url, method, body, maxChars }) {
    const init: RequestInit = { method: method ?? "GET", headers: { accept: "application/json, text/plain, */*", ...(body ? { "content-type": "application/json" } : {}) }, body, signal: AbortSignal.timeout(30_000) };
    const first = await ctx.fetch(url, init);
    const cut = (s: string) => s.slice(0, maxChars ?? 4000);
    if (first.status !== 402) return { status: first.status, paid: false, body: cut(await first.text()) };
    const hdr = first.headers.get("payment-required") ?? first.headers.get("x-payment-required");
    const text = await first.text();
    const pv = await previewX402(ctx, hdr ?? text);
    const ready = pv.options.find((o) => o.status === "READY_TO_SIGN");
    if (!ready) throw new WalletError("NOT_SUPPORTED", `No signable payment option for ${url}. Options: ${pv.options.map((o) => `${o.index}:${o.status}(${o.reasons.join("/")})`).join(", ")}.`, { preview: pv });
    const signed = await signOption(ctx, pv.paymentId, ready.index);
    if (isPending(signed)) return { status: 402, paid: false, pending: signed };
    const s = signed as { paymentHeaderName: string; paymentHeaderValue: string; orderId: string };
    const second = await ctx.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), [s.paymentHeaderName]: s.paymentHeaderValue } });
    const settlement = decodeSettlement(second.headers.get("payment-response") ?? second.headers.get("x-payment-response"));
    const o = orders.get(s.orderId);
    if (o && settlement && typeof settlement.transaction === "string") orders.update(o.id, { txHash: settlement.transaction as string });
    return { status: second.status, paid: second.ok, orderId: s.orderId, amount: ready.amount, token: ready.tokenSymbol, amountUsd: ready.amountUsd, settlement, body: cut(await second.text()) };
  },
});

define({
  name: "x402-payment.list",
  cli: "x402-payment list",
  title: "x402 payments made",
  description: "Payments signed by this wallet with amounts and settlement signatures when known.",
  access: "session",
  write: false,
  params: { limit: optNum("Default 20") },
  async run(_ctx, { limit }) {
    return orders
      .all()
      .filter((o) => o.kind === "x402")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit ?? 20)
      .map((o) => ({ orderId: o.id, status: o.status, ...o.details, txHash: o.txHash, createdAt: new Date(o.createdAt).toISOString() }));
  },
});
