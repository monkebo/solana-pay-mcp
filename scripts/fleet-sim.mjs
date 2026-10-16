#!/usr/bin/env node
// Fleet simulation against a running vault: creates agents, funds them, then runs a market where
// buyers pay workers for jobs. One agent ("the burner") overspends on purpose so the owner can kill it live.
//
//   node scripts/fleet-sim.mjs --vault http://localhost:3000 --owner-token <token> [--agents 20] [--usdc 2] [--rounds 200] [--pace 1500]
//   node scripts/fleet-sim.mjs ... --reuse        # skip create/fund, reuse agents from ~/.solana-pay-mcp/fleet-sim.json
//
// Reads/writes fleet-sim.json (agent names + tokens) so a second run can continue the same fleet.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const VAULT = (arg("--vault", process.env.SAW_VAULT_URL ?? "http://localhost:3000")).replace(/\/$/, "");
const OWNER = arg("--owner-token", process.env.SAW_OWNER_TOKEN) ?? readFileSync(join(process.env.SAW_HOME ?? join(homedir(), ".solana-pay-mcp"), "owner-token"), "utf8").trim();
const N = Number(arg("--agents", 20));
const USDC = Number(arg("--usdc", 2));
const ROUNDS = Number(arg("--rounds", 200));
const PACE = Number(arg("--pace", 1500));
const STATE = join(process.env.SAW_HOME ?? join(homedir(), ".solana-pay-mcp"), "fleet-sim.json");

async function post(path, body, token) {
  const r = await fetch(VAULT + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.success) throw new Error(`${j.error.name}: ${j.error.message}`);
  return j.data;
}
const owner = (command, params = {}) => post("/v1/owner/exec", { command, params }, OWNER);
const agent = (token, command, params = {}) => post("/v1/exec", { command, params }, token);

const ROLES = [
  { role: "buyer", share: 0.25, limit: 1.5, max: 0.3 },
  { role: "translator", share: 0.4, limit: 1, max: 0.2 },
  { role: "researcher", share: 0.35, limit: 1, max: 0.2 },
];
const JOBS = { translator: ["translate landing page", "subtitle 2 min clip", "proofread README", "localize app strings"], researcher: ["find 5 competitors", "summarize 3 papers", "price check in BA", "verify an address"] };

let fleet = [];
if (process.argv.includes("--reuse") && existsSync(STATE)) {
  fleet = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(`reusing ${fleet.length} agents from ${STATE}`);
} else {
  for (const r of ROLES) {
    const count = Math.max(1, Math.round(N * r.share));
    const made = await owner("owner.fleet-create", { role: r.role, count, dailyLimitUsd: r.limit, maxPaymentUsd: r.max });
    fleet.push(...made.agents.map((a) => ({ ...a, role: r.role })));
    console.log(`created ${count} ${r.role}(s)`);
  }
  writeFileSync(STATE, JSON.stringify(fleet, null, 2), { mode: 0o600 });
  console.log(`funding ${fleet.length} agents with ${USDC} USDC + 0.02 SOL each…`);
  const f = await owner("owner.fleet-fund", { amount: USDC, sol: 0.02 });
  for (const t of f.transactions) console.log(`  ${t.agents.join(", ")} ← ${t.explorer}`);
  console.log("waiting 20s for funding to confirm…");
  await new Promise((r) => setTimeout(r, 20_000));
}

// The burner: first buyer pays too often and too much, so the owner has a reason to kill it.
const burner = fleet.find((a) => a.role === "buyer");
console.log(`burner is ${burner.name} (watch it in the console, then kill it)`);

const buyers = fleet.filter((a) => a.role === "buyer");
const workers = fleet.filter((a) => a.role !== "buyer");
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
let round = 0, ok = 0, refused = 0;

const tick = async () => {
  round++;
  const payer = round % 3 === 0 ? burner : pick(buyers);
  const worker = pick(workers);
  const amount = payer === burner ? (0.2 + Math.random() * 0.2).toFixed(2) : (0.02 + Math.random() * 0.08).toFixed(2);
  const memo = `${pick(JOBS[worker.role])} #${round}`;
  try {
    const r = await agent(payer.token, "wallet.send", { amount, recipient: worker.name, tokenAddress: "USDC", memo });
    ok++;
    console.log(`#${round} ${payer.name} → ${worker.name} ${amount} USDC  ${r.status}  ${r.txHash ? r.txHash.slice(0, 12) + "…" : ""}`);
    // workers tip back a share to another worker now and then: money keeps moving
    if (Math.random() < 0.3) {
      const other = pick(workers.filter((w) => w !== worker));
      await agent(worker.token, "wallet.send", { amount: "0.01", recipient: other.name, tokenAddress: "USDC", memo: `referral #${round}` }).catch(() => {});
    }
  } catch (e) {
    refused++;
    console.log(`#${round} ${payer.name} → ${worker.name} ${amount} USDC  REFUSED: ${e.message.slice(0, 90)}`);
  }
};

for (let i = 0; i < ROUNDS; i++) {
  await tick();
  await new Promise((r) => setTimeout(r, PACE));
}
console.log(`done: ${ok} paid, ${refused} refused. Leaderboard: saw owner fleet list --balances --json`);
