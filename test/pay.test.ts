import { describe, expect, it } from "vitest";
import { fromBaseUnits, isPaid, solanaPayUrl, toBaseUnits, usdcReceived, USDC_MINT, type PaymentRequest } from "../src/pay.js";

const req: PaymentRequest = {
  id: "inv_test",
  kind: "invoice",
  recipient: "Rec1pient1111111111111111111111111111111111",
  amount: "12.5",
  memo: "logo",
  reference: "Ref3rence1111111111111111111111111111111111",
  cluster: "devnet",
  createdAt: "2026-10-10T00:00:00Z",
};

describe("amounts", () => {
  it("round-trips base units", () => {
    expect(toBaseUnits("12.5")).toBe(12_500_000n);
    expect(toBaseUnits("3000")).toBe(3_000_000_000n);
    expect(toBaseUnits("0.000001")).toBe(1n);
    expect(fromBaseUnits(12_500_000n)).toBe("12.5");
    expect(fromBaseUnits(3_000_000_000n)).toBe("3000");
  });
  it("rejects junk", () => {
    expect(() => toBaseUnits("1.1234567")).toThrow();
    expect(() => toBaseUnits("-1")).toThrow();
    expect(() => toBaseUnits("abc")).toThrow();
  });
});

describe("solana pay url", () => {
  it("encodes recipient, mint, amount, reference", () => {
    const url = solanaPayUrl(req);
    expect(url.startsWith(`solana:${req.recipient}?`)).toBe(true);
    const q = new URL(url.replace("solana:", "https://x/")).searchParams;
    expect(q.get("amount")).toBe("12.5");
    expect(q.get("spl-token")).toBe(USDC_MINT.devnet);
    expect(q.get("reference")).toBe(req.reference);
    expect(q.get("memo")).toBe("inv_test");
  });
});

describe("paid detection", () => {
  const mint = USDC_MINT.devnet;
  const meta = (pre: string, post: string, err: unknown = null) => ({
    err,
    preTokenBalances: [{ mint, owner: req.recipient, uiTokenAmount: { amount: pre } }],
    postTokenBalances: [{ mint, owner: req.recipient, uiTokenAmount: { amount: post } }],
  });
  it("counts the recipient's USDC delta", () => {
    expect(usdcReceived(meta("0", "12500000"), req.recipient, mint)).toBe(12_500_000n);
  });
  it("paid when delta >= amount, even with a fresh token account (no pre balance)", () => {
    expect(isPaid(meta("0", "12500000"), req)).toBe(true);
    expect(isPaid({ err: null, postTokenBalances: meta("0", "99000000").postTokenBalances }, req)).toBe(true);
  });
  it("unpaid when short, wrong mint, wrong owner, or tx failed", () => {
    expect(isPaid(meta("0", "12499999"), req)).toBe(false);
    expect(isPaid(meta("0", "12500000", { InstructionError: [0, "Custom"] }), req)).toBe(false);
    const wrongMint = meta("0", "12500000");
    wrongMint.postTokenBalances[0].mint = USDC_MINT.mainnet;
    expect(isPaid(wrongMint, req)).toBe(false);
    const wrongOwner = meta("0", "12500000");
    wrongOwner.postTokenBalances[0].owner = "Other";
    expect(isPaid(wrongOwner, req)).toBe(false);
  });
});

describe("daily cap", () => {
  it("blocks a payment that would exceed the cap", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.SOLANA_PAY_MCP_HOME = mkdtempSync(join(tmpdir(), "spm-"));
    process.env.SOLANA_PAY_DAILY_CAP = "5";
    process.env.SOLANA_PAY_SIGNER = "/nonexistent"; // cap check runs before the key is read
    const store = await import("../src/store.js");
    const { execute } = await import("../src/signer.js");
    store.put({ ...req, id: "pay_old", kind: "payment", amount: "4", paidTx: "x", paidAt: new Date().toISOString(), matchedBy: "signer" });
    await expect(execute({ ...req, id: "pay_new", kind: "payment", amount: "2" })).rejects.toThrow(/Daily cap exceeded/);
  });
});

describe("contacts", () => {
  it("resolves saved names and raw addresses, rejects junk", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.SOLANA_PAY_MCP_HOME = mkdtempSync(join(tmpdir(), "spm-"));
    const c = await import("../src/contacts.js");
    const addr = "GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf";
    c.save("Kevin", addr);
    expect(c.resolve("kevin")).toBe(addr);
    expect(c.resolve(" KEVIN ")).toBe(addr);
    expect(c.resolve(addr)).toBe(addr);
    expect(() => c.resolve("nico")).toThrow(/Unknown contact/);
  });
});
