import { registerBackend, type Backend } from "../core/backend.js";
import { hasKey, loadLocalSigner, localAddress } from "../core/keys.js";
import { keyPath } from "../core/config.js";

registerBackend("local", (): Backend => ({
  kind: "local",
  label: "Self-custody key on this host",
  canSign: true,
  address: localAddress,
  signer: loadLocalSigner,
  async status() {
    return hasKey() ? { connected: true, detail: `key at ${keyPath()}` } : { connected: false, detail: `no key at ${keyPath()}; run \`saw owner keygen\`` };
  },
}));
