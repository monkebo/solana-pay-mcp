import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));

const { parseArgv } = await import("../src/cli/args.js");
const policy = await import("../src/core/policy.js");
const session = await import("../src/core/session.js");
const orders = await import("../src/core/orders.js");
const { WalletError } = await import("../src/core/errors.js");
await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { buildParams } = await import("../src/cli/main.js");
const { matchCli } = await import("../src/core/registry.js");

describe("argv", () => {
  it("splits words, flags, positionals and --json", () => {
    const p = parseArgv(["wallet", "send", "--amount", "1.5", "--recipient=abc", "--max", "--json", "--order-id", "x"]);
    expect(p.words).toEqual(["wallet", "send"]);
    expect(p.flags).toEqual({ amount: "1.5", recipient: "abc", max: true, orderId: "x" });
    expect(p.json).toBe(true);
  });
  it("maps variadic positionals", () => {
    const m = matchCli(["owner", "set-policy", "a=1", "b=2"])!;
    expect(m.cmd.name).toBe("owner.set-policy");
    expect(buildParams(m.cmd, m.rest, {})).toEqual({ assignments: ["a=1", "b=2"] });
  });
});

describe("policy", () => {
  it("defaults fail closed and patch with dot paths", () => {
    const p = policy.readPolicy();
    expect(p.addressBookOnly).toBe(true);
    expect(p.tradeAllTokens).toBe(false);
    const q = policy.patchPolicy({ dailyLimitUsd: "300", allowedTokens: '["a","b"]' });
    expect(q.dailyLimitUsd).toBe(300);
    expect(q.allowedTokens).toEqual(["a", "b"]);
    expect(() => policy.patchPolicy({ nope: "1" })).toThrow(WalletError);
    policy.writePolicy(policy.defaultPolicy());
  });
});

describe("sessions", () => {
  it("pairing → approve → token → authenticate → revoke", () => {
    const p = session.startPairing("test");
    expect(p.pairingCode).toMatch(/^\d{6}$/);
    expect(session.pollPairing(p.id).status).toBe("PENDING");
    session.approvePairing(p.pairingCode);
    const r = session.pollPairing(p.id);
    expect(r.status).toBe("APPROVED");
    expect(r.token).toHaveLength(64);
    expect(session.pollPairing(p.id).token).toBeUndefined(); // handed out once
    const s = session.authenticate(r.token);
    expect(s.expiresAt).toBeGreaterThan(Date.now());
    expect(session.revoke(r.token)).toBe(true);
    expect(() => session.authenticate(r.token)).toThrow(/Session not found/);
  });
  it("expires by max duration", () => {
    policy.patchPolicy({ maxSigninDuration: "1s" });
    const p = session.startPairing();
    session.approvePairing(p.pairingCode);
    const { token } = session.pollPairing(p.id);
    const s = session.sessions.get(session.hash(token!))!;
    session.sessions.put({ ...s, expiresAt: Date.now() - 1 });
    expect(() => session.authenticate(token)).toThrow(/expired/);
    policy.writePolicy(policy.defaultPolicy());
  });
});

describe("orders, quotas and lock", () => {
  it("counts quota per category over 24h and ignores failed", () => {
    orders.orders.write([]);
    orders.newOrder({ kind: "send", category: "general", status: "CONFIRMED", usdValue: 40, summary: "a" });
    orders.newOrder({ kind: "send", category: "general", status: "FAILED", usdValue: 1000, summary: "b" });
    orders.newOrder({ kind: "x402", category: "x402", status: "COMPLETED", usdValue: 5, summary: "c" });
    expect(orders.quotaUsed("general")).toBe(40);
    expect(orders.quotaUsed("x402")).toBe(5);
    const p = policy.readPolicy();
    expect(() => orders.assertQuota("general", 61, p)).toThrow(/daily limit exceeded/);
    orders.assertQuota("general", 60, p);
  });
  it("locks while confirmation pending and expires it", () => {
    orders.orders.write([]);
    const o = orders.queueForConfirmation({ kind: "send", category: "general", usdValue: 1, summary: "x" }, { command: "wallet.send", params: {} }, ["test"]);
    expect(() => orders.assertUnlocked()).toThrow(/locked/);
    orders.setOrder(o.id, { expiresAt: Date.now() - 1 });
    orders.assertUnlocked();
    expect(orders.orders.get(o.id)!.status).toBe("EXPIRED");
  });
});

describe("registry access control", () => {
  beforeAll(() => orders.orders.write([]));
  it("blocks owner commands for agents and session commands without token", async () => {
    const agent = createCtx({ role: "agent", token: null });
    await expect(exec(agent, "owner.policy", {})).rejects.toMatchObject({ name: "OWNER_REQUIRED" });
    await expect(exec(agent, "wallet.settings", {})).rejects.toMatchObject({ name: "NOT_SIGNED_IN" });
    expect(await exec(agent, "wallet.status", {})).toEqual({ status: "UNCONNECTED" });
  });
  it("local signin auto-approves and returns a token once", async () => {
    const agent = createCtx({ role: "agent", token: null });
    const s = (await exec(agent, "auth.signin", {})) as { qrCodeId: string };
    const v = (await exec(agent, "auth.verify", { qrCodeId: s.qrCodeId })) as { status: string; token: string };
    expect(v.status).toBe("SUCCESS");
    const authed = createCtx({ role: "agent", token: v.token });
    const settings = (await exec(authed, "wallet.settings", {})) as { quotaLeft: number };
    expect(settings.quotaLeft).toBe(100);
    expect(await exec(authed, "auth.signout", {})).toEqual({ status: "LOGGED_OUT" });
    await expect(exec(authed, "wallet.settings", {})).rejects.toMatchObject({ name: "NOT_SIGNED_IN" });
  });
  it("rejects bad params with INVALID_PARAM", async () => {
    await expect(exec(createCtx({ role: "owner" }), "owner.add-contact", { name: "x" })).rejects.toMatchObject({ name: "INVALID_PARAM" });
  });
});
