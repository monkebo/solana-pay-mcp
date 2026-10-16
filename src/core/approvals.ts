// Token approvals on Solana = SPL token-account delegates. One delegate per token account, with an amount.
import { address, type Address, type Signature } from "@solana/kit";
import { getRevokeInstruction } from "@solana-program/token";
import type { Ctx } from "./ctx.js";
import { CHAIN_ID } from "./config.js";
import { fromUnits, known, jupiterTokenInfo, TOKEN_2022_PROGRAM_ADDRESS } from "./tokens.js";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { tokenAccounts } from "./view.js";
import { prices, fmtUsd } from "./prices.js";
import { loadSigner } from "./signer.js";
import { WalletError } from "./errors.js";

const U64_MAX = (1n << 64n) - 1n;

export interface Approval {
  tokenSymbol: string;
  tokenContract: string;
  tokenDecimals: number;
  tokenAccount: string;
  spender: string;
  spenderName: string | null;
  spenderIcon: null;
  amount: string; // "unlimited" or decimal
  amountRaw: string;
  riskyLevel: "low" | "medium" | "high";
  riskyMsg: string | null;
  binanceChainId: string;
  chainName: "Solana";
  type: "delegate";
  program: "token" | "token-2022";
  noInteractive: null;
  approveTime: null;
}

export async function listApprovals(ctx: Ctx, owner: Address, filter: { spender?: string } = {}): Promise<Approval[]> {
  const out: Approval[] = [];
  const unknown: string[] = [];
  for (const { program, rows } of await tokenAccounts(ctx, owner)) {
    for (const r of rows) {
      const info = r.account.data.parsed.info;
      if (!info.delegate) continue;
      if (filter.spender && info.delegate !== filter.spender) continue;
      const raw = BigInt(info.delegatedAmount?.amount ?? "0");
      const unlimited = raw >= U64_MAX / 2n;
      if (!known(info.mint)) unknown.push(info.mint);
      out.push({
        tokenSymbol: known(info.mint)?.symbol ?? info.mint.slice(0, 4) + "…",
        tokenContract: info.mint,
        tokenDecimals: info.tokenAmount.decimals,
        tokenAccount: r.pubkey,
        spender: info.delegate,
        spenderName: null,
        spenderIcon: null,
        amount: unlimited ? "unlimited" : fromUnits(raw, info.tokenAmount.decimals),
        amountRaw: raw.toString(),
        riskyLevel: unlimited ? "high" : "low",
        riskyMsg: unlimited ? "Unlimited delegation: the spender can move the entire balance of this token account." : null,
        binanceChainId: CHAIN_ID,
        chainName: "Solana",
        type: "delegate",
        program,
        noInteractive: null,
        approveTime: null,
      });
    }
  }
  await Promise.all(
    [...new Set(unknown)].slice(0, 20).map(async (m) => {
      const t = await jupiterTokenInfo(ctx, m).catch(() => null);
      if (t?.symbol) for (const a of out) if (a.tokenContract === m) a.tokenSymbol = t.symbol;
    }),
  );
  return out;
}

export async function approvalDetail(ctx: Ctx, owner: Address, tokenContract: string, spender: string) {
  const list = await listApprovals(ctx, owner, { spender });
  const a = list.find((x) => x.tokenContract === tokenContract);
  if (!a) throw new WalletError("TARGET_NOT_FOUND", `No active delegation of ${tokenContract} to ${spender}.`);
  const px = (await prices(ctx, [tokenContract]))[tokenContract];
  let balance = "0";
  for (const { rows } of await tokenAccounts(ctx, owner)) for (const r of rows) if (r.pubkey === a.tokenAccount) balance = fromUnits(BigInt(r.account.data.parsed.info.tokenAmount.amount), a.tokenDecimals);
  // History: approve/revoke instructions on this token account.
  const records: { txHash: string; action: string; amount: string; timestamp: number | null; status: "confirmed" | "failed" }[] = [];
  try {
    const sigs = await ctx.rpc.getSignaturesForAddress(address(a.tokenAccount), { limit: 20 }).send();
    for (const s of sigs) {
      const tx = (await ctx.rpc.getTransaction(s.signature as Signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }).send()) as unknown as {
        meta: { err: unknown } | null;
        transaction: { message: { instructions: { program?: string; parsed?: { type: string; info?: { amount?: string; tokenAmount?: { amount: string } } } }[] } };
      } | null;
      if (!tx) continue;
      for (const ix of tx.transaction.message.instructions) {
        if (!ix.parsed || !/^approve|^revoke/.test(ix.parsed.type)) continue;
        const amt = ix.parsed.info?.tokenAmount?.amount ?? ix.parsed.info?.amount;
        records.push({
          txHash: s.signature,
          action: ix.parsed.type.startsWith("revoke") ? "revoke" : "approve",
          amount: amt ? (BigInt(amt) >= U64_MAX / 2n ? "unlimited" : fromUnits(BigInt(amt), a.tokenDecimals)) : "-",
          timestamp: s.blockTime === null ? null : Number(s.blockTime) * 1000,
          status: tx.meta?.err ? "failed" : "confirmed",
        });
      }
      if (records.length >= 20) break;
    }
  } catch {
    /* history is best effort */
  }
  return { detail: { ...a, balance, price: px === null ? null : String(px), balanceUsd: px === null ? null : fmtUsd(Number(balance) * px), permit2ContractAddress: null, expireTime: null }, records };
}

export async function revokeInstruction(ctx: Ctx, owner: Address, tokenContract: string, spender: string) {
  const a = (await listApprovals(ctx, owner, { spender })).find((x) => x.tokenContract === tokenContract);
  if (!a) throw new WalletError("TARGET_NOT_FOUND", `No active delegation of ${tokenContract} to ${spender}.`);
  const signer = await loadSigner();
  const programAddress = a.program === "token-2022" ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;
  return { approval: a, ix: getRevokeInstruction({ source: address(a.tokenAccount), owner: signer }, { programAddress }) };
}
