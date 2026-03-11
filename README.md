# Minicor MCP Server

> Formerly known as Laminar

Bring your Minicor workspace into **Cursor** and **Claude Code**. Desktop and browser RPA automation, workflow management, execution debugging, and more — all from your AI-powered editor.

## Install from npm

```bash
npm install -g @minicor/mcp-server
minicor-mcp-setup
```

Or add to your Cursor MCP config:

```json
{
  "mcpServers": {
    "minicor": {
      "command": "npx",
      "args": ["@minicor/mcp-server"],
      "env": {
        "LAMINAR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Quick Start (from source)

```bash
cd mcp
npm install
npm run setup
```

This opens a browser where you sign in with your Minicor account. Tokens are stored at `~/.laminar/tokens.json` and auto-refresh.

Restart Cursor to activate.

## Manual Setup

```bash
npm install && npm run build
```

Set `LAMINAR_API_KEY` in your Cursor MCP config:

```json
{
  "mcpServers": {
    "minicor": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "LAMINAR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Auth priority

1. `LAMINAR_API_KEY` env var
2. `LAMINAR_ACCESS_TOKEN` env var
3. Stored tokens from `npm run setup` (`~/.laminar/tokens.json`) — auto-refreshed

### Claude Code

```bash
claude mcp add minicor node /absolute/path/to/mcp/dist/index.js \
  -e LAMINAR_API_KEY=your-api-key-here
```

## Features

- **Workspaces** — list, inspect, manage workspace members
- **Workflows** — create, update, clone, delete, restore workflows
- **Flows (Steps)** — read/write individual steps, view version history, bulk update
- **Executions** — list, search, filter by date/status, inspect full payloads, view per-step results
- **Execute** — trigger workflows synchronously or async, poll for status
- **Configuration Stores** — manage key-value configs used by `{{config.xxx}}` references
- **Issues** — create and manage workspace issues
- **Stats** — flow execution statistics, recent runs
- **Desktop RPA** — connect to a VM, take screenshots, inspect UI, run scripts, build RPA workflows iteratively
- **Browser RPA** — session-based browser automation with natural-language actions
- **RPA Debugging** — before/after screenshots, batch testing, state reset, execution diagnosis
- **Log Search** _(advanced)_ — full-text Elasticsearch search across execution logs
- **Incident Investigation** — correlate failures across workflows with timeline analysis
- **CRON Management** _(advanced)_ — scheduled job management
- **Workflow File Sync** — pull/push workflows to local files for git version control

## Desktop RPA

The MCP includes tools for connecting to a VM running the Laminar Desktop Service (LDS) and iteratively building RPA workflows.

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
| `create_rpa_flow` | Save validated Python script as a Laminar RPA step (auto-wraps in correct format) |
| `vm_read_clipboard` | Read clipboard text after copy operations |
| `vm_screenshot_region` | Crop and zoom a specific screen region |
| `debug_rpa_step` | Run script with before/after screenshots |
| `vm_reset_state` | Smart Launch — reset app to known state |
| `batch_test_rpa` | Run workflow with multiple test inputs |
| `get_lds_setup_guide` | Full LDS installation walkthrough |

### UI Inspection Frameworks

| Framework | Best for |
|---|---|
| `uiautomation` (default) | .NET, WPF, WinForms, Win32 |
| `pywinauto` | Alternative Windows UI backend |
| `jab` | Java/Swing (Java Access Bridge) |

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

### Elasticsearch (log search)

```json
{
  "elasticsearch": {
    "endpoint": "https://your-es-cluster.cloud.io",
    "apiKey": "your-es-api-key"
  }
}
```

### CRON (scheduling)

```json
{
  "cron": {
    "apiKey": "your-cron-api-key"
  }
}
```

Config goes in `~/.laminar/config.json` or via environment variables.

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
  index.ts          — server orchestrator (auth, init, registration)
  helpers.ts        — shared response helpers (ok, text, safe, buildRpaProgram)
  state.ts          — session state (VM + browser connections)
  types.ts          — shared ToolDeps interface
  tools/            — tool modules (each exports register())
  prompts/          — prompt modules (each exports register())
  __tests__/        — vitest unit tests
```

## License

MIT
