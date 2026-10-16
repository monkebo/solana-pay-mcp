# Demo script (90 seconds)

Split screen. Left: Claude Desktop with this MCP. Right: the owner console (`saw vault serve`, open `/`).

0:00  "Pay this month's five contractors." Claude calls `wallet_pay_many` (dry run) → card with five rows and the USD total. Click **Pay all**.
0:15  Backend is `baw`: rows one and two leave through Binance Agentic Wallet. Explorer links appear.
0:30  Owner console → Backend → `local` → Switch. Rows three to five leave from the self-custody key. Same policy, same ledger.
0:50  Row five is to a new address: card shows **Waiting for owner approval**. Approve it in the console. It goes.
1:05  "Invoice Acme 120 USDC for October." Card with QR. Scan from a phone wallet. Card flips to SETTLED with the payer label.
1:20  Console → Backend → `signer` (remote custodian) → send one more. "Your wallet vendor changed. Your agents did not notice."

Prep: two devnet wallets with USDC (faucet.circle.com), a Binance agentic wallet signed in on Solana devnet or mainnet with a few dollars, `saw owner add-contact` for four of the five contractors.
