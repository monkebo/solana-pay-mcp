# Demo: twenty agents, one kill switch (3 minutes)

Setup, before recording: vault running (`bash scripts/phone.sh`), treasury funded on devnet with ~1 SOL and ~50 USDC, owner console open in a browser with the owner token pasted, Claude Code open with the `solana-pay` MCP.

1. **Claude Code.** "Create a fleet: 5 buyers, 8 translators, 7 researchers. 2 USDC each, 1 USDC a day cap." Claude calls `owner_fleet_create` three times and `owner_fleet_fund` once. The console fills with twenty agents and one funding transaction per five agents.
2. **Terminal.** `node scripts/fleet-sim.mjs --reuse --vault http://localhost:3000`. Payments start flowing: `buyer-02 → translator-05 0.07 USDC BROADCASTED`. The console ledger scrolls, the leaderboard reorders.
3. **Console.** Point at `buyer-01`. Spent today climbs twice as fast as the others. Click **Kill**. Next terminal line: `buyer-01 → researcher-03 0.31 USDC REFUSED: AGENT_PAUSED: Agent buyer-01 was killed by the owner`. Everyone else keeps paying.
4. **Console.** `owner fleet set-policy researcher dailyLimitUsd=0.5`. A researcher hits `DAILY_LIMIT_EXCEEDED` within a minute. Policy applied live, no restart.
5. **Claude Code.** "Show the fleet." The card: leaderboard, spend bars, Pause all. Tap **Pause all**. Terminal: every line says `FLEET_PAUSED`. Tap **Resume all**.
6. **Close.** "Twenty agents, twenty keys, one policy, one kill switch. Binance gives you one wallet and an app. This is open source, runs anywhere, and the owner never shares a key."

Mainnet variant: 5 agents, 1 USDC each, `SOLANA_CLUSTER=mainnet`, cap 0.5. Same script.
