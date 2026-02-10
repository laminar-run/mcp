# Laminar MCP Server

Bring your Laminar workspace into **Cursor** and **Claude Code**. Read executions, search and debug them, edit workflows, manage configurations, and more — all from your AI-powered editor.

## Features

- **Workspaces** — list, inspect, manage workspace members
- **Workflows** — create, update, clone, delete, restore workflows
- **Flows (Steps)** — read/write individual steps, view version history, bulk update
- **Executions** — list, search, filter by date/status, inspect full payloads, view per-step results
- **Execute** — trigger workflows synchronously or async, poll for status
- **Configuration Stores** — manage key-value configs used by `{{config.xxx}}` references
- **Issues** — create and manage workspace issues
- **Stats** — flow execution statistics, recent runs
- **Prompts** — built-in Laminar workflow specification guide and execution debugger

## Quick Start

```bash
cd mcp
npm install
npm run setup
```

This opens a browser window where you sign in with your Laminar account. That's it — tokens are stored at `~/.laminar/tokens.json` and the Cursor MCP config is written automatically. Tokens auto-refresh in the background.

Restart Cursor to activate.

## Manual Setup

If you prefer env vars over the browser flow:

```bash
npm install && npm run build
```

Set `LAMINAR_API_KEY` in your Cursor MCP config:

```json
{
  "mcpServers": {
    "laminar": {
      "command": "node",
      "args": ["/absolute/path/to/laminar/mcp/dist/index.js"],
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
claude mcp add laminar node /absolute/path/to/laminar/mcp/dist/index.js \
  -e LAMINAR_API_KEY=your-api-key-here
```

## Available Tools

### Workspace & Users
| Tool | Description |
|---|---|
| `list_workspaces` | List all workspaces |
| `get_workspace` | Get workspace details |
| `get_workspace_users` | List workspace members |
| `get_current_user` | Get authenticated user info |

### Workflows
| Tool | Description |
|---|---|
| `list_workflows` | List workflows in a workspace |
| `list_archived_workflows` | List archived/deleted workflows |
| `get_workflow` | Get workflow details |
| `create_workflow` | Create a new workflow |
| `update_workflow` | Update name/description |
| `delete_workflow` | Archive a workflow |
| `restore_workflow` | Restore archived workflow |
| `clone_workflow` | Clone a workflow |

### Flows (Steps)
| Tool | Description |
|---|---|
| `list_workflow_flows` | List all steps in a workflow |
| `get_flow` | Get step details |
| `read_flow` | Read step program code |
| `create_flow` | Add a new step |
| `update_flow` | Update step code/metadata |
| `delete_flow` | Remove a step |
| `create_or_update_flows` | Bulk create/update steps |
| `get_flow_versions` | View step version history |
| `read_flow_version` | Read historical step code |

### Executions
| Tool | Description |
|---|---|
| `list_executions` | Search/filter executions (date, status, text) |
| `get_execution` | Get execution details with all step results |
| `get_execution_status` | Quick status poll (for async) |
| `get_execution_result` | Get final step output only |
| `get_full_execution` | Get untruncated execution data |
| `get_global_workflow_object` | Get shared execution state |
| `get_flow_run_response` | Get a step's response data |
| `get_flow_run_transformation` | Get a step's input data |
| `get_flow_run_program` | Get the code that ran for a step |

### Execute Workflows
| Tool | Description |
|---|---|
| `execute_workflow` | Run workflow synchronously |
| `execute_workflow_async` | Trigger async execution |

### Configuration Stores
| Tool | Description |
|---|---|
| `list_config_stores` | List configs in workspace |
| `get_config_store` | Get config store details |
| `get_config_properties` | Get all key-value pairs |
| `get_config_property` | Get single property value |
| `update_config_property` | Set a property |
| `remove_config_property` | Delete a property |
| `create_config_store` | Create new config store |
| `delete_config_store` | Archive config store |
| `restore_config_store` | Restore archived config |

### Issues
| Tool | Description |
|---|---|
| `list_issues` | List workspace issues |
| `get_issue` | Get issue details |
| `create_issue` | Create an issue |
| `update_issue` | Update issue status/details |
| `delete_issue` | Delete an issue |

### Stats & Misc
| Tool | Description |
|---|---|
| `get_flow_stats` | Execution statistics |
| `get_recent_flow_runs` | Recent runs across workflows |
| `list_api_keys` | List workspace API keys |

## Prompts

| Prompt | Description |
|---|---|
| `laminar-workflow-guide` | Complete Laminar workflow specification — step types, data access, libraries, best practices |
| `debug-workflow-execution` | Feed a failed execution into the AI for root cause analysis and fix suggestions |

## Example Usage in Cursor

> "List all workflows in my workspace"

> "Show me the last 5 failed executions for workflow 42"

> "Read the code for step 3 of workflow 15 and fix the bug that's causing 400 errors"

> "Create a new workflow that fetches data from the GitHub API and transforms it"

> "What's the execution history for workflow 100 this week?"

> "Debug execution 5678 of workflow 42 — why did it fail?"
