#!/usr/bin/env node

/**
 * Laminar MCP — Interactive Setup
 *
 * Step 1: Sign in with Laminar credentials (required)
 * Step 2: Advanced — configure Elasticsearch, CRON (optional)
 * Tokens + config stored, MCP server registered with Cursor.
 */

import http from "node:http";
import { exec } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { saveServiceConfig, CONFIG_PATH } from "./config.js";

const MCP_ENTRY = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "index.js"
);

const TOKEN_PATH = path.join(os.homedir(), ".laminar", "tokens.json");

// ─── Helpers ─────────────────────────────────────────────────

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

function jsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── HTML ────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Laminar — Connect to Cursor</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  *,:before,:after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --brand:100 110 203;
    --primary:hsl(231 48% 62%);--primary-hover:hsl(240 65% 60%);--primary-active:hsl(228 43% 59%);
    --success:hsl(158 58% 45%);--danger:hsl(355 78% 60%);
    --bg:#f8f9fc;--surface:#fff;--surface-2:#f3f4f8;--border:#e2e5f1;
    --text:#111;--text-secondary:#4b5563;--text-muted:#9ca3af;
    --radius:10px;--font:'Inter',system-ui,sans-serif;--mono:'SF Mono','Fira Code','Cascadia Code',monospace;
  }

  html{font-size:14px}
  body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}

  .wrapper{width:100%;max-width:440px}
  .logo-row{display:flex;align-items:center;gap:10px;margin-bottom:24px}
  .logo-row svg{flex-shrink:0}
  .logo-row .wordmark{font-size:18px;font-weight:700;letter-spacing:-.3px}
  .logo-row .badge{font-size:11px;font-weight:600;color:var(--primary);background:rgb(var(--brand)/.08);padding:2px 8px;border-radius:20px;margin-left:auto}

  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:12px}
  .card h2{font-size:16px;font-weight:600;margin-bottom:4px}
  .card p.desc{font-size:13px;color:var(--text-secondary);margin-bottom:20px;line-height:1.45}

  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;font-weight:500;color:var(--text-secondary);margin-bottom:5px;letter-spacing:.01em}
  .field .input-wrap{position:relative}
  .field input[type="email"],.field input[type="password"],.field input[type="text"]{
    width:100%;height:36px;padding:0 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;
    color:var(--text);font-size:13px;font-family:var(--font);outline:none;transition:border-color .15s,box-shadow .15s;
  }
  .field input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgb(var(--brand)/.1)}
  .field input[type="password"]{padding-right:36px}
  .toggle-pw{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px;display:flex}
  .toggle-pw:hover{color:var(--text-secondary)}

  .seg{display:flex;background:var(--surface-2);border-radius:7px;padding:3px;gap:2px}
  .seg label{flex:1;text-align:center;padding:6px 0;font-size:12px;font-weight:500;border-radius:5px;cursor:pointer;color:var(--text-secondary);transition:all .15s;user-select:none}
  .seg input{display:none}
  .seg input:checked+span{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .seg label span{display:block;padding:6px 0;border-radius:5px;transition:all .15s}

  .btn-primary{
    width:100%;height:36px;margin-top:6px;background:var(--primary);color:#fff;border:none;border-radius:7px;
    font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;transition:background .15s;
    display:flex;align-items:center;justify-content:center;gap:6px;
  }
  .btn-primary:hover{background:var(--primary-hover)}
  .btn-primary:active{background:var(--primary-active)}
  .btn-primary:disabled{opacity:.55;cursor:not-allowed}
  .btn-ghost{
    width:100%;height:36px;background:none;border:1px solid var(--border);border-radius:7px;color:var(--text);
    font-size:13px;font-weight:500;font-family:var(--font);cursor:pointer;transition:all .15s;
    display:flex;align-items:center;justify-content:center;gap:6px;
  }
  .btn-ghost:hover{background:var(--surface-2);border-color:var(--text-muted)}
  .btn-danger{color:var(--danger);border-color:hsl(355 78% 60%/.25)}
  .btn-danger:hover{background:hsl(355 78% 60%/.06);border-color:var(--danger)}

  .alert{padding:10px 12px;border-radius:7px;font-size:12px;line-height:1.4;display:none;margin-top:12px}
  .alert.show{display:block}
  .alert-error{background:hsl(355 78% 60%/.07);border:1px solid hsl(355 78% 60%/.18);color:var(--danger)}
  .alert-success{background:hsl(158 58% 45%/.07);border:1px solid hsl(158 58% 45%/.18);color:hsl(158 58% 45%)}

  .session{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;font-size:12px;margin-bottom:12px}
  .session .dot{width:7px;height:7px;border-radius:50%;background:var(--success);flex-shrink:0}
  .session .info{flex:1;color:var(--text-secondary)}
  .session .info strong{color:var(--text);font-weight:600}
  .session button{background:none;border:none;color:var(--danger);font-size:12px;font-weight:500;cursor:pointer;padding:2px 6px;border-radius:4px}
  .session button:hover{background:hsl(355 78% 60%/.08)}

  .done-icon{width:48px;height:48px;border-radius:50%;background:hsl(158 58% 45%/.1);display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
  .done-icon svg{color:var(--success)}
  .done h2{text-align:center;margin-bottom:4px}
  .done p{text-align:center;color:var(--text-secondary);font-size:13px;margin-bottom:16px}
  .code-block{
    background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:12px;
    font-family:var(--mono);font-size:11px;line-height:1.5;overflow-x:auto;white-space:pre;color:var(--text-secondary);
  }

  .spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .5s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .step{display:none}.step.active{display:block}
  .footer{text-align:center;margin-top:16px;font-size:11px;color:var(--text-muted)}
  .footer a{color:var(--primary);text-decoration:none}
  .footer a:hover{text-decoration:underline}
  .mt-12{margin-top:12px}
  .mb-12{margin-bottom:12px}

  .divider{border:none;border-top:1px solid var(--border);margin:20px 0}
  .section-label{font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .section-label .tag{font-size:10px;font-weight:600;color:var(--text-muted);background:var(--surface-2);padding:2px 6px;border-radius:4px;text-transform:uppercase}
  .hint{font-size:11px;color:var(--text-muted);margin-top:4px}
  .svc-status{display:flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;padding:6px 10px;border-radius:6px;background:var(--surface-2)}
  .svc-status .dot-on{width:6px;height:6px;border-radius:50%;background:var(--success)}
  .svc-status .dot-off{width:6px;height:6px;border-radius:50%;background:var(--text-muted)}
</style>
</head>
<body>
<div class="wrapper">
  <div class="logo-row">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 118 98" width="36" height="30"><rect width="118" height="98" rx="10" ry="10" fill="#646ecb"/><g transform="translate(5.2,-4.6) scale(1.39)" fill="#fff"><path d="M27.4 59L10.6 38.5 27.4 17.7l4.6 3.7L18.2 38.4l13.8 16.9z"/><path d="M49.6 59l-4.6-3.7L58.9 38.3 45.1 21.4l4.6-3.7L66.5 38.3z"/></g></svg>
    <span class="wordmark">Laminar</span>
    <span class="badge">MCP</span>
  </div>

  <div id="session-banner" class="session" style="display:none">
    <div class="dot"></div>
    <div class="info">Connected to <strong id="s-region"></strong> &middot; expires <span id="s-expires"></span></div>
    <button onclick="doLogout()">Sign out</button>
  </div>

  <!-- Step 1: Sign in -->
  <div class="step active" id="step-login">
    <div class="card">
      <h2>Connect to Cursor</h2>
      <p class="desc">Sign in with your Laminar account to enable the MCP integration in your editor.</p>
      <form id="login-form" autocomplete="on">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" placeholder="you@company.com" autocomplete="email" autofocus />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <div class="input-wrap">
            <input id="password" type="password" placeholder="••••••••" autocomplete="current-password" />
            <button type="button" class="toggle-pw" onclick="togglePw()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
        <div class="field">
          <label>Region</label>
          <div class="seg">
            <label><input type="radio" name="region" value="api.laminar.run" checked /><span>US</span></label>
            <label><input type="radio" name="region" value="ca.api.laminar.run" /><span>Canada</span></label>
          </div>
        </div>
        <button type="submit" class="btn-primary" id="btn-login">Sign in</button>
      </form>
      <div class="alert alert-error" id="login-error"></div>
    </div>
    <div class="footer">
      <a href="https://app.laminar.run/auth/signup" target="_blank">Create an account</a>
      &nbsp;&middot;&nbsp;
      <a href="https://docs.laminar.run" target="_blank">Documentation</a>
    </div>
  </div>

  <!-- Step 2: Advanced Settings -->
  <div class="step" id="step-advanced">
    <div class="card">
      <h2>Advanced Settings</h2>
      <p class="desc">Optional services that unlock extra MCP tools. Skip any you don't need.</p>

      <div class="section-label">Elasticsearch <span class="tag">Log Search</span></div>
      <p class="hint mb-12">Enables search_logs, search_across_workflows, and keyword-based incident investigation.</p>
      <div class="field">
        <label for="es-endpoint">Elasticsearch Endpoint</label>
        <input id="es-endpoint" type="text" placeholder="https://your-cluster.es.cloud.io" />
      </div>
      <div class="field">
        <label for="es-api-key">Elasticsearch API Key</label>
        <input id="es-api-key" type="text" placeholder="Base64-encoded API key" />
      </div>
      <div class="field">
        <label for="es-index">Index Name <span style="color:var(--text-muted)">(optional)</span></label>
        <input id="es-index" type="text" placeholder="search-workflow-executions" />
      </div>

      <hr class="divider" />

      <div class="section-label">CRON Service <span class="tag">Scheduling</span></div>
      <p class="hint mb-12">Enables cron job management, retry scheduling, and automated triggers.</p>
      <div class="field">
        <label for="cron-api-key">CRON API Key</label>
        <input id="cron-api-key" type="text" placeholder="Your CRON service API key" />
      </div>
      <div class="field">
        <label for="cron-base">CRON API Base <span style="color:var(--text-muted)">(optional)</span></label>
        <input id="cron-base" type="text" placeholder="https://cron.laminar.run" />
      </div>

      <button class="btn-primary" id="btn-save-advanced" onclick="saveAdvanced()">Save &amp; Continue</button>
      <button class="btn-ghost mt-12" onclick="skipAdvanced()">Skip — I'll configure later</button>
      <div class="alert alert-success" id="advanced-ok"></div>
      <div class="alert alert-error" id="advanced-error"></div>
    </div>
  </div>

  <!-- Step 3: Done -->
  <div class="step" id="step-done">
    <div class="card done">
      <div class="done-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h2>Connected</h2>
      <p>Restart Cursor to activate the Laminar MCP server.</p>
      <div id="svc-statuses" style="margin-bottom:14px"></div>
      <div class="code-block" id="config-preview"></div>
      <button class="btn-ghost mt-12" onclick="window.close()">Close</button>
    </div>
  </div>
</div>

<script>
function togglePw(){const p=document.getElementById('password');p.type=p.type==='password'?'text':'password'}
function showError(id,m){const e=document.getElementById(id);e.textContent=m;e.classList.add('show')}
function clearAlerts(ids){ids.forEach(id=>{const e=document.getElementById(id);if(e)e.classList.remove('show')})}

let configPreview='';

(async()=>{try{
  const r=await fetch('/api/status');const d=await r.json();
  if(d.hasSession){
    document.getElementById('session-banner').style.display='flex';
    document.getElementById('s-region').textContent=d.region;
    document.getElementById('s-expires').textContent=new Date(d.expiresAt).toLocaleString();
    if(d.apiBase&&d.apiBase.includes('ca.api')){
      document.querySelector('input[name="region"][value="ca.api.laminar.run"]').checked=true;
    }
  }
  if(d.serviceConfig){
    if(d.serviceConfig.elasticsearch){
      document.getElementById('es-endpoint').value=d.serviceConfig.elasticsearch.endpoint||'';
      document.getElementById('es-api-key').value=d.serviceConfig.elasticsearch.apiKey||'';
      document.getElementById('es-index').value=d.serviceConfig.elasticsearch.indexName||'';
    }
    if(d.serviceConfig.cron){
      document.getElementById('cron-api-key').value=d.serviceConfig.cron.apiKey||'';
      document.getElementById('cron-base').value=d.serviceConfig.cron.apiBase||'';
    }
  }
}catch{}})();

async function doLogout(){
  try{await fetch('/api/logout',{method:'POST'})}catch{}
  document.getElementById('session-banner').style.display='none';
}

document.getElementById('login-form').addEventListener('submit',async(e)=>{
  e.preventDefault();
  clearAlerts(['login-error']);
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('password').value;
  const region=document.querySelector('input[name="region"]:checked').value;
  if(!email||!password)return showError('login-error','Email and password are required.');
  const btn=document.getElementById('btn-login');
  btn.disabled=true;btn.innerHTML='<div class="spinner"></div>Signing in\\u2026';
  try{
    const r=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,region})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Sign in failed');
    configPreview=d.configPreview;
    document.getElementById('step-login').classList.remove('active');
    document.getElementById('step-advanced').classList.add('active');
  }catch(err){showError('login-error',err.message)}finally{btn.disabled=false;btn.textContent='Sign in'}
});

async function saveAdvanced(){
  clearAlerts(['advanced-error','advanced-ok']);
  const esEndpoint=document.getElementById('es-endpoint').value.trim();
  const esApiKey=document.getElementById('es-api-key').value.trim();
  const esIndex=document.getElementById('es-index').value.trim();
  const cronApiKey=document.getElementById('cron-api-key').value.trim();
  const cronBase=document.getElementById('cron-base').value.trim();

  const config={};
  if(esEndpoint&&esApiKey){
    config.elasticsearch={endpoint:esEndpoint,apiKey:esApiKey};
    if(esIndex)config.elasticsearch.indexName=esIndex;
  }
  if(cronApiKey){
    config.cron={apiKey:cronApiKey};
    if(cronBase)config.cron.apiBase=cronBase;
  }

  const btn=document.getElementById('btn-save-advanced');
  btn.disabled=true;btn.innerHTML='<div class="spinner"></div>Saving\\u2026';
  try{
    const r=await fetch('/api/advanced',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Save failed');
    goToDone(config);
  }catch(err){showError('advanced-error',err.message)}finally{btn.disabled=false;btn.textContent='Save & Continue'}
}

function skipAdvanced(){goToDone({})}

function goToDone(svcConfig){
  document.getElementById('step-advanced').classList.remove('active');
  document.getElementById('step-done').classList.add('active');
  document.getElementById('config-preview').textContent=configPreview;

  const statuses=document.getElementById('svc-statuses');
  const items=[
    {name:'Elasticsearch (Log Search)',on:!!svcConfig.elasticsearch},
    {name:'CRON (Scheduling)',on:!!svcConfig.cron},
  ];
  statuses.innerHTML=items.map(i=>
    '<div class="svc-status"><div class="'+(i.on?'dot-on':'dot-off')+'"></div>'+i.name+': '+(i.on?'Configured':'Not configured')+'</div>'
  ).join('');
}
</script>
</body>
</html>`;

// ─── Server ──────────────────────────────────────────────────

async function startSetup() {
  const srv = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url || "/", `http://localhost`);

    try {
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(HTML);
      }

      // ── Session status ──
      if (url.pathname === "/api/status" && req.method === "GET") {
        let serviceConfig = null;
        try {
          if (fs.existsSync(CONFIG_PATH)) {
            serviceConfig = JSON.parse(
              fs.readFileSync(CONFIG_PATH, "utf-8")
            );
          }
        } catch {}

        if (fs.existsSync(TOKEN_PATH)) {
          try {
            const tokens = JSON.parse(
              fs.readFileSync(TOKEN_PATH, "utf-8")
            );
            const apiBase: string =
              tokens.api_base || "https://api.laminar.run";
            const region = apiBase.includes("ca.api") ? "Canada" : "US";
            return send(res, 200, {
              hasSession: true,
              region,
              apiBase,
              expiresAt: tokens.expires_at,
              serviceConfig,
            });
          } catch {}
        }
        return send(res, 200, { hasSession: false, serviceConfig });
      }

      // ── Logout ──
      if (url.pathname === "/api/logout" && req.method === "POST") {
        if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
        for (const base of [
          path.join(os.homedir(), ".cursor"),
          path.join(process.cwd(), ".cursor"),
        ]) {
          const mcpPath = path.join(base, "mcp.json");
          if (fs.existsSync(mcpPath)) {
            try {
              const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
              if (cfg.mcpServers?.laminar) {
                delete cfg.mcpServers.laminar;
                fs.writeFileSync(
                  mcpPath,
                  JSON.stringify(cfg, null, 2) + "\n"
                );
              }
            } catch {}
          }
        }
        console.log("Session cleared.");
        return send(res, 200, { ok: true });
      }

      // ── Connect (auth) ──
      if (url.pathname === "/api/connect" && req.method === "POST") {
        const { email, password, region } = await jsonBody(req);
        const apiBase = `https://${region || "api.laminar.run"}`;

        const loginRes = await fetch(`${apiBase}/auth/signin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: email, password }),
        });

        if (!loginRes.ok) {
          return send(res, 401, { error: "Invalid email or password" });
        }

        const loginData = (await loginRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
        };

        const tokenDir = path.dirname(TOKEN_PATH);
        if (!fs.existsSync(tokenDir))
          fs.mkdirSync(tokenDir, { recursive: true });

        fs.writeFileSync(
          TOKEN_PATH,
          JSON.stringify(
            {
              access_token: loginData.access_token,
              refresh_token: loginData.refresh_token || null,
              expires_at: Date.now() + loginData.expires_in * 1000,
              api_base: apiBase,
            },
            null,
            2
          ) + "\n",
          { mode: 0o600 }
        );

        const dotCursor = path.join(os.homedir(), ".cursor");
        if (!fs.existsSync(dotCursor))
          fs.mkdirSync(dotCursor, { recursive: true });
        const configPath = path.join(dotCursor, "mcp.json");

        let existing: any = {};
        if (fs.existsSync(configPath)) {
          try {
            existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          } catch {}
        }
        if (!existing.mcpServers) existing.mcpServers = {};
        existing.mcpServers.laminar = {
          command: "node",
          args: [MCP_ENTRY],
        };

        fs.writeFileSync(
          configPath,
          JSON.stringify(existing, null, 2) + "\n"
        );

        console.log(`\n✓ Tokens stored at ${TOKEN_PATH}`);
        console.log(`✓ MCP config written to ${configPath}`);

        send(res, 200, {
          configPath,
          configPreview: JSON.stringify(existing, null, 2),
        });
        return;
      }

      // ── Advanced settings (ES + CRON) ──
      if (url.pathname === "/api/advanced" && req.method === "POST") {
        const body = await jsonBody(req);
        saveServiceConfig(body);
        console.log(`✓ Service config saved to ${CONFIG_PATH}`);

        send(res, 200, { ok: true });

        setTimeout(() => {
          console.log("\nSetup complete. Restart Cursor to activate.\n");
          process.exit(0);
        }, 2000);
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (e: any) {
      send(res, 500, { error: e.message });
    }
  });

  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    if (!addr || typeof addr === "string") {
      console.error("Failed to start server");
      process.exit(1);
    }
    const url = `http://127.0.0.1:${addr.port}`;
    console.log(`\n  Laminar MCP Setup`);
    console.log(`  ─────────────────`);
    console.log(`  Opening browser → ${url}\n`);
    openBrowser(url);
  });
}

startSetup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
