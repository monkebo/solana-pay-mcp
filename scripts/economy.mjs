#!/usr/bin/env node
// A small town economy on devnet: agents with roles buy from each other, every purchase is a real USDC transfer
// under the owner's policy. Narrates each action, posts to a Telegram group when TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are set, and prints a leaderboard every 10 rounds.
//
//   node scripts/economy.mjs --vault http://localhost:3000 [--usdc 1] [--rounds 300] [--pace 4000] [--reuse]
//   env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional), SAW_OWNER_TOKEN (default: ~/.solana-pay-mcp/owner-token)
//
// This is a stress test for the wallet, not a product: who gets rich depends on prices and luck.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const HOME = process.env.SAW_HOME ?? join(homedir(), ".solana-pay-mcp");
const VAULT = (arg("--vault", process.env.SAW_VAULT_URL ?? "http://localhost:3000")).replace(/\/$/, "");
const OWNER = process.env.SAW_OWNER_TOKEN ?? readFileSync(join(HOME, "owner-token"), "utf8").trim();
const USDC = Number(arg("--usdc", 1));
const ROUNDS = Number(arg("--rounds", 300));
const PACE = Number(arg("--pace", 4000));
const STATE = join(HOME, "economy.json");
const TG = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID } : null;

async function post(path, body, token) {
  const r = await fetch(VAULT + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.success) throw new Error(`${j.error.name}: ${j.error.message}`);
  return j.data;
}
const owner = (command, params = {}) => post("/v1/owner/exec", { command, params }, OWNER);
const agent = (token, command, params = {}) => post("/v1/exec", { command, params }, token);

async function tg(text) {
  console.log(text);
  if (!TG) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: TG.chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  } catch (e) {
    console.log("telegram:", e.message);
  }
}

// The town. Each role sells something at a price and needs things from others.
const TOWN = [
  { role: "barista", icon: "☕", sells: ["flat white", "espresso", "cortado"], price: [0.03, 0.06], needs: ["baker", "farmer", "courier"] },
  { role: "baker", icon: "🥐", sells: ["croissant", "sourdough", "medialuna"], price: [0.04, 0.08], needs: ["farmer", "courier", "barista"] },
  { role: "farmer", icon: "🌽", sells: ["milk", "flour", "eggs"], price: [0.05, 0.1], needs: ["mechanic", "courier", "barista"] },
  { role: "courier", icon: "🚲", sells: ["delivery", "rush delivery"], price: [0.02, 0.05], needs: ["barista", "baker", "mechanic"] },
  { role: "mechanic", icon: "🔧", sells: ["bike repair", "tune-up"], price: [0.06, 0.12], needs: ["barista", "baker", "farmer"] },
  { role: "designer", icon: "🎨", sells: ["logo", "menu design", "poster"], price: [0.08, 0.15], needs: ["barista", "baker", "courier"] },
  { role: "buyer", icon: "🛍️", sells: [], price: [0, 0], needs: ["barista", "baker", "designer", "farmer", "courier", "mechanic"] },
];
const VERBS = ["bought", "ordered", "paid for", "grabbed", "picked up"];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const rnd = (a, b) => (a + Math.random() * (b - a)).toFixed(2);

let fleet = [];
if (process.argv.includes("--reuse") && existsSync(STATE)) {
  fleet = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(`reusing ${fleet.length} townsfolk from ${STATE}`);
} else {
  for (const t of TOWN) {
    const count = t.role === "buyer" ? 3 : 2;
    const made = await owner("owner.fleet-create", { role: t.role, count, dailyLimitUsd: 2, maxPaymentUsd: 0.25 });
    fleet.push(...made.agents.map((a) => ({ ...a, role: t.role })));
  }
  writeFileSync(STATE, JSON.stringify(fleet, null, 2), { mode: 0o600 });
  await tg(`🏘️ <b>A new town opens on Solana devnet.</b> ${fleet.length} agents, ${USDC} USDC each, one owner policy: max $0.25 per payment, $2 a day.`);
  const f = await owner("owner.fleet-fund", { amount: USDC, sol: 0.015 });
  for (const t of f.transactions) await tg(`💧 Treasury funded ${t.agents.join(", ")} · <a href="${t.explorer}">tx</a>`);
  await new Promise((r) => setTimeout(r, 20_000));
}
const byRole = (r) => fleet.filter((a) => a.role === r);
const spec = (a) => TOWN.find((t) => t.role === a.role);

async function leaderboard() {
  const l = await owner("owner.fleet-list", { balances: true });
  const rows = [...l.agents].sort((a, b) => Number(b.usdc ?? 0) - Number(a.usdc ?? 0));
  const medals = ["🥇", "🥈", "🥉"];
  const text = ["🏆 <b>Richest agents</b>", ...rows.slice(0, 8).map((a, i) => `${medals[i] ?? (i + 1) + "."} ${spec(a)?.icon ?? "🤖"} <b>${a.name}</b> ${a.usdc} USDC${a.status !== "active" ? ` (${a.status})` : ""}`), `<i>${rows.length} agents · $${Number(l.spentTodayUsd).toFixed(2)} moved today</i>`].join("\n");
  await tg(text);
}

let round = 0;
for (; round < ROUNDS; round++) {
  const customer = pick(fleet.filter((a) => a.status !== "killed"));
  const need = pick(spec(customer).needs);
  const sellers = byRole(need).filter((s) => s.name !== customer.name);
  if (!sellers.length) continue;
  const seller = pick(sellers);
  const item = pick(spec(seller).sells);
  const [lo, hi] = spec(seller).price;
  const amount = rnd(lo, hi);
  const line = `${spec(customer).icon} <b>${customer.name}</b> ${pick(VERBS)} ${item} from ${spec(seller).icon} <b>${seller.name}</b>`;
  try {
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await agent(customer.token, "wallet.send", { amount, recipient: seller.name, tokenAddress: "USDC", memo: `${item} #${round + 1}` });
        break;
      } catch (e) {
        if (attempt < 2 && /429|Too Many Requests|fetch failed|ECONNREFUSED/.test(e.message)) { await new Promise((w) => setTimeout(w, 4000 * (attempt + 1))); continue; }
        throw e;
      }
    }
    await tg(`${line} · ${amount} USDC · <a href="${r.explorer}">tx</a>`);
  } catch (e) {
    const why = e.message.split(":")[0];
    await tg(`${line} · ${amount} USDC · ❌ <i>${why === "SIMULATION_FAILED" ? "can't afford it" : why === "AGENT_PAUSED" ? "paused by the owner" : why === "FLEET_PAUSED" ? "town is paused" : /429|Too Many/.test(e.message) ? "network busy, skipped" : why}</i>`);
  }
  if ((round + 1) % 10 === 0) await leaderboard();
  await new Promise((r) => setTimeout(r, PACE));
}
await leaderboard();
