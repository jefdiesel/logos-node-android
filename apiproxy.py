# Read-only window onto the node for web pages, plus a small status page at "/".
# Passes GET /cryptarchia/info and /network/info to the node on 127.0.0.1:8080 and answers
# other websites (CORS) only for the origins listed below. Nothing else gets through.
import http.server, urllib.request, sys
ALLOW_ORIGINS = set()  # add your own site here to let it read the status
ALLOW_PATHS = {"/cryptarchia/info", "/network/info"}
PAGE = b"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Logos node on this phone</title>
<style>
:root{--bg:#f6f5f1;--fg:#1c1b19;--dim:#6b675f;--card:#fff;--line:#dedbd3;--ok:#1f7a4d;--warn:#a15c00}
@media(prefers-color-scheme:dark){:root{--bg:#121211;--fg:#eceae4;--dim:#9a968c;--card:#1c1c1a;--line:#2e2d2a;--ok:#5fcf97;--warn:#e2a650}}
body{margin:0;padding:20px 16px;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 2px}p.sub{margin:0 0 18px;color:var(--dim);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
.big{font-size:40px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.lab{color:var(--dim);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}.row span:last-child{font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
#st.ok{color:var(--ok)}#st.warn{color:var(--warn)}
</style></head><body>
<h1>Logos node on this phone</h1><p class="sub">Read from the node running in this phone's Linux box. Updates every 5 seconds.</p>
<div class="card"><div class="lab">Block height</div><div class="big" id="h">-</div><div id="st" class="warn">connecting</div></div>
<div class="card">
<div class="row"><span>State</span><span id="state">-</span></div>
<div class="row"><span>Slot</span><span id="slot">-</span></div>
<div class="row"><span>Peers connected</span><span id="peers">-</span></div>
<div class="row"><span>Blocks per minute</span><span id="rate">-</span></div>
<div class="row"><span>Last update</span><span id="t">-</span></div>
</div>
<script>
let prev=null;const $=id=>document.getElementById(id);
async function tick(){
  try{
    const r=await fetch("/cryptarchia/info",{cache:"no-store"});
    if(!r.ok) throw new Error("node not answering");
    const j=await r.json();const c=j.cryptarchia_info||j;
    $("h").textContent=Number(c.height).toLocaleString();$("slot").textContent=Number(c.slot).toLocaleString();
    $("state").textContent=c.state+(j.phase?" ("+j.phase+")":"");
    $("st").textContent=c.state==="Online"?"online and in sync":"syncing";$("st").className=c.state==="Online"?"ok":"warn";
    const now=Date.now();
    if(prev&&now-prev.t>20000){$("rate").textContent=Math.round((c.height-prev.h)/((now-prev.t)/60000)).toLocaleString();prev={h:c.height,t:now}}
    if(!prev)prev={h:c.height,t:now};
    $("t").textContent=new Date().toLocaleTimeString();
    try{const n=await (await fetch("/network/info",{cache:"no-store"})).json();$("peers").textContent=(n.connected_peers||[]).length}catch(e){}
  }catch(e){
    $("st").textContent="node is starting or replaying its saved blocks; no answer yet";$("st").className="warn";
  }
}
tick();setInterval(tick,5000);
</script></body></html>"""
class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        o = self.headers.get("Origin")
        if o in ALLOW_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET")
            self.send_header("Access-Control-Allow-Private-Network", "true")
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def do_GET(self):
        if self.path == "/":
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(PAGE))); self.end_headers(); self.wfile.write(PAGE); return
        if self.path not in ALLOW_PATHS:
            self.send_response(403); self.cors(); self.end_headers(); return
        try:
            with urllib.request.urlopen("http://127.0.0.1:8080" + self.path, timeout=5) as r:
                b = r.read()
            self.send_response(200); self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        except Exception:
            self.send_response(502); self.cors(); self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, f, *a):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()
