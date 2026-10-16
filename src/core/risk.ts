// Risk assessment shared by send / swap / external signing. Produces human-readable reasons.
// Policy decides what happens with a risky transaction: AutoReject → RISK_BLOCKED, NeedConfirmation → owner approval.
import type { Ctx } from "./ctx.js";
import { known, jupiterTokenInfo, type JupToken } from "./tokens.js";
import { readPolicy } from "./policy.js";
import { cluster } from "./config.js";

export interface RiskItem {
  code: string;
  title: string;
  description: string;
  riskType: "RISK" | "CAUTION";
}

export interface TokenAudit {
  hasResult: boolean;
  isSupported: boolean;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskItems: RiskItem[];
  token: Pick<JupToken, "id" | "symbol" | "name" | "isVerified" | "organicScore" | "organicScoreLabel" | "liquidity" | "mcap" | "holderCount" | "tags" | "audit"> | null;
}

/** Audit a token with Jupiter metadata. Known stables and SOL are trusted. Unavailable → hasResult false (fail closed upstream). */
export async function auditToken(ctx: Ctx, mint: string): Promise<TokenAudit> {
  if (known(mint)) return { hasResult: true, isSupported: true, riskLevel: "low", riskItems: [], token: null };
  if (cluster() !== "mainnet") return { hasResult: false, isSupported: false, riskLevel: "unknown", riskItems: [], token: null };
  let t: JupToken | null;
  try {
    t = await jupiterTokenInfo(ctx, mint);
  } catch {
    return { hasResult: false, isSupported: true, riskLevel: "unknown", riskItems: [], token: null };
  }
  if (!t || t.id !== mint) return { hasResult: false, isSupported: true, riskLevel: "unknown", riskItems: [], token: null };
  const items: RiskItem[] = [];
  const verified = t.isVerified ?? t.tags?.includes("verified") ?? false;
  if (!verified) items.push({ code: "TOKEN_UNVERIFIED", title: "Unverified token", description: "This token is not on Jupiter's verified list. Malicious tokens often clone legitimate names.", riskType: "CAUTION" });
  if (t.audit && t.audit.mintAuthorityDisabled === false) items.push({ code: "MINT_AUTHORITY", title: "Mint authority active", description: "The issuer can mint more supply at any time.", riskType: "CAUTION" });
  if (t.audit && t.audit.freezeAuthorityDisabled === false) items.push({ code: "FREEZE_AUTHORITY", title: "Freeze authority active", description: "The issuer can freeze your token account.", riskType: "CAUTION" });
  if (t.audit?.topHoldersPercentage !== undefined && t.audit.topHoldersPercentage > 50) items.push({ code: "CONCENTRATED_HOLDERS", title: "Concentrated supply", description: `Top holders control ${t.audit.topHoldersPercentage.toFixed(1)}% of supply.`, riskType: "RISK" });
  if (t.liquidity !== undefined && t.liquidity < 10_000) items.push({ code: "LOW_LIQUIDITY", title: "Low liquidity", description: `About $${Math.round(t.liquidity)} of liquidity: large price impact and hard to exit.`, riskType: "RISK" });
  if (t.organicScoreLabel === "low") items.push({ code: "LOW_ORGANIC_SCORE", title: "Low organic activity score", description: "Trading activity looks inorganic (bots / wash trading).", riskType: "CAUTION" });
  const riskLevel = items.some((i) => i.riskType === "RISK") ? "high" : items.length ? "medium" : "low";
  return {
    hasResult: true,
    isSupported: true,
    riskLevel,
    riskItems: items,
    token: { id: t.id, symbol: t.symbol, name: t.name, isVerified: verified, organicScore: t.organicScore, organicScoreLabel: t.organicScoreLabel, liquidity: t.liquidity, mcap: t.mcap, holderCount: t.holderCount, tags: t.tags, audit: t.audit },
  };
}

export interface Assessment {
  reasons: string[];
  /** true → the policy wants this blocked or confirmed */
  abnormal: boolean;
}

/** Amount / recipient / token based reasons for a transfer-like action. */
export function assessTransfer(input: { usd: number; priced: boolean; recipientKnown: boolean | null; tokenAudit?: TokenAudit }): Assessment {
  const p = readPolicy();
  const reasons: string[] = [];
  if (p.confirmAboveUsd !== null && input.usd > p.confirmAboveUsd) reasons.push(`amount $${input.usd.toFixed(2)} is above policy.confirmAboveUsd ($${p.confirmAboveUsd})`);
  if (!input.priced) reasons.push("token has no USD price; value cannot be checked against limits");
  if (input.recipientKnown === false) reasons.push("recipient is not in the address book");
  if (input.tokenAudit) {
    if (!input.tokenAudit.hasResult) reasons.push("token security check unavailable");
    for (const i of input.tokenAudit.riskItems) reasons.push(`${i.riskType === "RISK" ? "risk" : "caution"}: ${i.title}`);
  }
  return { reasons, abnormal: reasons.length > 0 };
}
