import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, verifySignature, type Blockhash } from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getApproveInstruction } from "@solana-program/token";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "mainnet";

await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { keygen, walletAddress, loadSigner } = await import("../src/core/signer.js");
const policy = await import("../src/core/policy.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");

const send = <T>(v: T) => ({ send: async () => v });
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
let me: string;
let simAccounts: unknown[] = [];
const rpc = {
  getBalance: () => send({ value: 1_000_000_000n }),
  getTokenAccountsByOwner: (_o: string, f: { programId?: string }) => send({ value: f.programId && !f.programId.startsWith("Tokenkeg") ? [] : [{ pubkey: "7kfnqTWvzH5Nb3Z1WvcyWJoqXy6jkGzhKqpSAYZw1jXk", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: "5000000", decimals: 6 } } } } } }] }),
  getRecentPrioritizationFees: () => send([]),
  getLatestBlockhash: () => send({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000n } }),
  simulateTransaction: () => send({ value: { err: null, logs: ["ok"], unitsConsumed: 1200n, accounts: simAccounts } }),
  sendTransaction: () => send(SIG),
  getSignatureStatuses: () => send({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  getBlockHeight: () => send(900n),
} as never;
const fetchMock = (async (url: string) => {
  if (String(url).includes("/price/v3")) return new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 100 }, [USDC_MINT.mainnet]: { usdPrice: 1 } }));
  return new Response("[]");
}) as unknown as typeof fetch;
let token: string;
const agent = () => createCtx({ role: "agent", token, rpc, fetch: fetchMock });
const owner = () => createCtx({ role: "owner", rpc, fetch: fetchMock });

function unsigned(ixs: Parameters<typeof appendTransactionMessageInstructions>[0], feePayer = me) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" as Blockhash, lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

beforeAll(async () => {
  await keygen();
  me = await walletAddress();
  const s = (await exec(createCtx({ role: "agent" }), "auth.signin", {})) as { qrCodeId: string };
  token = ((await exec(createCtx({ role: "agent" }), "auth.verify", { qrCodeId: s.qrCodeId })) as { token: string }).token;
});

describe("developer mode gate", () => {
  it("blocks until the owner enables it", async () => {
    await expect(exec(agent(), "contract-call.preview", { unsignedTx: unsigned([getAddMemoInstruction({ memo: "hi" })]) })).rejects.toMatchObject({ name: "DEV_MODE_DISABLED" });
    const dm = (await exec(owner(), "owner.dev-mode", { enabled: true, hours: 1, dailyLimitUsd: 50 })) as { enabled: boolean };
    expect(dm.enabled).toBe(true);
  });
});

describe("contract-call", () => {
  it("previews a memo tx with no risks and executes it", async () => {
    simAccounts = [{ lamports: 999_995_000n, data: ["", "base64"] }, { lamports: 2_039_280n, data: { parsed: { info: { tokenAmount: { amount: "5000000" } } } } }];
    const pv = (await exec(agent(), "contract-call.preview", { unsignedTx: unsigned([getAddMemoInstruction({ memo: "hi" })]) })) as Record<string, any>;
    expect(pv.parsedTx.instructions[0].programName).toBe("Memo");
    expect(pv.risks.riskDetails).toEqual([]);
    expect(pv.requireConfirmation).toBe(false);
    expect(pv.simulationResult.balanceChanges).toEqual([{ tokenSymbol: "SOL", tokenAddress: SOL_MINT, amount: "-0.000005", valueUsd: "0.00" }]);
    const ex = (await exec(agent(), "contract-call.execute", { requestId: pv.requestId })) as Record<string, string>;
    expect(ex.status).toBe("BROADCASTED");
    expect(ex.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    await expect(exec(agent(), "contract-call.execute", { requestId: pv.requestId })).rejects.toMatchObject({ name: "TARGET_NOT_FOUND" });
  });
  it("flags authority changes and unknown programs, needs owner confirmation", async () => {
    const approve = getApproveInstruction({ source: address("7kfnqTWvzH5Nb3Z1WvcyWJoqXy6jkGzhKqpSAYZw1jXk"), delegate: address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), owner: address(me), amount: 10n });
    const pv = (await exec(agent(), "contract-call.preview", { unsignedTx: unsigned([approve]) })) as Record<string, any>;
    expect(pv.risks.riskDetails.map((r: { code: string }) => r.code)).toContain("AUTHORITY_CHANGE");
    expect(pv.simulationResult.authorityChanges[0].action).toBe("Approve");
    expect(pv.requireConfirmation).toBe(true);
    const ex = (await exec(agent(), "contract-call.execute", { requestId: pv.requestId })) as Record<string, string>;
    expect(ex.status).toBe("PENDING_CONFIRMATION");
    const ap = (await exec(owner(), "owner.approve", { orderId: ex.orderId })) as { result: { status: string } };
    expect(ap.result.status).toBe("BROADCASTED");
  });
  it("rejects a tx the wallet does not sign and enforces the dev-mode quota", async () => {
    await expect(exec(agent(), "contract-call.preview", { unsignedTx: unsigned([getAddMemoInstruction({ memo: "x" })], "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM") })).rejects.toMatchObject({ name: "INVALID_PARAM" });
    simAccounts = [{ lamports: 100_000_000n, data: ["", "base64"] }, { lamports: 2_039_280n, data: { parsed: { info: { tokenAmount: { amount: "0" } } } } }]; // -0.9 SOL (-$90) and -5 USDC
    const pv = (await exec(agent(), "contract-call.preview", { unsignedTx: unsigned([getAddMemoInstruction({ memo: "drain" })]) })) as Record<string, any>;
    expect(pv.outflowUsd).toBe(95);
    await expect(exec(agent(), "contract-call.execute", { requestId: pv.requestId })).rejects.toMatchObject({ name: "DAILY_LIMIT_EXCEEDED" });
  });
});

describe("sign-message", () => {
  it("signs with the off-chain standard and verifies", async () => {
    const pv = (await exec(agent(), "sign-message.preview", { message: "Sign in to example.com\nnonce: 123" })) as Record<string, any>;
    expect(pv.parsedMessage.messageType).toBe("OffchainMessage");
    expect(pv.requireConfirmation).toBe(false);
    const ex = (await exec(agent(), "sign-message.execute", { requestId: pv.requestId })) as Record<string, any>;
    expect(ex.status).toBe("COMPLETED");
    expect(ex.signature).toHaveLength(128);
    expect(ex.envelopeBase64).toBeTruthy();
    const res = (await exec(agent(), "sign-message.result", { orderId: ex.orderId })) as { status: string; signature: string };
    expect(res).toMatchObject({ status: "COMPLETED", signature: ex.signature });
    const h = (await exec(agent(), "sign-message.history", {})) as { items: { messageType: string }[] };
    expect(h.items[0].messageType).toBe("OffchainMessage");
  });
  it("raw signatures need confirmation and verify against the public key", async () => {
    const pv = (await exec(agent(), "sign-message.preview", { message: "hello raw", signType: "RAW" })) as Record<string, any>;
    expect(pv.requireConfirmation).toBe(true);
    const ex = (await exec(agent(), "sign-message.execute", { requestId: pv.requestId })) as Record<string, any>;
    expect(ex.status).toBe("PENDING_CONFIRMATION");
    expect(((await exec(agent(), "sign-message.result", { orderId: ex.orderId })) as { status: string }).status).toBe("PENDING_CONFIRMATION");
    const ap = (await exec(owner(), "owner.approve", { orderId: ex.orderId })) as { result: { signature: string; status: string } };
    expect(ap.result.status).toBe("COMPLETED");
    const signer = await loadSigner();
    const ok = await verifySignature(signer.keyPair.publicKey, Buffer.from(ap.result.signature, "hex") as never, new TextEncoder().encode("hello raw"));
    expect(ok).toBe(true);
    expect(((await exec(agent(), "sign-message.result", { orderId: ex.orderId })) as { status: string }).status).toBe("COMPLETED");
    await expect(exec(agent(), "sign-message.preview", { message: "x", signType: "EIP712" })).rejects.toMatchObject({ name: "UNSUPPORTED_ON_SOLANA" });
    policy.writePolicy(policy.defaultPolicy());
  });
});
