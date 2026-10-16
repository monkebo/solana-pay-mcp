import { z } from "zod";
import { define, optNum, optStr, str } from "../core/registry.js";
import { gated, isPending } from "../core/gate.js";
import { assertDevMode, loadPreview, previewContractCall, previewSignMessage, previews, signMessageNow, signatures } from "../core/external.js";
import { sendWire } from "../core/tx.js";
import { explorerUrl } from "../core/config.js";
import { orders } from "../core/orders.js";
import { WalletError } from "../core/errors.js";

define({
  name: "contract-call.preview",
  cli: "contract-call preview",
  title: "Preview an external transaction",
  description: "Developer mode. Decode, simulate and risk-score an unsigned base64 transaction built by a dApp or SDK: programs called, balance changes, authority changes. Returns a requestId for execute (10 minutes).",
  access: "session",
  write: false,
  params: { binanceChainId: optStr("Ignored"), from: optStr("Must be this wallet's address if given"), unsignedTx: str("Unsigned transaction, base64"), to: optStr("EVM only; ignored"), value: optStr("EVM only; ignored"), inputData: optStr("EVM only; ignored"), gasLimit: optStr("EVM only; rejected") },
  async run(ctx, p) {
    if (p.gasLimit !== undefined) throw new WalletError("INVALID_PARAM", "--gasLimit is EVM-only; Solana compute is sized from simulation.");
    return previewContractCall(ctx, p.unsignedTx, p.from);
  },
});

define({
  name: "contract-call.execute",
  cli: "contract-call execute",
  title: "Execute a previewed transaction",
  description: "Sign and broadcast a transaction previewed with contract-call preview. Counts the simulated USD outflow against the developer-mode daily limit; risky previews wait for owner confirmation.",
  access: "session",
  write: true,
  params: { requestId: str("From contract-call preview"), orderId: optStr("internal") },
  async run(ctx, p) {
    assertDevMode();
    const pv = loadPreview(p.requestId, "contract-call");
    const r = await gated(ctx, {
      orderId: p.orderId,
      kind: "contract-call",
      category: "devMode",
      usd: pv.usd,
      summary: `external transaction (${(pv.result.parsedTx as { instructions: unknown[] }).instructions.length} instructions, $${pv.usd.toFixed(2)} out)`,
      details: { requestId: pv.id, balanceChanges: (pv.result.simulationResult as { balanceChanges: unknown }).balanceChanges },
      command: "contract-call.execute",
      params: { requestId: p.requestId },
      reasons: pv.reasons,
      async execute() {
        const b = await sendWire(ctx, pv.payload.unsignedTx as string);
        previews.remove(pv.id);
        return { txHash: b.signature, signedTx: b.signedTx, lastValidBlockHeight: b.lastValidBlockHeight, result: { orderId: "", status: "BROADCASTED", txHash: b.signature, explorer: explorerUrl(b.signature), message: null } };
      },
    });
    if (isPending(r)) return { orderId: r.orderId, status: "PENDING_CONFIRMATION", txHash: null, message: r.message };
    return r;
  },
});

define({
  name: "sign-message.preview",
  cli: "sign-message preview",
  title: "Preview a message signature",
  description: "Developer mode. Parse a message to sign: SOLANA_OFFCHAIN (the Solana off-chain message standard, safe by construction) or RAW (plain bytes, what most dApps' signMessage uses). Returns a requestId for execute.",
  access: "session",
  write: false,
  params: { binanceChainId: optStr("Ignored"), message: str("Message text (or JSON string)"), signType: z.enum(["SOLANA_OFFCHAIN", "RAW", "EIP712"]).optional().describe("SOLANA_OFFCHAIN (default) | RAW"), applicationDomain: optStr("Off-chain standard application domain (base58, 32 bytes)") },
  async run(ctx, p) {
    if (p.signType === "EIP712") throw new WalletError("UNSUPPORTED_ON_SOLANA", "EIP-712 is an Ethereum format. Use SOLANA_OFFCHAIN or RAW.");
    return previewSignMessage(ctx, p.message, p.signType ?? "SOLANA_OFFCHAIN", p.applicationDomain);
  },
});

define({
  name: "sign-message.execute",
  cli: "sign-message execute",
  title: "Sign a previewed message",
  description: "Produce the signature for a message previewed with sign-message preview. Risky previews wait for owner confirmation; fetch the result later with sign-message result.",
  access: "session",
  write: true,
  params: { requestId: str("From sign-message preview"), orderId: optStr("internal") },
  async run(ctx, p) {
    assertDevMode();
    const pv = loadPreview(p.requestId, "sign-message");
    const r = await gated(ctx, {
      orderId: p.orderId,
      kind: "sign-message",
      category: "devMode",
      usd: 0,
      summary: `sign message (${(pv.payload.signType as string) ?? "SOLANA_OFFCHAIN"}): ${String(pv.payload.message).slice(0, 60)}`,
      details: { requestId: pv.id },
      command: "sign-message.execute",
      params: { requestId: p.requestId },
      reasons: pv.reasons,
      needsLock: false,
      async execute() {
        const ordId = orders.all().find((o) => o.kind === "sign-message" && o.status === "BROADCASTED" && (o.details as { requestId?: string }).requestId === pv.id)?.id ?? p.orderId ?? pv.id;
        const s = await signMessageNow(pv.payload as never, ordId);
        previews.remove(pv.id);
        return { status: "COMPLETED", details: { signatureBase58: s.signatureBase58 }, result: { orderId: ordId, status: "COMPLETED", ...s, signatureRecovery: null, message: null } };
      },
    });
    if (isPending(r)) return { orderId: r.orderId, status: "PENDING_CONFIRMATION", signature: null, signatureRecovery: null, message: r.message };
    return r;
  },
});

define({
  name: "sign-message.result",
  cli: "sign-message result",
  title: "Fetch a signature result",
  description: "Status of a sign-message order: COMPLETED with the signature, PENDING_CONFIRMATION, REJECTED or EXPIRED.",
  access: "session",
  write: false,
  params: { orderId: str("Order id from sign-message execute") },
  async run(_ctx, { orderId }) {
    const o = orders.get(orderId);
    if (!o || o.kind !== "sign-message") throw new WalletError("TARGET_NOT_FOUND", `No sign-message order ${orderId}.`);
    const rec = signatures.get(orderId);
    const status = o.status === "COMPLETED" ? "COMPLETED" : o.status === "PENDING_CONFIRMATION" ? "PENDING_CONFIRMATION" : o.status === "REJECTED" ? "REJECTED" : o.status === "EXPIRED" ? "EXPIRED" : o.status;
    return { orderId, status, signature: rec?.signatureHex ?? null, signatureBase58: rec?.signatureHash ?? null, signatureRecovery: null, message: o.error ?? null };
  },
});

define({
  name: "sign-message.history",
  cli: "sign-message history",
  title: "Signature history",
  description: "Messages this wallet has signed.",
  access: "session",
  write: false,
  params: { binanceChainId: optStr("Ignored"), limit: optNum("Default 20"), nextToken: optStr("Pagination cursor (signatureTime)"), startTime: optNum("ms"), endTime: optNum("ms"), sortType: z.enum(["ASC", "DESC"]).optional() },
  async run(_ctx, q) {
    let items = signatures.all();
    if (q.startTime) items = items.filter((s) => s.signatureTime >= q.startTime!);
    if (q.endTime) items = items.filter((s) => s.signatureTime <= q.endTime!);
    items.sort((a, b) => (q.sortType === "ASC" ? a.signatureTime - b.signatureTime : b.signatureTime - a.signatureTime));
    if (q.nextToken) items = items.filter((s) => (q.sortType === "ASC" ? s.signatureTime > Number(q.nextToken) : s.signatureTime < Number(q.nextToken)));
    const limit = q.limit ?? 20;
    const page = items.slice(0, limit);
    return { nextToken: items.length > limit ? String(page[page.length - 1].signatureTime) : null, items: page.map((s) => ({ ...s, spenderAddress: null, spenderLabel: null, tokenPermits: null, signatureDeadline: null })) };
  },
});
