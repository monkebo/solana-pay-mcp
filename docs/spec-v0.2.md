# solana-pay-mcp — spec v0.2 (2026-10-10)

**One line:** your wallet inside Claude. Say "pay Sarah 3 USDC" on the phone, it pays. Pay one or a hundred. Invoice and get paid too.

**Proven today (devnet):** phone voice → Claude → agent wallet → Solana. tx 57JhAe…, 0.5 USDC. Also 0.01 SOL. Repo github.com/monkebo/solana-pay-mcp, v0.2.0 pushed.

## Who
1. Bohdan: pays Argentine freelancers/contractors in USDC from phone. First user.
2. Superteam Argentina: bounty/grant payouts, 10–100 wallets per round. Second user, warm contact.
3. Agents: scripts/agents that need to pay without a human. Future.

## Items, priority order

1. **Demo clip** — new. 20s phone screen recording: voice "pay dev 0.25 USDC for coffee" → confirm → explorer link. Owner Bohdan. Goes in README, Superteam DM, grant.
2. **Secret in header** — new. Move `SOLANA_PAY_HTTP_SECRET` from URL path to `Authorization: Bearer` header; claude.ai connectors support request headers. URL stops leaking secret in logs/screenshots. Owner Claude, 1h.
3. **Fixed server** — new. Deploy `serve` to Fly.io (persistent volume for agent.json, requests.json, contacts.json). Laptop can close. Tunnel URL stops changing. Owner Claude, half day. Decision: Fly over Vercel because we need a disk and one always-on process.
4. **Mainnet $1 test** — new. Fund agent wallet with $2 USDC + 0.01 SOL real, `SOLANA_CLUSTER=mainnet`, cap 5 USDC/day. Pay bohdan 1 USDC from phone. Proves real money. Owner Bohdan funds, Claude runs.
5. **Spending rules** — new. Per-payment max (`SOLANA_PAY_MAX_PAYMENT`, default 50). Unknown-address block: payments only to saved contacts unless `allow_new=true`. Stops voice typo sending 500 instead of 5. Owner Claude, 1h.
6. **pay_many in one tx** — new. Up to ~20 transfers per transaction instead of one each. 100 bounties = 5 txs, 3 seconds. Owner Claude, 2h.
7. **.sol names** — new. `pay bohdan.sol` resolves via SNS. Owner Claude, 1h.
8. **monthly_report** — new. "What did I pay in October?" → table by contact, total, explorer links, CSV. First app-layer tool, this is what Mercantill/Latinum pivoted toward. Owner Claude, half day.
9. **Paywall for tools** — later. Charge 0.01 USDC per call to any MCP tool via 402 (pay.sh / solana-foundation pay-kit). Agents paying agents. Week 4.
10. **npm 0.2.0** — blocked on npm staging review of 0.1.0. Publish when cleared. Owner Bohdan (2FA key).

## Money moves
- Superteam Argentina: send demo clip + "want me to run your next payout with this?" after item 3.
- Solana Foundation AI grant: submit after item 4 (mainnet proof) with clip. Draft in docs/grant-application-draft.md, rewrite in own words.
- Nico (Triton): ask for RPC credits once there is a fixed server; `SOLANA_RPC_URL` already supported.
- Clawpump CTO: show agent-wallet + caps pattern, offer to contract it in.

## Out of scope
Card issuing, fiat on/off ramp, multi-user hosted SaaS, custody for others. Each user runs their own server with their own key.
