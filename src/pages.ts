// Server-rendered pages: the owner console (pairings, approvals, backend, policy) and the invoice pay page.
import QRCode from "qrcode";
import type { invoiceView } from "./core/invoice.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#fff;--fg:#15201c;--muted:#5c6b64;--line:#d9ded9;--accent:#0f8a5f;--accent-fg:#fff;--soft:#eef6f2;--bad:#b42318;color-scheme:light}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16201b;--fg:#e8ece8;--muted:#9aa8a0;--line:#2a3530;--accent:#3dcf96;--accent-fg:#0b1410;--soft:#1c2b24;--bad:#f97066;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px;display:flex;flex-direction:column;gap:20px}
h1{font-size:20px;margin:0}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
section{border:1px solid var(--line);border-radius:12px;padding:16px}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}.muted{color:var(--muted)}.bad{color:var(--bad)}
button{font:600 14px system-ui;border-radius:8px;padding:9px 14px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}button:disabled{opacity:.5}
input,select,textarea{font:14px system-ui;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:100%}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:1}.row>button{flex:0 0 auto}
.pill{font:600 11px ui-monospace,Menlo,monospace;padding:3px 8px;border-radius:99px;background:var(--soft);color:var(--accent)}.pill.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:14px}
.amount{font:600 34px/1.1 ui-monospace,Menlo,monospace}.qr{width:220px;max-width:100%;background:#fff;padding:8px;border-radius:8px}.qr svg{display:block;width:100%;height:auto}
a{color:var(--accent)}
`;

export function ownerConsoleHtml(publicUrl: string, pairingCode = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>saw owner console</title><style>${CSS}</style></head><body><main>
<h1>Wallet owner console</h1>
<section><h2>Owner token</h2><div class="row"><input id="tok" type="password" placeholder="paste the owner token (see the vault's startup log)"><button class="primary" onclick="saveTok()">Use</button></div><div id="msg" class="muted"></div></section>
<section><h2>Status</h2><div id="status" class="muted">…</div></section>
<section><h2>Agent sign-in requests</h2><div class="row"><input id="code" placeholder="6-digit pairing code" value="${esc(pairingCode)}"><button class="primary" onclick="run('owner.approve-pairing',{pairingCode:v('code')})">Approve</button><button onclick="run('owner.reject-pairing',{pairingCode:v('code')})">Reject</button></div><div id="pairings"></div></section>
<section><h2>Waiting for your approval</h2><div id="pending" class="muted">…</div></section>
<section><h2>Wallet backend</h2><div class="row"><select id="bk"><option value="local">local: self-custody key on the vault</option><option value="baw">baw: Binance Agentic Wallet</option><option value="signer">signer: HTTP remote signer</option><option value="solana-pay">solana-pay: a human's wallet (scan to sign)</option></select><button class="primary" onclick="setBackend()">Switch</button></div>
<div class="row" style="margin-top:8px"><input id="bk-url" placeholder="signer URL"><input id="bk-token" placeholder="signer token"><input id="bk-address" placeholder="address (signer / solana-pay)"></div><div id="backend" class="muted"></div></section>
<section><h2>Policy</h2><textarea id="policy" rows="14" class="mono"></textarea><div class="row" style="margin-top:8px"><button class="primary" onclick="savePolicy()">Save policy</button><button onclick="run('owner.revoke-sessions',{})">Sign every agent out</button></div></section>
<section><h2>Address book</h2><div class="row"><input id="cn" placeholder="name"><input id="ca" placeholder="Solana address"><button class="primary" onclick="run('owner.add-contact',{name:v('cn'),address:v('ca')})">Add</button></div><div id="contacts"></div></section>
<script>
const BASE=${JSON.stringify(publicUrl)};
const v=id=>document.getElementById(id).value.trim();
const say=(t,bad)=>{const m=document.getElementById('msg');m.textContent=t;m.className=bad?'bad':'muted'};
function tok(){return localStorage.getItem('saw-owner-token')||''}
function saveTok(){localStorage.setItem('saw-owner-token',v('tok'));say('token saved');refresh()}
async function call(command,params){const r=await fetch(BASE+'/v1/owner/exec',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tok()},body:JSON.stringify({command,params})});const j=await r.json();if(!j.success)throw new Error(j.error.name+': '+j.error.message);return j.data}
async function run(command,params){try{await call(command,params);say('ok: '+command);await refresh()}catch(e){say(e.message,true)}}
async function setBackend(){const kind=v('bk');const p={kind};if(v('bk-url'))p.url=v('bk-url');if(v('bk-token'))p.token=v('bk-token');if(v('bk-address'))p.address=v('bk-address');await run('owner.set-backend',p)}
async function savePolicy(){try{const p=JSON.parse(v('policy'));const a=Object.entries(p).filter(([k])=>k!=='version').map(([k,x])=>k+'='+JSON.stringify(x));await call('owner.set-policy',{assignments:a});say('policy saved');refresh()}catch(e){say(e.message,true)}}
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
async function refresh(){if(!tok()){say('enter the owner token');return}
try{const st=await call('owner.status',{});const bk=await call('owner.backends',{});
document.getElementById('status').innerHTML='Address: <span class="mono">'+e(st.address)+'</span><br>Backend: <b>'+e(bk.active.kind)+'</b> '+e(bk.active.label)+' <span class="pill '+(bk.active.connected?'':'bad')+'">'+(bk.active.connected?'CONNECTED':'NOT READY')+'</span><br><span class="muted">'+e(bk.active.detail)+'</span><br>Sessions: '+st.sessions+' · pending approvals: '+st.pendingConfirmations+' · pairing requests: '+st.pendingPairings;
document.getElementById('bk').value=bk.active.kind;
const pr=await call('owner.pairings',{});document.getElementById('pairings').innerHTML=pr.length?pr.map(p=>'<div class="row"><span>code <b class="mono">'+e(p.pairingCode)+'</b> '+e(p.label||'')+'</span><button class="primary" onclick="run(\\'owner.approve-pairing\\',{pairingCode:\\''+e(p.pairingCode)+'\\'})">Approve</button><button onclick="run(\\'owner.reject-pairing\\',{pairingCode:\\''+e(p.pairingCode)+'\\'})">Reject</button></div>').join(''):'<span class="muted">none</span>';
const pd=await call('owner.pending',{});document.getElementById('pending').innerHTML=pd.length?pd.map(o=>'<div style="margin:8px 0"><b>'+e(o.summary)+'</b> <span class="pill">$'+e((o.usdValue??0).toFixed(2))+'</span><br><span class="muted">'+e((o.reasons||[]).join('; '))+'</span><div class="row" style="margin-top:6px"><button class="primary" onclick="run(\\'owner.approve\\',{orderId:\\''+e(o.id)+'\\'})">Approve</button><button onclick="run(\\'owner.reject\\',{orderId:\\''+e(o.id)+'\\'})">Reject</button></div></div>').join(''):'<span class="muted">nothing waiting</span>';
const pol=await call('owner.policy',{});document.getElementById('policy').value=JSON.stringify(pol,null,2);
const cs=await call('owner.contacts',{});document.getElementById('contacts').innerHTML='<table>'+cs.map(c=>'<tr><td>'+e(c.name)+'</td><td class="mono">'+e(c.address)+'</td><td><button onclick="run(\\'owner.remove-contact\\',{name:\\''+e(c.name)+'\\'})">remove</button></td></tr>').join('')+'</table>';
say('')}catch(err){say(err.message,true)}}
document.getElementById('tok').value=tok();refresh();setInterval(refresh,5000);
</script></main></body></html>`;
}

export async function payPageHtml(inv: ReturnType<typeof invoiceView>, transferUrl: string, txRequestUrl: string): Promise<string> {
  const qr1 = await QRCode.toString(txRequestUrl, { type: "svg", margin: 1 });
  const qr2 = await QRCode.toString(transferUrl, { type: "svg", margin: 1 });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${esc(inv.id)}</title><style>${CSS}</style></head><body><main>
<h1>Invoice ${esc(inv.id)}</h1>
<section><div class="amount">${esc(inv.amount)} <span class="muted" style="font-size:18px">USDC</span></div><div>${esc(inv.memo)}</div><div class="muted">on Solana ${esc(inv.cluster)} · pay to <span class="mono">${esc(inv.recipient)}</span></div>
<div id="state" style="margin-top:10px"><span class="pill ${inv.paid ? "" : "bad"}">${esc(inv.status)}</span></div></section>
<section><h2>Scan with any Solana wallet</h2><div class="row"><div><div class="qr">${qr1}</div><div class="muted">Phantom, Solflare, Backpack: the wallet fetches the exact transaction (reference and memo included).</div></div><div><div class="qr">${qr2}</div><div class="muted">Plain transfer request, for wallets without transaction-request support.</div></div></div>
<div style="margin-top:10px"><a href="${esc(transferUrl)}">Open in wallet</a> · <span class="mono">${esc(inv.recipient)}</span></div></section>
<script>
async function poll(){try{const r=await fetch(location.pathname+'/status');const j=await r.json();const d=j.data;const el=document.getElementById('state');
if(d.paid){el.innerHTML='<span class="pill">'+d.status+'</span> '+(d.payerLabel?('paid by <b>'+d.payerLabel+'</b> '):'')+(d.payer?('<span class="mono">'+d.payer+'</span> '):'')+(d.confidence==='probable'?'<span class="muted">(matched by inflow)</span> ':'')+'<a href="'+d.explorer+'">view transaction</a>';}
}catch(e){}}
poll();setInterval(poll,3000);
</script></main></body></html>`;
}
