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
- **Log Search** _(advanced)_ — full-text Elasticsearch search across execution logs, responses, and programs
- **Incident Investigation** — correlate failures across multiple workflows with timeline analysis
- **CRON Management** _(advanced)_ — create, update, toggle, trigger, and delete scheduled jobs
- **Retry Scheduling** _(advanced)_ — automatically retry failed executions on a schedule
- **Workflow File Sync** — pull/push workflows to local files for git version control

## Quick Start

```bash
cd mcp
npm install
npm run setup
```

This opens a browser window where you sign in with your Laminar account. After sign-in, you'll see **Advanced Settings** where you can optionally configure Elasticsearch and CRON services. Tokens are stored at `~/.laminar/tokens.json` and auto-refresh in the background.

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

## Advanced Setup

Advanced features (Elasticsearch log search, CRON scheduling) are **optional** and configured separately. The core tools always work without them.

### Option 1: Setup UI

Run `npm run setup` — after sign-in, the Advanced Settings page lets you configure ES and CRON.

### Option 2: Config file

Create `~/.laminar/config.json`:

```json
{
  "elasticsearch": {
    "endpoint": "https://your-es-cluster.cloud.io",
    "apiKey": "your-es-api-key",
    "indexName": "search-workflow-executions"
  },
  "cron": {
    "apiKey": "your-cron-api-key",
    "apiBase": "https://cron.laminar.run"
  }
}
```

### Option 3: Environment variables

```json
{
  "mcpServers": {
    "laminar": {
      "command": "node",
      "args": ["/absolute/path/to/laminar/mcp/dist/index.js"],
      "env": {
        "LAMINAR_API_KEY": "your-api-key-here",
        "ELASTICSEARCH_ENDPOINT": "https://your-es-cluster.cloud.io",
        "ELASTICSEARCH_API_KEY": "your-es-api-key",
        "CRON_API_KEY": "your-cron-api-key"
      }
    }
  }
}
```

Priority: env vars > config file > not configured (tools show setup instructions).

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

### Workflow-Centric Tools
| Tool | Description |
|---|---|
| `preview_flow_changes` | Unified diff of current vs proposed code before pushing |
| `get_workflow_overview` | Full workflow snapshot: all steps with code + recent executions |
| `get_execution_input` | Extract input from an execution for re-testing |
| `test_workflow_step` | Run workflow up to / from / only a specific step |
| `compare_flow_versions` | Unified diff between two versions of a step |
| `diagnose_execution` | Find failures with error context and preceding step output |

### Log Search _(requires Elasticsearch)_
| Tool | Description |
|---|---|
| `search_logs` | Full-text search across execution logs, responses, programs, transformations |
| `search_across_workflows` | Search multiple workflows at once — great for incident correlation |
| `investigate_incident` | Find failures across workflows in a time window, build a timeline. Works without ES too (API fallback) |

### CRON Jobs _(requires CRON service)_
| Tool | Description |
|---|---|
| `list_cron_jobs` | List all CRON jobs (optionally by workflow) |
| `get_cron_job` | Get job details |
| `create_cron_job` | Create a scheduled job |
| `update_cron_job` | Update schedule, name, body, URL |
| `toggle_cron_job` | Enable/disable a job |
| `trigger_cron_job` | Run a job immediately |
| `delete_cron_job` | Delete a job |
| `schedule_retry` | Auto-retry a failed execution on a CRON schedule |

### Workflow File Sync (gint)
| Tool | Description |
|---|---|
| `pull_workflow` | Download workflow to local files (individual step files + metadata) |
| `push_workflow` | Deploy local files to Laminar |
| `sync_status` | Compare local vs remote — shows modified/added/unchanged steps |

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

> "Search logs for 'order 12345' across workflows 600, 680, and 681"

> "Investigate what happened between 10:00 and 10:30 — workflows 600, 680, 681 all failed"

> "Pull workflow 42 to ./workflows/invoices so I can version control it"

> "Compare local changes to what's deployed, then push"

> "Schedule retries for execution 5678 every 30 minutes, max 3 attempts"

> "List all CRON jobs and disable the one running every minute"

> "Debug execution 5678 of workflow 42 — why did it fail?"
