import { z } from "zod";
import { amount, define, optBool, optStr, str } from "../core/registry.js";
import { prepareSend, sendDetails } from "../core/send.js";
import { gated } from "../core/gate.js";
import { sendInstructions, broadcastWire } from "../core/tx.js";
import { explorerUrl } from "../core/config.js";
import { orders, setOrder } from "../core/orders.js";
import { WalletError } from "../core/errors.js";
import { refreshPending } from "../core/track.js";

export const gasLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Priority fee tier (default MEDIUM)");

define({
  name: "wallet.send",
  cli: "wallet send",
  title: "Send tokens",
  description:
    "Transfer SOL or any SPL token to a saved contact or address. Enforces allowed tokens, per-payment and daily USD limits, " +
    "and address-book-only sends; risky transfers go to the owner for confirmation. Returns a txHash once broadcast (not yet confirmed).",
  access: "session",
  write: true,
  params: {
    amount: amount("Amount in human units, e.g. 1.5 (omit with --max)").optional(),
    max: optBool("Send the whole balance (SOL keeps a fee buffer)"),
    recipient: str("Saved contact name or Solana address"),
    tokenAddress: str("Mint address, or SOL / USDC / USDT"),
    binanceChainId: optStr("Ignored; Solana only"),
    gasLevel: gasLevelSchema,
    memo: optStr("On-chain memo, max 200 chars"),
    reference: optStr("Solana Pay reference account to attach (payee lookups)"),
    dryRun: optBool("Prepare and price the transfer without sending"),
    orderId: optStr("internal: replay of an approved order"),
  },
  async run(ctx, p) {
    const s = await prepareSend(ctx, p);
    const details = sendDetails(s);
    if (p.dryRun) return { ...details, memo: p.memo ?? null, reasons: s.reasons, wouldRequireConfirmation: s.reasons.length > 0 };
    return gated(ctx, {
      orderId: p.orderId,
      kind: "send",
      category: "general",
      usd: s.usd,
      summary: s.summary,
      details: { ...details, memo: p.memo ?? null },
      command: "wallet.send",
      params: { ...p, dryRun: undefined, orderId: undefined },
      reasons: s.reasons,
      async execute() {
        const b = await sendInstructions(ctx, s.instructions, { gasLevel: p.gasLevel });
        return {
          txHash: b.signature,
          signedTx: b.signedTx,
          lastValidBlockHeight: b.lastValidBlockHeight,
          result: { txHash: b.signature, status: "BROADCASTED", explorer: explorerUrl(b.signature), ...details, note: "Broadcast, not yet confirmed. Track with `wallet tx-history --tx <txHash>`." },
        };
      },
    });
  },
});

define({
  name: "wallet.speed-up",
  cli: "wallet speed-up",
  title: "Rebroadcast a pending transaction",
  description:
    "Resend a transaction this wallet broadcast that has not landed yet. Solana has no fee bumping of a signed transaction, so this rebroadcasts the same bytes while its blockhash is valid (~60–90 s); after that it has expired and must be sent again.",
  access: "session",
  write: true,
  positional: ["txHash"],
  params: { txHash: str("Signature of the pending transaction"), level: optStr("Accepted for compatibility; ignored on Solana"), binanceChainId: optStr("Ignored") },
  async run(ctx, { txHash }) {
    await refreshPending(ctx);
    const o = orders.all().find((x) => x.txHash === txHash);
    if (!o) throw new WalletError("TARGET_NOT_FOUND", `No transaction ${txHash} was broadcast by this wallet. Run \`wallet tx-history --type pending\`.`);
    if (o.status === "CONFIRMED") throw new WalletError("ALREADY_CONFIRMED", "That transaction is already confirmed; nothing to speed up.");
    if (o.status !== "BROADCASTED" || !o.signedTx) throw new WalletError("TX_STATUS_UNSUPPORTED", `Transaction is ${o.status}; it cannot be rebroadcast. ${o.error ?? ""}`.trim());
    const height = await ctx.rpc.getBlockHeight().send();
    if (o.lastValidBlockHeight !== undefined && Number(height) > o.lastValidBlockHeight) {
      setOrder(o.id, { status: "FAILED", error: "dropped: blockhash expired", signedTx: undefined });
      throw new WalletError("TX_STATUS_UNSUPPORTED", "The transaction's blockhash expired without landing; it is dropped. Send it again.");
    }
    await broadcastWire(ctx, o.signedTx);
    return { orderId: o.id, txHash, status: "SUBMITTED", note: "Rebroadcast the same signed transaction. Fees cannot be raised on Solana after signing." };
  },
});

define({
  name: "wallet.cancel",
  cli: "wallet cancel",
  title: "Cancel a pending transaction",
  description: "Not possible on Solana: there is no nonce replacement. A broadcast transaction either lands within its blockhash window (~60–90 s) or expires by itself. Returns a clear error.",
  access: "session",
  write: false,
  positional: ["txHash"],
  params: { txHash: str("Signature"), binanceChainId: optStr("Ignored") },
  async run(ctx, { txHash }) {
    await refreshPending(ctx);
    const o = orders.all().find((x) => x.txHash === txHash);
    if (o?.status === "CONFIRMED") throw new WalletError("ALREADY_CONFIRMED", "That transaction is already confirmed; it cannot be cancelled.");
    if (o && o.status !== "BROADCASTED") throw new WalletError("TX_STATUS_UNSUPPORTED", `Transaction is ${o.status}; nothing to cancel.`);
    throw new WalletError(
      "UNSUPPORTED_ON_SOLANA",
      "Solana transactions cannot be cancelled or replaced after broadcast: they land within their blockhash window (about 60–90 seconds) or expire on their own. Wait, then check `wallet tx-history --type pending`.",
      { txHash, pendingOrderId: o?.id ?? null },
    );
  },
});
