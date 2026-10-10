// Optional agent signer: lets Claude pay without a human scanning anything.
// Opt-in via SOLANA_PAY_SIGNER (path to a keypair JSON). Capped by SOLANA_PAY_DAILY_CAP (USDC/day).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountRole,
  address,
  createClient,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import { type PaymentRequest, USDC_DECIMALS, USDC_MINT, toBaseUnits, fromBaseUnits } from "./pay.js";
import { rpcUrl } from "./solana.js";
import * as store from "./store.js";

const DEFAULT_KEY = join(process.env.SOLANA_PAY_MCP_HOME ?? join(homedir(), ".solana-pay-mcp"), "agent.json");

export function signerPath(): string | undefined {
  return process.env.SOLANA_PAY_SIGNER;
}

export function dailyCapUnits(): bigint {
  return toBaseUnits(process.env.SOLANA_PAY_DAILY_CAP ?? "10");
}

/** `solana-pay-mcp keygen`: write a new keypair (0600) and print its address. Never prints the secret. */
export async function keygen(path = DEFAULT_KEY): Promise<Address> {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a key`);
  // Same layout as `solana-keygen`: 64 bytes = 32-byte seed + 32-byte public key.
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const kp = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const pub = new Uint8Array(getAddressEncoder().encode(kp.address));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(Array.from([...seed, ...pub])), { mode: 0o600 });
  return kp.address;
}

async function loadSigner(): Promise<KeyPairSigner> {
  const p = signerPath();
  if (!p) throw new Error("No signer configured. Set SOLANA_PAY_SIGNER to a keypair file (run `solana-pay-mcp keygen`).");
  const bytes = Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}

export async function signerAddress(): Promise<Address> {
  return (await loadSigner()).address;
}

/** USDC the signer has sent in the last 24h, from our own records. */
export function spentLast24h(): bigint {
  const since = Date.now() - 24 * 3600 * 1000;
  return store
    .all()
    .filter((r) => r.kind === "payment" && r.paidTx && r.matchedBy === "signer" && Date.parse(r.paidAt!) >= since)
    .reduce((acc, r) => acc + toBaseUnits(r.amount), 0n);
}

export interface Executed {
  tx: string;
  from: Address;
  remainingCap: string;
}

/** Build, simulate, sign and send a USDC transfer for `req`. Enforces the daily cap first. */
export async function execute(req: PaymentRequest): Promise<Executed> {
  const amount = toBaseUnits(req.amount);
  const cap = dailyCapUnits();
  const spent = spentLast24h();
  if (spent + amount > cap) {
    throw new Error(
      `Daily cap exceeded: cap ${fromBaseUnits(cap)} USDC, spent ${fromBaseUnits(spent)} in 24h, requested ${req.amount}.`,
    );
  }

  const kp = await loadSigner();
  const client = createClient()
    .use(signerPlugin(kp))
    .use(solanaRpc({ rpcUrl: rpcUrl(), transactionConfig: { version: 1 } }));

  const mint = address(USDC_MINT[req.cluster]);
  const recipient = address(req.recipient);
  const [fromAta] = await findAssociatedTokenPda({ mint, owner: kp.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [toAta] = await findAssociatedTokenPda({ mint, owner: recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const transfer = getTransferCheckedInstruction({
    source: fromAta,
    mint,
    destination: toAta,
    authority: kp,
    amount,
    decimals: USDC_DECIMALS,
  });
  // Solana Pay convention: append the reference as a read-only account so check_payment can find this tx.
  const transferWithRef = {
    ...transfer,
    accounts: [...transfer.accounts, { address: address(req.reference), role: AccountRole.READONLY }],
  };

  const result = await client.sendTransaction([
    getCreateAssociatedTokenIdempotentInstruction({ payer: kp, owner: recipient, mint, ata: toAta }),
    transferWithRef,
    getAddMemoInstruction({ memo: `${req.id} ${req.memo}`.slice(0, 200) }),
  ]);

  return { tx: result.context.signature, from: kp.address, remainingCap: fromBaseUnits(cap - spent - amount) };
}
