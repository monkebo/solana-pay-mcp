#!/usr/bin/env node
// USDCity: a small town on devnet. Agents with names and roles buy from each other; every purchase is a real
// USDC transfer under the owner's policy. Narrates each action, posts to a Telegram group when TELEGRAM_BOT_TOKEN
// and TELEGRAM_CHAT_ID are set, and posts a leaderboard every 10 rounds.
//
//   node scripts/economy.mjs --vault http://localhost:3000 [--usdc 1] [--rounds 300] [--pace 5000] [--reuse]
//   --reuse: don't create or fund; take names and roles from the vault and tokens from economy.json / fleet-sim.json
//
// A stress test for the wallet, not a product: who gets rich depends on prices and luck.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const HOME = process.env.SAW_HOME ?? join(homedir(), ".solana-pay-mcp");
const VAULT = (arg("--vault", process.env.SAW_VAULT_URL ?? "http://localhost:3000")).replace(/\/$/, "");
const OWNER = process.env.SAW_OWNER_TOKEN ?? readFileSync(join(HOME, "owner-token"), "utf8").trim();
const USDC = Number(arg("--usdc", 1));
const ROUNDS = Number(arg("--rounds", 300));
const PACE = Number(arg("--pace", 5000));
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
  console.log(text.replace(/<[^>]+>/g, ""));
  if (!TG) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: TG.chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  } catch (e) {
    console.log("telegram:", e.message);
  }
}

// The cast. Each role sells things at a price and needs things from other roles. Icons drive the narration.
export const TOWN = {
  barista: { icon: "☕", sells: ["flat white", "espresso", "cortado", "oat latte"], price: [0.03, 0.06], needs: ["baker", "farmer", "courier", "dj"] },
  baker: { icon: "🥐", sells: ["croissant", "sourdough", "medialuna", "alfajor"], price: [0.04, 0.08], needs: ["farmer", "courier", "barista", "landlord"] },
  farmer: { icon: "🌽", sells: ["milk", "flour", "eggs", "yerba"], price: [0.05, 0.1], needs: ["mechanic", "courier", "barista", "tarot"] },
  courier: { icon: "🚲", sells: ["delivery", "rush delivery", "moving a sofa"], price: [0.02, 0.05], needs: ["barista", "baker", "mechanic", "grandma"] },
  mechanic: { icon: "🔧", sells: ["bike repair", "tune-up", "a mystery part"], price: [0.06, 0.12], needs: ["barista", "baker", "farmer", "dj"] },
  designer: { icon: "🎨", sells: ["logo", "menu design", "tattoo sketch"], price: [0.08, 0.15], needs: ["barista", "baker", "courier", "influencer"] },
  dj: { icon: "🎧", sells: ["a set", "song request", "wedding playlist"], price: [0.05, 0.12], needs: ["barista", "mechanic", "landlord", "tarot"] },
  grandma: { icon: "👵", sells: ["empanadas", "life advice", "knitted socks"], price: [0.02, 0.05], needs: ["farmer", "baker", "tarot", "courier"] },
  influencer: { icon: "🤳", sells: ["a shoutout", "story mention", "unboxing"], price: [0.1, 0.2], needs: ["barista", "designer", "dj", "detective"] },
  detective: { icon: "🕵️", sells: ["finding a lost cat", "background check", "tailing someone"], price: [0.08, 0.18], needs: ["barista", "courier", "mechanic", "grandma"] },
  tarot: { icon: "🔮", sells: ["a reading", "a curse removal", "lucky numbers"], price: [0.03, 0.09], needs: ["barista", "grandma", "dj", "landlord"] },
  landlord: { icon: "🏠", sells: ["rent", "a late fee", "the key deposit"], price: [0.1, 0.22], needs: ["mechanic", "designer", "detective", "tarot"] },
  degen: { icon: "🎰", sells: ["an alpha call", "a memecoin tip", "a cursed NFT"], price: [0.01, 0.04], needs: ["barista", "tarot", "dj", "influencer", "landlord"] },
  tourist: { icon: "🧳", sells: ["a postcard"], price: [0.01, 0.02], needs: ["barista", "baker", "grandma", "tarot", "dj", "designer", "courier"] },
};
const VERBS = ["bought", "ordered", "paid for", "grabbed", "splurged on", "finally paid for", "treated themselves to"];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const rnd = (a, b) => (a + Math.random() * (b - a)).toFixed(2);

// Who's in town when a fresh one is created.
const CAST = [
  ["lucia", "barista"], ["tomas", "barista"], ["don-pepe", "baker"], ["nonna-rosa", "baker"], ["juan", "farmer"], ["la-vaca", "farmer"],
  ["flash", "courier"], ["pedro", "courier"], ["el-tuerca", "mechanic"], ["frida", "designer"], ["dj-pepe", "dj"], ["grandma-elsa", "grandma"],
  ["mia", "influencer"], ["sherlock", "detective"], ["madame-zora", "tarot"], ["don-corleone", "landlord"], ["crypto-bro", "degen"], ["karl", "tourist"],
];

let tokens = {};
for (const f of ["economy.json", "fleet-sim.json"]) {
  const p = join(HOME, f);
  if (existsSync(p)) for (const a of JSON.parse(readFileSync(p, "utf8"))) tokens[a.id] = a.token;
}
let fleet;
if (process.argv.includes("--reuse")) {
  const l = await owner("owner.fleet-list");
  fleet = l.agents.filter((a) => a.status !== "killed" && tokens[a.id] && TOWN[a.role]).map((a) => ({ id: a.id, name: a.name, role: a.role, token: tokens[a.id] }));
  console.log(`reusing ${fleet.length} townsfolk`);
} else {
  fleet = [];
  for (const [name, role] of CAST) {
    const made = await owner("owner.fleet-create", { role, name, dailyLimitUsd: 2, maxPaymentUsd: 0.25 });
    fleet.push({ ...made.agents[0], role });
  }
  writeFileSync(STATE, JSON.stringify(fleet, null, 2), { mode: 0o600 });
  await tg(`🏘️ <b>USDCity opens.</b> ${fleet.length} townsfolk with Solana wallets, ${USDC} USDC each. One owner policy: max $0.25 per payment, $2 a day.`);
  const f = await owner("owner.fleet-fund", { amount: USDC, sol: 0.015 });
  for (const t of f.transactions) await tg(`💧 Treasury funded ${t.agents.join(", ")} · <a href="${t.explorer}">tx</a>`);
  await new Promise((r) => setTimeout(r, 20_000));
}
const byRole = (r) => fleet.filter((a) => a.role === r);
const who = (a) => `${TOWN[a.role].icon} <b>${a.name}</b>`;

async function leaderboard() {
  const l = await owner("owner.fleet-list", { balances: true });
  const rows = l.agents.filter((a) => TOWN[a.role]).sort((a, b) => Number(b.usdc ?? -1) - Number(a.usdc ?? -1));
  const medals = ["🥇", "🥈", "🥉"];
  const text = ["🏆 <b>Richest in USDCity</b>", ...rows.slice(0, 8).map((a, i) => `${medals[i] ?? (i + 1) + "."} ${TOWN[a.role].icon} <b>${a.name}</b> ${a.usdc ?? "?"} USDC${a.status !== "active" ? ` (${a.status})` : ""}`), `<i>${rows.length} townsfolk · $${Number(l.spentTodayUsd).toFixed(2)} moved today</i>`].join("\n");
  await tg(text);
}

for (let round = 0; round < ROUNDS; round++) {
  const customer = pick(fleet);
  const need = pick(TOWN[customer.role].needs);
  const sellers = byRole(need).filter((s) => s.id !== customer.id);
  if (!sellers.length) continue;
  const seller = pick(sellers);
  const item = pick(TOWN[seller.role].sells);
  const amount = rnd(...TOWN[seller.role].price);
  const line = `${who(customer)} ${pick(VERBS)} ${item} from ${who(seller)}`;
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
    if (why === "LOCKED") { console.log(`${customer.name} still has a payment in flight, skipping`); continue; } // one tx at a time per agent; not news
    const reason = why === "SIMULATION_FAILED" ? "can't afford it 💸" : why === "AGENT_PAUSED" ? "paused by the owner ⏸️" : why === "FLEET_PAUSED" ? "the town is paused ⏸️" : why === "PAYMENT_LIMIT_EXCEEDED" ? "over the per-payment cap 🚫" : why === "DAILY_LIMIT_EXCEEDED" ? "hit the daily limit 🚫" : /429|Too Many/.test(e.message) ? "network busy, skipped 📵" : why;
    await tg(`${line} · ${amount} USDC · ❌ <i>${reason}</i>`);
  }
  if ((round + 1) % 10 === 0) await leaderboard();
  await new Promise((r) => setTimeout(r, PACE));
}
await leaderboard();
