# Two-minute demo script

Record with Claude Code on the left, Phantom (devnet) on the phone, Solana Explorer on the right.

0:00  Title card: "Stripe agent toolkit, but USDC on Solana, no bank."
0:10  Terminal: `claude mcp add solana-pay -e SOLANA_PAY_RECIPIENT=<wallet> -e SOLANA_CLUSTER=devnet -- solana-pay-mcp`
0:25  Claude Code: "Invoice Acme 1.5 USDC for the October retainer."
      → tool call create_invoice → link + QR appear.
0:45  Phone: scan QR in Phantom, approve. Show the 1.5 USDC confirmation.
1:05  Claude Code: "Did Acme pay?"
      → check_payment → "PAID. 1.5 USDC ... explorer link".
1:20  Click explorer link. Point at the reference key in the account list and the USDC transfer.
1:35  Claude Code: "Pay Maria 0.25 USDC for the logo."
      → send_payment → QR. Scan, approve. "Check it." → PAID.
1:50  Close: "No keys on the server. Any wallet. Open source, MIT. github.com/monkebo/solana-pay-mcp"

Prep: two devnet wallets with USDC (faucet: https://faucet.circle.com, pick Solana devnet). Set SOLANA_PAY_RECIPIENT to wallet A, pay from wallet B.
