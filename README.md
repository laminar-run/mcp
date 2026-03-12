# Minicor MCP Server

> Formerly known as Laminar

Desktop and browser RPA automation, workflow management, and AI-powered debugging for the Minicor platform -- all from **Cursor** or **Claude Code**.

## Add to Claude Code

```bash
npm install -g @minicor/mcp-server
minicor-mcp-setup
claude mcp add minicor -- minicor-mcp
```

## Add to Cursor

Run the setup, then add to your Cursor MCP config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "minicor": {
      "command": "npx",
      "args": ["-y", "@minicor/mcp-server"]
    }
  }
}
```

Or if you ran `minicor-mcp-setup`, it writes this automatically. Just restart Cursor.

## Setup

```bash
npm install -g @minicor/mcp-server
minicor-mcp-setup
```

This opens a browser where you can **sign in** or **create an account**, set up workspaces, and optionally configure advanced services (Elasticsearch, CRON). Tokens are stored at `~/.minicor/tokens.json` and auto-refresh.

For headless environments:

```bash
minicor-mcp-setup --cli
```

No API keys needed -- authentication is handled by your stored session token.

## Features

- **Workspaces** -- list, inspect, manage workspace members
- **Workflows** -- create, update, clone, delete, restore workflows
- **Flows (Steps)** -- read/write individual steps, view version history, bulk update
- **Executions** -- list, search, filter by date/status, inspect full payloads, view per-step results
- **Execute** -- trigger workflows synchronously or async, poll for status
- **Configuration Stores** -- manage key-value configs used by `{{config.xxx}}` references
- **Issues** -- create and manage workspace issues
- **Desktop RPA** -- connect to a VM, take screenshots, inspect UI, run scripts, build RPA workflows iteratively
- **Browser RPA** -- session-based browser automation with natural-language actions
- **RPA Debugging** -- before/after screenshots, batch testing, state reset, execution diagnosis
- **Log Search** _(advanced)_ -- full-text Elasticsearch search across execution logs
- **Incident Investigation** -- correlate failures across workflows with timeline analysis
- **CRON Management** _(advanced)_ -- scheduled job management
- **Workflow File Sync** -- pull/push workflows to local files for git version control

## Desktop RPA

Connect to a VM running the Laminar Desktop Service (LDS) and iteratively build RPA workflows.

### Setup LDS on a VM

Use the `get_lds_setup_guide` tool for step-by-step instructions, or:

1. Install LDS on the target Windows VM
2. Start it on port 1016
3. Expose via Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:1016`
4. In Cursor: `vm_connect` with the tunnel URL

### RPA Tools

| Tool | Description |
|---|---|
| `vm_connect` | Connect to LDS via Cloudflare Tunnel URL |
| `vm_screenshot` | Capture VM desktop screenshot |
| `vm_inspect_ui` | Inspect UI elements (accessibility tree, element at point, etc.) |
| `vm_execute_script` | Run Python script on the VM |
| `create_rpa_flow` | Save validated Python script as an RPA step (auto-wraps in correct format) |
| `vm_read_clipboard` | Read clipboard text after copy operations |
| `vm_screenshot_region` | Crop and zoom a specific screen region |
| `debug_rpa_step` | Run script with before/after screenshots |
| `vm_reset_state` | Smart Launch -- reset app to known state |
| `batch_test_rpa` | Run workflow with multiple test inputs |
| `get_lds_setup_guide` | Full LDS installation walkthrough |

## Browser RPA

Session-based browser automation for web applications.

| Tool | Description |
|---|---|
| `browser_connect` | Connect to browser RPA service |
| `browser_create_session` | Start a new browser session |
| `browser_act` | Natural-language browser actions |
| `browser_extract` | Extract data from the current page |
| `browser_screenshot` | Screenshot the browser |
| `browser_close_session` | Clean up session |
| `create_browser_rpa_flow` | Save browser action as a workflow step |

## Workflow Tools

| Tool | Description |
|---|---|
| `preview_flow_changes` | Diff current vs proposed code before pushing |
| `get_workflow_overview` | Full workflow snapshot with code + executions |
| `test_workflow_step` | Run up to / from / only a specific step |
| `diagnose_execution` | Find failures with RPA-specific error analysis |
| `compare_flow_versions` | Diff between two step versions |

## Advanced Setup

Elasticsearch (log search) and CRON (scheduling) are configured during `minicor-mcp-setup` under Advanced Settings, or via `~/.minicor/config.json`:

```json
{
  "elasticsearch": {
    "endpoint": "https://your-es-cluster.cloud.io",
    "apiKey": "your-es-api-key"
  },
  "cron": {
    "apiKey": "your-cron-api-key"
  }
}
```

## Auth

Authentication uses stored session tokens only. No API keys.

- **Sign in / sign up**: `minicor-mcp-setup` (browser) or `minicor-mcp-setup --cli`
- **Token storage**: `~/.minicor/tokens.json` (falls back to `~/.laminar/tokens.json` for existing users)
- **Auto-refresh**: tokens refresh automatically before expiry
- **Region**: US (default) or Canada, selected during setup

## Development

```bash
npm install
npm run build
npm test
npm run dev        # watch mode
npm run test:watch # test watch mode
```

### Project Structure

```
src/
  index.ts          -- server orchestrator (auth, init, registration)
  helpers.ts        -- shared response helpers (ok, text, safe, buildRpaProgram)
  state.ts          -- session state (VM + browser connections)
  paths.ts          -- token/config path resolution with ~/.minicor/ + ~/.laminar/ fallback
  types.ts          -- shared ToolDeps interface
  setup.ts          -- interactive setup (browser + CLI modes)
  tools/            -- tool modules (each exports register())
  prompts/          -- prompt modules (each exports register())
  __tests__/        -- vitest unit tests
```

## License

MIT
