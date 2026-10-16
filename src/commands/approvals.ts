import { define, optStr, str } from "../core/registry.js";
import { walletAddress } from "../core/signer.js";
import { approvalDetail, listApprovals, revokeInstruction } from "../core/approvals.js";
import { gated } from "../core/gate.js";
import { sendInstructions } from "../core/tx.js";
import { explorerUrl } from "../core/config.js";

define({
  name: "approvals.list",
  cli: "approvals list",
  title: "List token approvals",
  description: "Token accounts that have a delegate (spender) set, with the delegated amount. Unlimited delegations are flagged high risk.",
  access: "session",
  write: false,
  params: { binanceChainId: optStr("Ignored; Solana only"), spender: optStr("Filter by delegate address") },
  async run(ctx, { spender }) {
    const list = await listApprovals(ctx, await walletAddress(), { spender });
    return { list, offset: 0, limit: list.length, total: list.length };
  },
});

define({
  name: "approvals.detail",
  cli: "approvals detail",
  title: "Approval details",
  description: "One delegation with the token balance, price and the approve/revoke history of that token account.",
  access: "session",
  write: false,
  params: { binanceChainId: optStr("Ignored"), tokenContract: str("Mint address"), spender: str("Delegate address"), type: optStr("Ignored; always delegate") },
  async run(ctx, { tokenContract, spender }) {
    return approvalDetail(ctx, await walletAddress(), tokenContract, spender);
  },
});

define({
  name: "approvals.revoke",
  cli: "approvals revoke",
  title: "Revoke an approval",
  description: "Remove a delegate from a token account. Broadcasts a Revoke instruction; the delegation stays active until the transaction confirms.",
  access: "session",
  write: true,
  params: { binanceChainId: optStr("Ignored"), tokenContract: str("Mint address"), spender: str("Delegate address"), type: optStr("Ignored"), orderId: optStr("internal") },
  async run(ctx, p) {
    const { approval, ix } = await revokeInstruction(ctx, await walletAddress(), p.tokenContract, p.spender);
    return gated(ctx, {
      orderId: p.orderId,
      kind: "revoke",
      category: "general",
      usd: 0,
      summary: `revoke ${approval.tokenSymbol} delegation to ${approval.spender}`,
      details: { tokenContract: p.tokenContract, spender: p.spender, tokenAccount: approval.tokenAccount },
      command: "approvals.revoke",
      params: { ...p, orderId: undefined },
      reasons: [],
      async execute() {
        const b = await sendInstructions(ctx, [ix], { gasLevel: "MEDIUM" });
        return { txHash: b.signature, signedTx: b.signedTx, lastValidBlockHeight: b.lastValidBlockHeight, result: { txHash: b.signature, status: "BROADCASTED", explorer: explorerUrl(b.signature), note: "Broadcast; the approval is active until confirmed." } };
      },
    });
  },
});
