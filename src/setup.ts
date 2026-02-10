#!/usr/bin/env node

/**
 * Laminar MCP — Interactive Setup
 *
 * Opens a browser, user signs in with Laminar credentials,
 * tokens are stored and the MCP server is registered with Cursor.
 */

import http from "node:http";
import { exec } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 118 98" width="48" height="40"><rect width="118" height="98" rx="10" ry="10" fill="#646ecb"/><g transform="translate(5.2,-4.6) scale(1.39)" fill="#fff"><path d="M27.4 59L10.6 38.5 27.4 17.7l4.6 3.7L18.2 38.4l13.8 16.9z"/><path d="M49.6 59l-4.6-3.7L58.9 38.3 45.1 21.4l4.6-3.7L66.5 38.3z"/></g></svg>`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Laminar MCP Setup</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: linear-gradient(to bottom, #eef0ff, #ffffff);
    --surface: #ffffff;
    --border: #e2e5f1;
    --text: #111111;
    --muted: #6b7280;
    --primary: hsl(231 48% 62%);
    --primary-hover: hsl(246 50% 59%);
    --primary-focus: hsl(228 43% 59%);
    --danger: hsl(355 78% 60%);
    --success: hsl(158 58% 45%);
    --radius: 12px;
    --shadow: 0 10px 40px rgba(100, 110, 203, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: linear-gradient(to bottom, #111827, #1f2937);
      --surface: #1f2937;
      --border: #374151;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 32px;
    width: 100%;
    max-width: 420px;
    box-shadow: var(--shadow);
  }
  .header {
    text-align: center;
    margin-bottom: 24px;
  }
  .header svg { margin: 0 auto 16px; display: block; }
  .header h2 {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .header p {
    margin-top: 6px;
    font-size: 14px;
    color: var(--muted);
  }
  .field { margin-bottom: 16px; }
  .field label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
  }
  .field .input-wrap { position: relative; }
  .field input {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }
  .field input:focus { border-color: var(--primary); }
  .field input[type="password"] { padding-right: 40px; }
  .toggle-pw {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted);
    padding: 4px;
    line-height: 1;
  }
  .btn {
    width: 100%;
    height: 40px;
    margin-top: 8px;
    background: var(--primary);
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .btn:hover { background: var(--primary-hover); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .error-msg {
    margin-top: 12px;
    padding: 10px 12px;
    background: hsl(355 78% 60% / 0.08);
    border: 1px solid hsl(355 78% 60% / 0.2);
    color: var(--danger);
    border-radius: 8px;
    font-size: 13px;
    display: none;
  }
  .error-msg.show { display: block; }
  .spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.5s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step { display: none; }
  .step.active { display: block; }
  .success {
    text-align: center;
    padding: 12px 0;
  }
  .success .check {
    width: 56px; height: 56px;
    background: hsl(158 58% 45% / 0.1);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 16px;
    color: var(--success);
    font-size: 28px;
  }
  .success h2 { margin-bottom: 8px; }
  .success p { color: var(--muted); font-size: 14px; line-height: 1.5; }
  .code-block {
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    overflow-x: auto;
    margin-top: 16px;
    white-space: pre;
    color: var(--muted);
  }
  .scope-row {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    margin-bottom: 4px;
  }
  .scope-row label {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .scope-row label:hover { border-color: var(--primary); }
  .scope-row input[type="radio"] { accent-color: var(--primary); }
</style>
</head>
<body>
<div class="card">
  <!-- Sign In -->
  <div class="step active" id="step-login">
    <div class="header">
      ${LOGO_SVG}
      <h2>Welcome back</h2>
      <p>Sign in to connect Laminar to Cursor</p>
    </div>
    <form id="login-form">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@company.com" autocomplete="email" autofocus />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <div class="input-wrap">
          <input id="password" type="password" placeholder="••••••••" autocomplete="current-password" />
          <button type="button" class="toggle-pw" onclick="togglePw()">
            <svg id="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </div>
      <div class="scope-row">
        <label><input type="radio" name="scope" value="global" checked /> Global</label>
        <label><input type="radio" name="scope" value="project" /> Project</label>
      </div>
      <button type="submit" class="btn" id="btn-login">Sign in</button>
    </form>
    <div class="error-msg" id="login-error"></div>
  </div>

  <!-- Done -->
  <div class="step" id="step-done">
    <div class="header">
      ${LOGO_SVG}
    </div>
    <div class="success">
      <div class="check">&#10003;</div>
      <h2>Connected!</h2>
      <p>Laminar MCP is configured.<br/>Restart Cursor to activate.</p>
      <div class="code-block" id="config-preview"></div>
      <button class="btn" onclick="window.close()" style="margin-top:16px">Close</button>
    </div>
  </div>
</div>

<script>
function togglePw() {
  const pw = document.getElementById('password');
  pw.type = pw.type === 'password' ? 'text' : 'password';
}

function showError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.add('show');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = document.getElementById('login-error');
  el.classList.remove('show');

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const scope = document.querySelector('input[name="scope"]:checked').value;

  if (!email || !password) return showError('Email and password required.');

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Signing in...';

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, scope }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign in failed');

    document.getElementById('config-preview').textContent = data.configPreview;
    document.getElementById('step-login').classList.remove('active');
    document.getElementById('step-done').classList.add('active');
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
</script>
</body>
</html>`;

// ─── Server ──────────────────────────────────────────────────

async function startSetup() {
  const server = http.createServer(async (req, res) => {
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

      // Single endpoint: sign in → store tokens → write Cursor config
      if (url.pathname === "/api/connect" && req.method === "POST") {
        const { email, password, scope } = await jsonBody(req);

        // 1. Sign in
        const loginRes = await fetch("https://api.laminar.run/auth/signin", {
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

        // 2. Store tokens
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
            },
            null,
            2
          ) + "\n",
          { mode: 0o600 }
        );

        // 3. Write Cursor MCP config
        let configPath: string;
        if (scope === "project") {
          const dotCursor = path.join(process.cwd(), ".cursor");
          if (!fs.existsSync(dotCursor))
            fs.mkdirSync(dotCursor, { recursive: true });
          configPath = path.join(dotCursor, "mcp.json");
        } else {
          const dotCursor = path.join(os.homedir(), ".cursor");
          if (!fs.existsSync(dotCursor))
            fs.mkdirSync(dotCursor, { recursive: true });
          configPath = path.join(dotCursor, "mcp.json");
        }

        const mcpEntry = {
          command: "node",
          args: [MCP_ENTRY],
        };

        let existing: any = {};
        if (fs.existsSync(configPath)) {
          try {
            existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          } catch {
            // ignore
          }
        }
        if (!existing.mcpServers) existing.mcpServers = {};
        existing.mcpServers.laminar = mcpEntry;

        fs.writeFileSync(
          configPath,
          JSON.stringify(existing, null, 2) + "\n"
        );

        const preview = JSON.stringify(existing, null, 2);

        console.log(`\n✓ Tokens stored at ${TOKEN_PATH}`);
        console.log(`✓ MCP config written to ${configPath}`);
        console.log(`\nRestart Cursor to activate the Laminar MCP server.\n`);

        send(res, 200, { configPath, configPreview: preview });

        setTimeout(() => {
          console.log("Setup complete.");
          process.exit(0);
        }, 2000);
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (e: any) {
      send(res, 500, { error: e.message });
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
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
