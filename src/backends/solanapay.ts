// A human's wallet as the backend. The agent prepares the payment under policy; the owner scans a Solana Pay
// QR / opens the link in Phantom, Solflare or Backpack and signs. Settlement is detected by the reference key.
import { address } from "@solana/kit";
import QRCode from "qrcode";
import { registerBackend, type Backend, type BackendConfig } from "../core/backend.js";
import { WalletError } from "../core/errors.js";
import { newReference, transferRequestUrl } from "../core/pay.js";

registerBackend("solana-pay", (cfg: BackendConfig): Backend => {
  const c = cfg.solanaPay;
  if (!c?.address) throw new WalletError("INVALID_PARAM", "backend.solanaPay.address is required for the solana-pay backend.");
  const me = address(c.address);
  return {
    kind: "solana-pay",
    label: c.label ?? "Human wallet via Solana Pay (scan to sign)",
    canSign: false,
    async address() {
      return me;
    },
    async signer() {
      throw new WalletError("NOT_SUPPORTED", "The solana-pay backend cannot sign: the owner signs in their own wallet. Use `wallet send` (returns a link/QR), or switch backend.");
    },
    async status() {
      return { connected: true, detail: `human wallet ${me}; payments are approved by scanning` };
    },
    async send(_ctx, p, params) {
      if (p.token.native) throw new WalletError("NOT_SUPPORTED", "Solana Pay transfer requests here are for SPL tokens; send SOL from the wallet app directly.");
      const reference = params.reference ?? (await newReference());
      const url = transferRequestUrl({ recipient: p.to, amount: p.amount, mint: p.token.mint, reference, memo: params.memo, message: p.summary });
      const qr = await QRCode.toString(url, { type: "svg", margin: 1 });
      return { txHash: null, status: "PENDING", extra: { payUrl: url, qrSvg: qr, reference, note: "Open the link or scan the QR in your wallet and approve. Status: `wallet tx-history --type pending`." } };
    },
  };
});
