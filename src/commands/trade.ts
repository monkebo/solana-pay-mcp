import { z } from "zod";
import { amount, define, optBool, optNum, optStr, str } from "../core/registry.js";
import { gated } from "../core/gate.js";
import { buildSwapTx, getQuote, marketOrders, prepareSwap, quoteView } from "../core/swap.js";
import { sendWire, signWire, simulateWire } from "../core/tx.js";
import { explorerUrl } from "../core/config.js";
import { refreshPending } from "../core/track.js";
import { cancelTriggerTx, createTriggerOrder, executeTrigger, fetchTriggerOrders, limitRowFromLocal, limitStatusFromUpstream, prepareLimit, symbolFor } from "../core/limit.js";
import { orders, setOrder } from "../core/orders.js";
import { fromUnits } from "../core/tokens.js";
import { WalletError } from "../core/errors.js";
import { gasLevelSchema } from "./wallet-send.js";

const slippage = optStr('"auto" (default) or percent 0–100, e.g. 2.5');

define({
  name: "market-order.quote",
  cli: "market-order quote",
  title: "Swap quote",
  description: "Price a swap without trading: expected output, minimum received at the slippage, price impact, route.",
  access: "session",
  write: false,
  params: { fromTokenQty: amount("Amount of fromToken"), fromToken: str("Mint or SOL/USDC/USDT"), toToken: str("Mint or SOL/USDC/USDT"), binanceChainId: optStr("Ignored"), slippage },
  async run(ctx, p) {
    const { from, to, quote } = await getQuote(ctx, p);
    return quoteView(from, to, quote);
  },
});

define({
  name: "market-order.swap",
  cli: "market-order swap",
  title: "Swap at market",
  description: "Swap tokens through Jupiter at the current price. Policy checks: allowed tokens, per-tx and daily USD limits, token audit; risky swaps go to the owner. Returns an orderId: poll `market-order list --orderId` until FINISHED or FAILED.",
  access: "session",
  write: true,
  params: {
    fromTokenQty: amount("Amount of fromToken to sell"),
    fromToken: str("Mint or SOL/USDC/USDT"),
    toToken: str("Mint or SOL/USDC/USDT"),
    binanceChainId: optStr("Ignored"),
    slippage,
    mev: optBool("MEV protection via Jito tip when JITO_TIP_LAMPORTS is configured (default true)"),
    gasLevel: gasLevelSchema,
    orderId: optStr("internal"),
  },
  async run(ctx, p) {
    const s = await prepareSwap(ctx, p);
    return gated(ctx, {
      orderId: p.orderId,
      kind: "swap",
      category: "general",
      usd: s.usd,
      summary: `swap ${s.view.fromCoinAmount} ${s.from.symbol} → ~${s.view.toCoinAmount} ${s.to.symbol}`,
      details: { ...s.view, amountUsd: Number(s.usd.toFixed(2)) },
      command: "market-order.swap",
      params: { ...p, orderId: undefined },
      reasons: s.reasons,
      async execute() {
        const built = await buildSwapTx(ctx, s, p);
        const b = await sendWire(ctx, built.swapTransaction, { lastValidBlockHeight: built.lastValidBlockHeight });
        return {
          txHash: b.signature,
          signedTx: b.signedTx,
          lastValidBlockHeight: b.lastValidBlockHeight,
          result: { orderId: "", txHash: b.signature, status: "PENDING", explorer: explorerUrl(b.signature), ...s.view, note: "Submitted. Poll `market-order list --orderId <orderId>` until FINISHED or FAILED." },
        };
      },
    });
  },
});

define({
  name: "market-order.list",
  cli: "market-order list",
  title: "Market orders",
  description: "Swaps placed by this wallet with PENDING / FINISHED / FAILED status (refreshed from the chain).",
  access: "session",
  write: false,
  params: { orderId: optStr("One order"), status: z.enum(["PENDING", "FINISHED", "FAILED"]).optional(), fromToken: optStr("Filter"), toToken: optStr("Filter"), startTime: optNum("ms"), endTime: optNum("ms"), page: optNum("Page (1-based)"), pageSize: optNum("Max 100"), binanceChainId: optStr("Ignored") },
  async run(ctx, q) {
    await refreshPending(ctx);
    const all = marketOrders(q);
    const size = Math.min(q.pageSize ?? 20, 100);
    const page = Math.max(q.page ?? 1, 1);
    return { total: all.length, page, pageSize: size, list: all.slice((page - 1) * size, page * size) };
  },
});

async function placeLimit(ctx: Parameters<typeof prepareLimit>[0], side: "BUY" | "SELL", p: Record<string, unknown>) {
  const a = { side, triggerPrice: String(p.triggerPrice), fromTokenQty: String(p.fromTokenQty), fromToken: String(p.fromToken), toToken: String(p.toToken), slippage: p.slippage as string | undefined, expiredAt: p.expiredAt as number | undefined };
  const s = await prepareLimit(ctx, a);
  const details = {
    side,
    fromToken: s.from.mint,
    fromTokenName: s.from.symbol,
    fromTokenQty: fromUnits(s.makingAmount, s.from.decimals),
    toToken: s.to.mint,
    toTokenName: s.to.symbol,
    toTokenQty: fromUnits(s.takingAmount, s.to.decimals),
    triggerPrice: String(s.triggerPrice),
    slippage: (p.slippage as string | undefined) ?? "auto",
    amountUsd: Number(s.usd.toFixed(2)),
  };
  return gated(ctx, {
    orderId: p.orderId as string | undefined,
    kind: "limit",
    category: "general",
    usd: s.usd,
    summary: `limit ${side.toLowerCase()} ${details.fromTokenQty} ${s.from.symbol} → ${details.toTokenQty} ${s.to.symbol} @ $${s.triggerPrice}`,
    details,
    command: side === "BUY" ? "limit-order.buy" : "limit-order.sell",
    params: { ...p, orderId: undefined },
    reasons: s.reasons,
    async execute() {
      const created = await createTriggerOrder(ctx, s, a);
      const sim = await simulateWire(ctx, created.transaction);
      if (sim.err) throw new WalletError("SIMULATION_FAILED", `Order transaction failed simulation: ${JSON.stringify(sim.err)}`, { logs: sim.logs.slice(-10) });
      const { wire } = await signWire(created.transaction);
      const ex = await executeTrigger(ctx, created.requestId, wire);
      return {
        txHash: ex.signature || null,
        status: "WORKING",
        details: { strategyId: created.order },
        result: { strategyId: created.order, status: "WORKING", txHash: ex.signature || null, ...details, note: "Placed, not filled. It rests until the trigger price is reached; check with `limit-order list --strategyId`." },
      };
    },
  });
}

const limitParams = {
  triggerPrice: amount("USD price that activates the order"),
  fromTokenQty: amount("Amount of fromToken"),
  fromToken: str("Mint or SOL/USDC/USDT"),
  toToken: str("Mint or SOL/USDC/USDT"),
  binanceChainId: optStr("Ignored"),
  slippage,
  mev: optBool("Ignored for resting orders"),
  gasLevel: gasLevelSchema,
  expiredAt: optNum("Optional expiry, ms timestamp"),
  orderId: optStr("internal"),
};

define({
  name: "limit-order.buy",
  cli: "limit-order buy",
  title: "Limit buy",
  description: "Buy a token with USDC, USDT or SOL when its USD price drops to triggerPrice. Places a Jupiter trigger order (min $5). A strategyId is a placement, not a fill.",
  access: "session",
  write: true,
  params: limitParams,
  async run(ctx, p) {
    return placeLimit(ctx, "BUY", p);
  },
});

define({
  name: "limit-order.sell",
  cli: "limit-order sell",
  title: "Limit sell",
  description: "Sell a token for USDC, USDT or SOL when its USD price reaches triggerPrice. Places a Jupiter trigger order (min $5). A strategyId is a placement, not a fill.",
  access: "session",
  write: true,
  params: limitParams,
  async run(ctx, p) {
    return placeLimit(ctx, "SELL", p);
  },
});

define({
  name: "limit-order.list",
  cli: "limit-order list",
  title: "Limit orders",
  description: "Resting and historical trigger orders: WORKING, TRIGGERED, PENDING, FINISHED, FAILED, EXPIRED, CANCELED. Live status comes from Jupiter; falls back to local records offline.",
  access: "session",
  write: false,
  params: { strategyId: optStr("One order (Jupiter order account)"), status: z.enum(["WORKING", "TRIGGERED", "PENDING", "FINISHED", "FAILED", "EXPIRED", "CANCELED"]).optional(), fromToken: optStr("Filter"), toToken: optStr("Filter"), startTime: optNum("ms"), endTime: optNum("ms"), page: optNum("1-based"), pageSize: optNum("Max 100"), binanceChainId: optStr("Ignored") },
  async run(ctx, q) {
    await refreshPending(ctx);
    const local = orders.all().filter((o) => o.kind === "limit");
    let rows = local.map(limitRowFromLocal);
    try {
      const upstream = [...(await fetchTriggerOrders(ctx, "active")), ...(await fetchTriggerOrders(ctx, "history"))];
      for (const u of upstream) {
        const st = limitStatusFromUpstream(u);
        const mine = local.find((o) => (o.details as Record<string, string>).strategyId === u.orderKey);
        if (mine && mine.status !== st && ["FINISHED", "EXPIRED", "CANCELED", "FAILED"].includes(st)) setOrder(mine.id, { status: st as never, txHash: u.closeTx ?? mine.txHash });
        const row = mine ? limitRowFromLocal(orders.get(mine.id)!) : {
          orderType: "limit", strategyId: u.orderKey, orderId: null, chain: "CT_501", side: null,
          fromToken: u.inputMint, fromTokenName: symbolFor(u.inputMint), fromTokenQty: u.makingAmount,
          toToken: u.outputMint, toTokenName: symbolFor(u.outputMint), toTokenQty: u.takingAmount, triggerPrice: null,
          status: st, slippage: "auto", txHash: u.openTx, bookTime: u.createdAt, updatedTime: u.updatedAt, error: null,
        };
        row.status = st;
        rows = rows.filter((r) => r.strategyId !== u.orderKey).concat([row as never]);
      }
    } catch {
      /* offline: local records only */
    }
    if (q.strategyId) rows = rows.filter((r) => r.strategyId === q.strategyId);
    else {
      if (q.status) rows = rows.filter((r) => r.status === q.status);
      if (q.fromToken) rows = rows.filter((r) => r.fromToken === q.fromToken);
      if (q.toToken) rows = rows.filter((r) => r.toToken === q.toToken);
      if (q.startTime) rows = rows.filter((r) => Date.parse(r.bookTime) >= q.startTime!);
      if (q.endTime) rows = rows.filter((r) => Date.parse(r.bookTime) <= q.endTime!);
    }
    rows.sort((a, b) => Date.parse(b.bookTime) - Date.parse(a.bookTime));
    const size = Math.min(q.pageSize ?? 20, 100);
    const page = Math.max(q.page ?? 1, 1);
    return { total: rows.length, page, pageSize: size, list: rows.slice((page - 1) * size, page * size) };
  },
});

define({
  name: "limit-order.cancel",
  cli: "limit-order cancel",
  title: "Cancel a limit order",
  description: "Cancel a resting trigger order and get the escrowed tokens back.",
  access: "session",
  write: true,
  params: { strategyId: str("Order account from `limit-order list`"), orderId: optStr("internal") },
  async run(ctx, p) {
    const local = orders.all().find((o) => o.kind === "limit" && (o.details as Record<string, string>).strategyId === p.strategyId);
    return gated(ctx, {
      orderId: p.orderId,
      kind: "limit-cancel",
      category: "general",
      usd: 0,
      summary: `cancel limit order ${p.strategyId}`,
      details: { strategyId: p.strategyId },
      command: "limit-order.cancel",
      params: { ...p, orderId: undefined },
      reasons: [],
      needsLock: false,
      async execute() {
        const c = await cancelTriggerTx(ctx, p.strategyId);
        const { wire } = await signWire(c.transaction);
        const ex = await executeTrigger(ctx, c.requestId, wire);
        if (local) setOrder(local.id, { status: "CANCELED" });
        return { txHash: ex.signature || null, status: "COMPLETED", result: { strategyId: p.strategyId, status: "CANCELED", txHash: ex.signature || null } };
      },
    });
  },
});
