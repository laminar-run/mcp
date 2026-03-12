#!/usr/bin/env node

/**
 * Minicor MCP — Interactive Setup
 *
 * Browser mode (default): opens a local page with sign-in/sign-up + workspace creation
 * CLI mode (--cli): terminal prompts for headless environments
 *
 * Tokens stored in ~/.minicor/tokens.json, MCP config written to ~/.cursor/mcp.json
 */

import http from "node:http";
import { exec } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { saveServiceConfig } from "./config.js";
import {
  getTokenPath,
  getWriteTokenPath,
  getWriteConfigPath,
  MINICOR_DIR,
  regionToApiBase,
  apiBaseToRegion,
  type Region,
} from "./paths.js";

const MCP_ENTRY = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "index.js",
);

// ─── Shared auth helpers ─────────────────────────────────────

interface AuthResult {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function signIn(
  apiBase: string,
  email: string,
  password: string,
): Promise<AuthResult> {
  const res = await fetch(`${apiBase}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Invalid email or password");
  }
  return (await res.json()) as AuthResult;
}

async function register(
  apiBase: string,
  data: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  },
): Promise<void> {
  const res = await fetch(`${apiBase}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Registration failed");
  }
}

async function listWorkspaces(
  apiBase: string,
  token: string,
): Promise<Array<{ id: number; name: string }>> {
  const res = await fetch(`${apiBase}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return (await res.json()) as Array<{ id: number; name: string }>;
}

async function createWorkspace(
  apiBase: string,
  token: string,
  name: string,
): Promise<{ id: number; name: string }> {
  const res = await fetch(`${apiBase}/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Failed to create workspace");
  }
  return (await res.json()) as { id: number; name: string };
}

function storeTokens(loginData: AuthResult, region: Region) {
  const writePath = getWriteTokenPath();
  const dir = path.dirname(writePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    writePath,
    JSON.stringify(
      {
        access_token: loginData.access_token,
        refresh_token: loginData.refresh_token || null,
        expires_at: Date.now() + loginData.expires_in * 1000,
        api_base: regionToApiBase(region),
        region,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return writePath;
}

function writeMcpConfig(): string {
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
  delete existing.mcpServers.laminar;
  existing.mcpServers.minicor = {
    command: "node",
    args: [MCP_ENTRY],
  };

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  return configPath;
}

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
<title>Minicor — Connect to Cursor</title>
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
  .field input[type="email"],.field input[type="password"],.field input[type="text"]{
    width:100%;height:36px;padding:0 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;
    color:var(--text);font-size:13px;font-family:var(--font);outline:none;transition:border-color .15s,box-shadow .15s;
  }
  .field input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgb(var(--brand)/.1)}
  .field .input-wrap{position:relative}
  .field input[type="password"]{padding-right:36px}
  .toggle-pw{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px;display:flex}
  .toggle-pw:hover{color:var(--text-secondary)}
  .seg{display:flex;background:var(--surface-2);border-radius:7px;padding:3px;gap:2px}
  .seg label{flex:1;text-align:center;padding:6px 0;font-size:12px;font-weight:500;border-radius:5px;cursor:pointer;color:var(--text-secondary);transition:all .15s;user-select:none}
  .seg input{display:none}
  .seg input:checked+span{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .seg label span{display:block;padding:6px 0;border-radius:5px;transition:all .15s}
  .tabs{display:flex;margin-bottom:20px;border-bottom:1px solid var(--border)}
  .tabs button{flex:1;padding:10px 0;font-size:13px;font-weight:500;font-family:var(--font);background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--text-muted);transition:all .15s}
  .tabs button.active{color:var(--primary);border-bottom-color:var(--primary)}
  .tabs button:hover{color:var(--text)}
  .tab-content{display:none}.tab-content.active{display:block}
  .row{display:flex;gap:10px}
  .row .field{flex:1}
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
  .mt-12{margin-top:12px}.mb-12{margin-bottom:12px}
  .divider{border:none;border-top:1px solid var(--border);margin:20px 0}
  .section-label{font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .section-label .tag{font-size:10px;font-weight:600;color:var(--text-muted);background:var(--surface-2);padding:2px 6px;border-radius:4px;text-transform:uppercase}
  .hint{font-size:11px;color:var(--text-muted);margin-top:4px}
  .svc-status{display:flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;padding:6px 10px;border-radius:6px;background:var(--surface-2)}
  .svc-status .dot-on{width:6px;height:6px;border-radius:50%;background:var(--success)}
  .svc-status .dot-off{width:6px;height:6px;border-radius:50%;background:var(--text-muted)}
  .ws-list{list-style:none;margin:12px 0}
  .ws-list li{padding:8px 12px;border:1px solid var(--border);border-radius:7px;margin-bottom:6px;font-size:13px;display:flex;justify-content:space-between;align-items:center}
  .ws-list li .id{color:var(--text-muted);font-size:11px}
</style>
</head>
<body>
<div class="wrapper">
  <div class="logo-row">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 118 98" width="36" height="30"><rect width="118" height="98" rx="10" ry="10" fill="#646ecb"/><g transform="translate(5.2,-4.6) scale(1.39)" fill="#fff"><path d="M27.4 59L10.6 38.5 27.4 17.7l4.6 3.7L18.2 38.4l13.8 16.9z"/><path d="M49.6 59l-4.6-3.7L58.9 38.3 45.1 21.4l4.6-3.7L66.5 38.3z"/></g></svg>
    <span class="wordmark">Minicor</span>
    <span class="badge">MCP</span>
  </div>

  <div id="session-banner" class="session" style="display:none">
    <div class="dot"></div>
    <div class="info">Connected to <strong id="s-region"></strong> &middot; expires <span id="s-expires"></span></div>
    <button onclick="doLogout()">Sign out</button>
  </div>

  <!-- Step 1: Auth (Sign in / Sign up) -->
  <div class="step active" id="step-auth">
    <div class="card">
      <h2>Connect to Cursor</h2>
      <p class="desc">Sign in or create a Minicor account to enable the MCP integration.</p>

      <div class="tabs">
        <button class="active" onclick="switchTab('signin')">Sign in</button>
        <button onclick="switchTab('signup')">Create account</button>
      </div>

      <!-- Sign In Tab -->
      <div class="tab-content active" id="tab-signin">
        <form id="login-form" autocomplete="on">
          <div class="field">
            <label for="login-email">Email</label>
            <input id="login-email" type="email" placeholder="you@company.com" autocomplete="email" autofocus />
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <div class="input-wrap">
              <input id="login-password" type="password" placeholder="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022" autocomplete="current-password" />
            </div>
          </div>
          <div class="field">
            <label>Region</label>
            <div class="seg">
              <label><input type="radio" name="login-region" value="us" checked /><span>US</span></label>
              <label><input type="radio" name="login-region" value="ca" /><span>Canada</span></label>
            </div>
          </div>
          <button type="submit" class="btn-primary" id="btn-login">Sign in</button>
        </form>
      </div>

      <!-- Sign Up Tab -->
      <div class="tab-content" id="tab-signup">
        <form id="signup-form" autocomplete="on">
          <div class="row">
            <div class="field">
              <label for="signup-first">First name</label>
              <input id="signup-first" type="text" placeholder="Jane" autocomplete="given-name" />
            </div>
            <div class="field">
              <label for="signup-last">Last name</label>
              <input id="signup-last" type="text" placeholder="Smith" autocomplete="family-name" />
            </div>
          </div>
          <div class="field">
            <label for="signup-email">Email</label>
            <input id="signup-email" type="email" placeholder="you@company.com" autocomplete="email" />
          </div>
          <div class="field">
            <label for="signup-password">Password</label>
            <input id="signup-password" type="password" placeholder="Min 8 chars, uppercase + symbol" autocomplete="new-password" />
            <div class="hint">At least 8 characters, one uppercase letter, one symbol</div>
          </div>
          <div class="field">
            <label for="signup-confirm">Confirm password</label>
            <input id="signup-confirm" type="password" placeholder="Re-enter password" autocomplete="new-password" />
          </div>
          <div class="field">
            <label>Region</label>
            <div class="seg">
              <label><input type="radio" name="signup-region" value="us" checked /><span>US</span></label>
              <label><input type="radio" name="signup-region" value="ca" /><span>Canada</span></label>
            </div>
          </div>
          <button type="submit" class="btn-primary" id="btn-signup">Create account</button>
        </form>
      </div>

      <div class="alert alert-error" id="auth-error"></div>
    </div>
    <div class="footer">
      <a href="https://docs.laminar.run" target="_blank">Documentation</a>
    </div>
  </div>

  <!-- Step 2: Workspace -->
  <div class="step" id="step-workspace">
    <div class="card">
      <h2>Your Workspaces</h2>
      <p class="desc" id="ws-desc">Loading...</p>
      <ul class="ws-list" id="ws-list"></ul>
      <div id="ws-create-section" style="display:none">
        <div class="field">
          <label for="ws-name">Workspace name</label>
          <input id="ws-name" type="text" placeholder="My Workspace" />
        </div>
        <button class="btn-primary" id="btn-create-ws" onclick="doCreateWorkspace()">Create workspace</button>
      </div>
      <button class="btn-ghost mt-12" id="btn-skip-ws" onclick="goToAdvanced()" style="display:none">Continue</button>
      <div class="alert alert-error" id="ws-error"></div>
    </div>
  </div>

  <!-- Step 3: Advanced Settings -->
  <div class="step" id="step-advanced">
    <div class="card">
      <h2>Advanced Settings</h2>
      <p class="desc">Optional services that unlock extra MCP tools. Skip any you don't need.</p>
      <div class="section-label">Elasticsearch <span class="tag">Log Search</span></div>
      <p class="hint mb-12">Enables search_logs, search_across_workflows, and keyword-based incident investigation.</p>
      <div class="field"><label for="es-endpoint">Elasticsearch Endpoint</label><input id="es-endpoint" type="text" placeholder="https://your-cluster.es.cloud.io" /></div>
      <div class="field"><label for="es-api-key">Elasticsearch API Key</label><input id="es-api-key" type="text" placeholder="Base64-encoded API key" /></div>
      <div class="field"><label for="es-index">Index Name <span style="color:var(--text-muted)">(optional)</span></label><input id="es-index" type="text" placeholder="search-workflow-executions" /></div>
      <hr class="divider" />
      <div class="section-label">CRON Service <span class="tag">Scheduling</span></div>
      <p class="hint mb-12">Enables cron job management, retry scheduling, and automated triggers.</p>
      <div class="field"><label for="cron-api-key">CRON API Key</label><input id="cron-api-key" type="text" placeholder="Your CRON service API key" /></div>
      <div class="field"><label for="cron-base">CRON API Base <span style="color:var(--text-muted)">(optional)</span></label><input id="cron-base" type="text" placeholder="https://cron.laminar.run" /></div>
      <button class="btn-primary" id="btn-save-advanced" onclick="saveAdvanced()">Save &amp; Continue</button>
      <button class="btn-ghost mt-12" onclick="skipAdvanced()">Skip</button>
      <div class="alert alert-error" id="advanced-error"></div>
    </div>
  </div>

  <!-- Step 4: Done -->
  <div class="step" id="step-done">
    <div class="card done">
      <div class="done-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h2>Connected</h2>
      <p>Restart Cursor to activate the Minicor MCP server.</p>
      <div id="svc-statuses" style="margin-bottom:14px"></div>
      <div class="code-block" id="config-preview"></div>
      <button class="btn-ghost mt-12" onclick="window.close()">Close</button>
    </div>
  </div>
</div>

<script>
let configPreview='';

function switchTab(tab){
  document.querySelectorAll('.tabs button').forEach((b,i)=>b.classList.toggle('active',i===(tab==='signin'?0:1)));
  document.getElementById('tab-signin').classList.toggle('active',tab==='signin');
  document.getElementById('tab-signup').classList.toggle('active',tab==='signup');
  clearAlerts(['auth-error']);
}

function showError(id,m){const e=document.getElementById(id);e.textContent=m;e.classList.add('show')}
function clearAlerts(ids){ids.forEach(id=>{const e=document.getElementById(id);if(e)e.classList.remove('show')})}

function goTo(step){
  document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
  document.getElementById('step-'+step).classList.add('active');
}

(async()=>{try{
  const r=await fetch('/api/status');const d=await r.json();
  if(d.hasSession){
    document.getElementById('session-banner').style.display='flex';
    document.getElementById('s-region').textContent=d.region;
    document.getElementById('s-expires').textContent=new Date(d.expiresAt).toLocaleString();
    if(d.region==='Canada'||d.region==='ca'){
      document.querySelector('input[name="login-region"][value="ca"]').checked=true;
      document.querySelector('input[name="signup-region"][value="ca"]').checked=true;
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

async function doAuth(endpoint,body,btn,loadingText){
  clearAlerts(['auth-error']);
  btn.disabled=true;btn.innerHTML='<div class="spinner"></div>'+loadingText;
  try{
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');
    configPreview=d.configPreview||'';
    await loadWorkspaces(d.accessToken);
  }catch(err){showError('auth-error',err.message)}finally{btn.disabled=false;btn.textContent=btn.dataset.label}
}

document.getElementById('login-form').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const region=document.querySelector('input[name="login-region"]:checked').value;
  if(!email||!password)return showError('auth-error','Email and password are required.');
  const btn=document.getElementById('btn-login');btn.dataset.label='Sign in';
  await doAuth('/api/connect',{email,password,region},btn,'Signing in\\u2026');
});

document.getElementById('signup-form').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const firstName=document.getElementById('signup-first').value.trim();
  const lastName=document.getElementById('signup-last').value.trim();
  const email=document.getElementById('signup-email').value.trim();
  const password=document.getElementById('signup-password').value;
  const confirm=document.getElementById('signup-confirm').value;
  const region=document.querySelector('input[name="signup-region"]:checked').value;
  if(!firstName||!lastName||!email||!password)return showError('auth-error','All fields are required.');
  if(password!==confirm)return showError('auth-error','Passwords do not match.');
  if(password.length<8)return showError('auth-error','Password must be at least 8 characters.');
  if(!/[A-Z]/.test(password))return showError('auth-error','Password must contain an uppercase letter.');
  if(!/[^a-zA-Z0-9]/.test(password))return showError('auth-error','Password must contain a symbol.');
  const btn=document.getElementById('btn-signup');btn.dataset.label='Create account';
  await doAuth('/api/register',{firstName,lastName,email,password,region},btn,'Creating account\\u2026');
});

async function loadWorkspaces(token){
  goTo('workspace');
  try{
    const r=await fetch('/api/workspaces',{headers:{'X-Token':token||''}});
    const d=await r.json();
    const list=d.workspaces||[];
    const ul=document.getElementById('ws-list');
    if(list.length===0){
      document.getElementById('ws-desc').textContent='You don\\u2019t have any workspaces yet. Create one to get started.';
      document.getElementById('ws-create-section').style.display='block';
    } else {
      document.getElementById('ws-desc').textContent='Your workspaces are ready. You can continue to advanced settings or create another.';
      ul.innerHTML=list.map(w=>'<li>'+w.name+'<span class="id">ID: '+w.id+'</span></li>').join('');
      document.getElementById('ws-create-section').style.display='block';
      document.getElementById('btn-skip-ws').style.display='flex';
    }
  }catch(err){
    document.getElementById('ws-desc').textContent='Could not load workspaces.';
    document.getElementById('btn-skip-ws').style.display='flex';
  }
}

async function doCreateWorkspace(){
  clearAlerts(['ws-error']);
  const name=document.getElementById('ws-name').value.trim();
  if(!name||name.length<3)return showError('ws-error','Workspace name must be at least 3 characters.');
  const btn=document.getElementById('btn-create-ws');
  btn.disabled=true;btn.innerHTML='<div class="spinner"></div>Creating\\u2026';
  try{
    const r=await fetch('/api/create-workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');
    document.getElementById('ws-name').value='';
    await loadWorkspaces('');
  }catch(err){showError('ws-error',err.message)}finally{btn.disabled=false;btn.textContent='Create workspace'}
}

function goToAdvanced(){goTo('advanced')}

async function saveAdvanced(){
  clearAlerts(['advanced-error']);
  const config={};
  const esEndpoint=document.getElementById('es-endpoint').value.trim();
  const esApiKey=document.getElementById('es-api-key').value.trim();
  const esIndex=document.getElementById('es-index').value.trim();
  const cronApiKey=document.getElementById('cron-api-key').value.trim();
  const cronBase=document.getElementById('cron-base').value.trim();
  if(esEndpoint&&esApiKey){config.elasticsearch={endpoint:esEndpoint,apiKey:esApiKey};if(esIndex)config.elasticsearch.indexName=esIndex}
  if(cronApiKey){config.cron={apiKey:cronApiKey};if(cronBase)config.cron.apiBase=cronBase}
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
  goTo('done');
  document.getElementById('config-preview').textContent=configPreview;
  const statuses=document.getElementById('svc-statuses');
  const items=[{name:'Elasticsearch (Log Search)',on:!!svcConfig.elasticsearch},{name:'CRON (Scheduling)',on:!!svcConfig.cron}];
  statuses.innerHTML=items.map(i=>'<div class="svc-status"><div class="'+(i.on?'dot-on':'dot-off')+'"></div>'+i.name+': '+(i.on?'Configured':'Not configured')+'</div>').join('');
}
</script>
</body>
</html>`;

// ─── Browser server ──────────────────────────────────────────

let storedAccessToken: string | null = null;

async function startBrowserSetup() {
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

      if (url.pathname === "/api/status" && req.method === "GET") {
        let serviceConfig = null;
        const cfgPath = getWriteConfigPath();
        try {
          if (fs.existsSync(cfgPath)) {
            serviceConfig = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          }
        } catch {}

        const tokenPath = getTokenPath();
        if (fs.existsSync(tokenPath)) {
          try {
            const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
            const region = tokens.region || apiBaseToRegion(tokens.api_base || "");
            return send(res, 200, {
              hasSession: true,
              region: region === "ca" ? "Canada" : "US",
              apiBase: tokens.api_base,
              expiresAt: tokens.expires_at,
              serviceConfig,
            });
          } catch {}
        }
        return send(res, 200, { hasSession: false, serviceConfig });
      }

      if (url.pathname === "/api/logout" && req.method === "POST") {
        const tokenPath = getTokenPath();
        if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
        for (const base of [
          path.join(os.homedir(), ".cursor"),
          path.join(process.cwd(), ".cursor"),
        ]) {
          const mcpPath = path.join(base, "mcp.json");
          if (fs.existsSync(mcpPath)) {
            try {
              const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
              delete cfg.mcpServers?.minicor;
              delete cfg.mcpServers?.laminar;
              fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + "\n");
            } catch {}
          }
        }
        storedAccessToken = null;
        console.log("Session cleared.");
        return send(res, 200, { ok: true });
      }

      if (url.pathname === "/api/connect" && req.method === "POST") {
        const { email, password, region } = await jsonBody(req);
        const r: Region = region === "ca" ? "ca" : "us";
        const apiBase = regionToApiBase(r);

        const loginData = await signIn(apiBase, email, password);
        const tokenPath = storeTokens(loginData, r);
        const configPath = writeMcpConfig();
        storedAccessToken = loginData.access_token;

        console.log(`\n✓ Tokens stored at ${tokenPath}`);
        console.log(`✓ MCP config written to ${configPath}`);

        return send(res, 200, {
          accessToken: loginData.access_token,
          configPath,
          configPreview: JSON.stringify(
            JSON.parse(fs.readFileSync(configPath, "utf-8")),
            null,
            2,
          ),
        });
      }

      if (url.pathname === "/api/register" && req.method === "POST") {
        const { firstName, lastName, email, password, region } =
          await jsonBody(req);
        const r: Region = region === "ca" ? "ca" : "us";
        const apiBase = regionToApiBase(r);

        await register(apiBase, { firstName, lastName, email, password });
        const loginData = await signIn(apiBase, email, password);
        const tokenPath = storeTokens(loginData, r);
        const configPath = writeMcpConfig();
        storedAccessToken = loginData.access_token;

        console.log(`\n✓ Account created and signed in`);
        console.log(`✓ Tokens stored at ${tokenPath}`);
        console.log(`✓ MCP config written to ${configPath}`);

        return send(res, 200, {
          accessToken: loginData.access_token,
          configPath,
          configPreview: JSON.stringify(
            JSON.parse(fs.readFileSync(configPath, "utf-8")),
            null,
            2,
          ),
        });
      }

      if (url.pathname === "/api/workspaces" && req.method === "GET") {
        const token =
          req.headers["x-token"] || storedAccessToken;
        if (!token)
          return send(res, 401, { error: "No token" });

        const tokenPath = getTokenPath();
        let apiBase = regionToApiBase("us");
        if (fs.existsSync(tokenPath)) {
          try {
            const t = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
            apiBase = regionToApiBase(t.region || apiBaseToRegion(t.api_base || ""));
          } catch {}
        }

        const workspaces = await listWorkspaces(apiBase, token as string);
        return send(res, 200, { workspaces });
      }

      if (
        url.pathname === "/api/create-workspace" &&
        req.method === "POST"
      ) {
        const { name } = await jsonBody(req);
        const token = storedAccessToken;
        if (!token) return send(res, 401, { error: "No token" });

        const tokenPath = getTokenPath();
        let apiBase = regionToApiBase("us");
        if (fs.existsSync(tokenPath)) {
          try {
            const t = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
            apiBase = regionToApiBase(t.region || apiBaseToRegion(t.api_base || ""));
          } catch {}
        }

        const ws = await createWorkspace(apiBase, token, name);
        return send(res, 200, { workspace: ws });
      }

      if (url.pathname === "/api/advanced" && req.method === "POST") {
        const body = await jsonBody(req);
        saveServiceConfig(body);
        const cfgPath = getWriteConfigPath();
        console.log(`✓ Service config saved to ${cfgPath}`);
        send(res, 200, { ok: true });
        setTimeout(() => {
          console.log(
            "\nSetup complete. Restart Cursor to activate.\n",
          );
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
    console.log(`\n  Minicor MCP Setup`);
    console.log(`  ─────────────────`);
    console.log(`  Opening browser → ${url}\n`);
    openBrowser(url);
  });
}

// ─── CLI mode ────────────────────────────────────────────────

function ask(
  rl: readline.Interface,
  question: string,
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function startCliSetup() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\n  Minicor MCP Setup (CLI)`);
  console.log(`  ───────────────────────\n`);

  const hasAccount = await ask(rl, "Do you have an account? (Y/n): ");
  const isSignup = hasAccount.trim().toLowerCase() === "n";

  const regionStr = await ask(rl, "Region (us/ca) [us]: ");
  const region: Region =
    regionStr.trim().toLowerCase() === "ca" ? "ca" : "us";
  const apiBase = regionToApiBase(region);

  let email: string;
  let password: string;

  if (isSignup) {
    console.log("\nCreate your account:");
    const firstName = await ask(rl, "  First name: ");
    const lastName = await ask(rl, "  Last name: ");
    email = await ask(rl, "  Email: ");
    password = await ask(rl, "  Password: ");
    const confirm = await ask(rl, "  Confirm password: ");

    if (password !== confirm) {
      console.error("\nError: Passwords do not match.");
      rl.close();
      process.exit(1);
    }

    try {
      await register(apiBase, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        password,
      });
      console.log("\n✓ Account created. Signing in...");
    } catch (e: any) {
      console.error(`\nError: ${e.message}`);
      rl.close();
      process.exit(1);
    }
  } else {
    console.log("\nSign in:");
    email = await ask(rl, "  Email: ");
    password = await ask(rl, "  Password: ");
  }

  try {
    const loginData = await signIn(apiBase, email.trim(), password);
    const tokenPath = storeTokens(loginData, region);
    const configPath = writeMcpConfig();

    console.log(`\n✓ Signed in.`);
    console.log(`✓ Tokens stored at ${tokenPath}`);
    console.log(`✓ MCP config written to ${configPath}`);

    const workspaces = await listWorkspaces(
      apiBase,
      loginData.access_token,
    );
    if (workspaces.length === 0) {
      const wsName = await ask(
        rl,
        "\nYou have no workspaces. Create one? Name: ",
      );
      if (wsName.trim().length >= 3) {
        const ws = await createWorkspace(
          apiBase,
          loginData.access_token,
          wsName.trim(),
        );
        console.log(
          `✓ Workspace "${ws.name}" created (ID: ${ws.id})`,
        );
      }
    } else {
      console.log(
        `\nWorkspaces: ${workspaces.map((w) => `${w.name} (${w.id})`).join(", ")}`,
      );
    }

    console.log("\nRestart Cursor to activate.\n");
  } catch (e: any) {
    console.error(`\nError: ${e.message}`);
  }

  rl.close();
  process.exit(0);
}

// ─── Entry point ─────────────────────────────────────────────

if (process.argv.includes("--cli")) {
  startCliSetup().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
} else {
  startBrowserSetup().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
