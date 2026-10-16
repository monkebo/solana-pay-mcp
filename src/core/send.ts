// `wallet send`: any SPL token (Token or Token-2022) or native SOL, to an address-book recipient, within policy.
import { address, createNoopSigner, type Address, type Instruction } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import type { Ctx } from "./ctx.js";
import { activeBackend } from "./backend.js";
import { fromUnits, knownBySymbol, resolveToken, toUnits, type TokenRef } from "./tokens.js";
import { resolveRecipient } from "./addressbook.js";
import { readPolicy, tokenAllowed } from "./policy.js";
import { WalletError } from "./errors.js";
import { usdValue } from "./prices.js";
import { assessTransfer, auditToken } from "./risk.js";
import { cuPrice } from "./tx.js";
import { DEFAULT_CU, type GasLevel } from "./view.js";
import { CHAIN_ID } from "./config.js";

export interface SendParams {
  amount?: string;
  max?: boolean;
  recipient: string;
  tokenAddress: string;
  gasLevel?: GasLevel;
  memo?: string;
  reference?: string;
}

export interface PreparedSend {
  token: TokenRef;
  to: Address;
  toLabel: string | null;
  units: bigint;
  amount: string;
  usd: number;
  priced: boolean;
  reasons: string[];
  instructions: Instruction[];
  summary: string;
  feeEstimateLamports: number;
}

/** Allow-list check before any on-chain lookup, so disallowed mints fail fast and cheaply. */
export function assertTokenAllowed(policy: ReturnType<typeof readPolicy>, idOrMint: string): void {
  const mint = knownBySymbol(idOrMint) ?? idOrMint.trim();
  if (!tokenAllowed(policy, mint)) {
    throw new WalletError("TOKEN_NOT_ALLOWED", `${idOrMint} is not on the allowed token list and policy.tradeAllTokens is off. The owner can add it with \`saw owner set-policy allowedTokens='[...]'\` or tradeAllTokens=true.`, { mint });
  }
}

export async function tokenBalanceUnits(ctx: Ctx, owner: Address, token: TokenRef): Promise<bigint> {
  if (token.native) return BigInt((await ctx.rpc.getBalance(owner).send()).value);
  const r = await ctx.rpc.getTokenAccountsByOwner(owner, { mint: address(token.mint) }, { encoding: "jsonParsed" }).send();
  return (r.value as unknown as { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[]).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}

export async function prepareSend(ctx: Ctx, p: SendParams): Promise<PreparedSend> {
  const policy = readPolicy();
  assertTokenAllowed(policy, p.tokenAddress);
  const token = await resolveToken(ctx, p.tokenAddress);
  const { address: to, label } = resolveRecipient(p.recipient);
  const be = activeBackend();
  const signer = be.canSign ? await be.signer() : createNoopSigner(await be.address());
  const price = await cuPrice(ctx, p.gasLevel ?? "MEDIUM");
  const feeEstimateLamports = 5000 + Math.ceil((price * DEFAULT_CU) / 1e6);

  let units: bigint;
  if (p.max) {
    const bal = await tokenBalanceUnits(ctx, signer.address, token);
    units = token.native ? bal - BigInt(feeEstimateLamports) - 10_000n : bal;
    if (units <= 0n) throw new WalletError("INSUFFICIENT_BALANCE", `Nothing to send: ${token.symbol} balance is ${fromUnits(bal, token.decimals)}.`);
  } else {
    if (!p.amount) throw new WalletError("MISSING_PARAM", "Give --amount or --max.");
    units = toUnits(p.amount, token.decimals);
    if (units <= 0n) throw new WalletError("INVALID_PARAM", "Amount must be positive.");
  }
  const amount = fromUnits(units, token.decimals);
  const { usd, priced } = await usdValue(ctx, token.mint, amount, token.symbol);
  if (policy.maxPaymentUsd !== null && usd > policy.maxPaymentUsd) {
    throw new WalletError("PAYMENT_LIMIT_EXCEEDED", `$${usd.toFixed(2)} is above the per-payment limit of $${policy.maxPaymentUsd} (policy.maxPaymentUsd).`, { usd, limit: policy.maxPaymentUsd });
  }

  const ixs: Instruction[] = [];
  if (token.native) {
    ixs.push(getTransferSolInstruction({ source: signer, destination: to, amount: units }));
  } else {
    const mint = address(token.mint);
    const [from] = await findAssociatedTokenPda({ mint, owner: signer.address, tokenProgram: token.programAddress });
    const [dest] = await findAssociatedTokenPda({ mint, owner: to, tokenProgram: token.programAddress });
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: signer, owner: to, mint, ata: dest, tokenProgram: token.programAddress }));
    const transfer = getTransferCheckedInstruction({ source: from, mint, destination: dest, authority: signer, amount: units, decimals: token.decimals }, { programAddress: token.programAddress });
    // Solana Pay convention: a read-only reference account lets a payee find this transfer without an indexer.
    ixs.push(p.reference ? { ...transfer, accounts: [...transfer.accounts, { address: address(p.reference), role: 0 }] } : transfer);
  }
  if (p.memo) ixs.push(getAddMemoInstruction({ memo: p.memo.slice(0, 200) }));

  const audit = token.native ? undefined : await auditToken(ctx, token.mint);
  const { reasons } = assessTransfer({ usd, priced, recipientKnown: label !== null, tokenAudit: audit });
  return {
    token,
    to,
    toLabel: label,
    units,
    amount,
    usd,
    priced,
    reasons,
    instructions: ixs,
    summary: `send ${amount} ${token.symbol} to ${label ?? to}`,
    feeEstimateLamports,
  };
}

export function sendDetails(s: PreparedSend) {
  return {
    binanceChainId: CHAIN_ID,
    token: s.token.symbol,
    tokenAddress: s.token.mint,
    amount: s.amount,
    amountUsd: Number(s.usd.toFixed(2)),
    recipient: s.to,
    recipientLabel: s.toLabel,
    estimatedNetworkFeeSol: (s.feeEstimateLamports / 1e9).toFixed(9).replace(/0+$/, ""),
  };
}
