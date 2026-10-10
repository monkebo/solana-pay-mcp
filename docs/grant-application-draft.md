# Solana Foundation AI grant — draft answers (rewrite in your own words before submitting)

Apply at https://solana.com/developers/ai → category "AI". Up to $25K. Public code required.

**Project name.** solana-pay-mcp

**One sentence.** An open-source MCP server that lets Claude and any MCP agent invoice, get paid, and pay in USDC on Solana, with no private keys on the server.

**Problem.** Stripe's agent toolkit is installed ~90k times a month because people want their AI assistant to handle invoices and payments. It costs 2.9% + 30¢ and needs a bank. Solana has the rails (USDC, ~200ms, sub-cent fees, Solana Pay) but no MCP tool for them. Existing Solana MCP servers are read-only RPC wrappers.

**What exists today (public, MIT).** Four tools: create_invoice, send_payment, check_payment, list_requests. Solana Pay links with a fresh reference key per request; settlement verified from on-chain token balances. Unit tests, CI, stdio smoke test. Devnet by default, mainnet by env.

**What the grant funds (8 weeks).**
1. monthly_report: payer, amount, invoice, tx, category; CSV/PDF for accountants.
2. flag_anomalies: unknown payer, duplicate invoice, amount mismatch (LLM-assisted classification, deterministic numbers).
3. create_recurring on solana-foundation/subscriptions.
4. 402-gated report endpoint via pay-kit, listed on pay.sh, so agents can buy a wallet report per call.
5. Hosted version with embedded wallets for non-crypto users.
6. Docs, examples for Claude Code, Claude Desktop, Cursor.

**Why me.** 6+ years ML/NLP engineer (LangGraph agents, RAG, classification in production). Based in Buenos Aires, where 50%+ of freelancers are paid in stablecoins. I am user one.

**Open source.** MIT. https://github.com/monkebo/solana-pay-mcp

**Budget ask.** $15–25K: 8 weeks of development, RPC costs, design for hosted version.

**Success metrics.** 500 npm installs, 50 wallets with ≥1 settled invoice, listed on pay.sh catalog, 3 ecosystem projects integrating the report tool.
