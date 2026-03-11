#!/usr/bin/env node

/**
 * Laminar MCP Server
 *
 * Brings your Laminar workspace into Cursor / Claude Code.
 * Core tools always available; Elasticsearch + CRON unlock with advanced setup.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadServiceConfig } from "./config.js";
import { computeDiff } from "./diff.js";
import { generateInspectScript } from "./inspect-scripts.js";
import { LaminarClient, type LaminarAuth } from "./laminar-client.js";
import * as lds from "./lds-client.js";
import { CronService, ElasticsearchService } from "./services.js";
import {
  initProject,
  pullAll,
  pullWorkflow,
  pushChanged,
  pushWorkflow,
  syncStatus
} from "./sync.js";

const TOKEN_PATH = path.join(os.homedir(), ".laminar", "tokens.json");
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  api_base?: string;
}

function getApiBase(): string {
  const stored = readStoredTokens();
  return (
    stored?.api_base ||
    process.env.LAMINAR_API_BASE ||
    "https://api.laminar.run"
  );
}

// ─── Token management ────────────────────────────────────────

function readStoredTokens(): StoredTokens | null {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens: StoredTokens) {
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2) + "\n", {
    mode: 0o600,
  });
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<StoredTokens | null> {
  const base = getApiBase();
  try {
    const res = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
      api_base: base,
    };
  } catch {
    return null;
  }
}

async function getValidToken(): Promise<string> {
  const tokens = readStoredTokens();
  if (!tokens) throw new Error("No stored tokens");

  if (Date.now() < tokens.expires_at - REFRESH_BUFFER_MS) {
    return tokens.access_token;
  }

  if (tokens.refresh_token) {
    console.error("Refreshing Laminar access token...");
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    if (refreshed) {
      writeStoredTokens(refreshed);
      console.error("Token refreshed.");
      return refreshed.access_token;
    }
  }

  console.error(
    "Warning: Token expired and refresh failed. Run `npm run setup` to re-authenticate.",
  );
  return tokens.access_token;
}

// ─── Resolve auth ────────────────────────────────────────────

async function resolveAuth(): Promise<{ auth: LaminarAuth; baseUrl: string }> {
  const apiKey = process.env.LAMINAR_API_KEY;
  const accessToken = process.env.LAMINAR_ACCESS_TOKEN;
  const baseUrl = getApiBase();

  if (apiKey) return { auth: { type: "apiKey", token: apiKey }, baseUrl };
  if (accessToken)
    return { auth: { type: "bearer", token: accessToken }, baseUrl };

  const stored = readStoredTokens();
  if (stored) {
    const token = await getValidToken();
    return { auth: { type: "bearer", token }, baseUrl };
  }

  console.error(
    "No auth found. Run `npm run setup` to sign in, or set LAMINAR_API_KEY.",
  );
  process.exit(1);
}

let client: LaminarClient;
let esService: ElasticsearchService | null = null;
let cronService: CronService | null = null;

function scheduleTokenRefresh() {
  const tokens = readStoredTokens();
  if (!tokens?.refresh_token) return;

  const msUntilRefresh = Math.max(
    tokens.expires_at - REFRESH_BUFFER_MS - Date.now(),
    60_000,
  );

  setTimeout(async () => {
    try {
      const token = await getValidToken();
      client = new LaminarClient({ type: "bearer", token }, getApiBase());
      console.error("Token auto-refreshed, client updated.");
    } catch (e: any) {
      console.error("Auto-refresh failed:", e.message);
    }
    scheduleTokenRefresh();
  }, msUntilRefresh);
}

// ─── Helpers ─────────────────────────────────────────────────

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: json(data) }] };
}

function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

async function safe<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e: any) {
    return text(`Error: ${e.message}`);
  }
}

const NOT_CONFIGURED_ES = `Elasticsearch is not configured. Log search requires ES credentials.

**Option 1 — Environment variables:**
  ELASTICSEARCH_ENDPOINT=https://your-es-cluster
  ELASTICSEARCH_API_KEY=your-api-key
  ELASTICSEARCH_INDEX_NAME=search-workflow-executions (optional)

**Option 2 — Config file** (~/.laminar/config.json):
  {
    "elasticsearch": {
      "endpoint": "https://your-es-cluster",
      "apiKey": "your-api-key"
    }
  }

**Option 3 — Run setup:** laminar-mcp-setup → Advanced Settings`;

const NOT_CONFIGURED_CRON = `CRON service is not configured. Scheduling requires CRON credentials.

**Option 1 — Environment variables:**
  CRON_API_KEY=your-cron-api-key
  CRON_API_BASE=https://cron.laminar.run (optional)

**Option 2 — Config file** (~/.laminar/config.json):
  {
    "cron": {
      "apiKey": "your-cron-api-key"
    }
  }

**Option 3 — Run setup:** laminar-mcp-setup → Advanced Settings`;

function requireES() {
  if (!esService) return text(NOT_CONFIGURED_ES);
  return null;
}

function requireCron() {
  if (!cronService) return text(NOT_CONFIGURED_CRON);
  return null;
}

// ─── VM / LDS session state ─────────────────────────────────

interface LdsConnection {
  url: string;
  apiKey?: string;
  serviceId?: string;
}

let ldsConnection: LdsConnection | null = null;

const NOT_CONNECTED_VM = `No VM connected. Ask the user for their Cloudflare Tunnel URL for the Laminar Desktop Service, then call vm_connect.`;

function requireVM() {
  if (!ldsConnection) return text(NOT_CONNECTED_VM);
  return null;
}

function ldsAuth(): lds.LdsAuth | undefined {
  if (ldsConnection?.apiKey && ldsConnection?.serviceId) {
    return { apiKey: ldsConnection.apiKey, serviceId: ldsConnection.serviceId };
  }
  return undefined;
}

// ─── Server ──────────────────────────────────────────────────

const server = new McpServer({
  name: "laminar",
  version: "1.1.0",
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CORE TOOLS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Auth / User ──────────────────────────────────────────────

server.tool(
  "get_current_user",
  "Get the current authenticated user info",
  {},
  async () => safe(() => client.getMe()),
);

// ── Workspaces ───────────────────────────────────────────────

server.tool(
  "list_workspaces",
  "List all workspaces the user has access to",
  {},
  async () => safe(() => client.listWorkspaces()),
);

server.tool(
  "get_workspace",
  "Get workspace details by ID",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.getWorkspace(workspaceId)),
);

server.tool(
  "get_workspace_users",
  "List all users in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.getWorkspaceUsers(workspaceId)),
);

// ── Workflows ────────────────────────────────────────────────

server.tool(
  "list_workflows",
  "List all workflows in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.listWorkflows(workspaceId)),
);

server.tool(
  "list_archived_workflows",
  "List archived workflows in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) =>
    safe(() => client.listArchivedWorkflows(workspaceId)),
);

server.tool(
  "get_workflow",
  "Get workflow details including name, description, created date",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.getWorkflow(workflowId)),
);

server.tool(
  "create_workflow",
  "Create a new workflow in a workspace",
  {
    workspaceId: z.number().describe("Workspace ID"),
    name: z.string().describe("Workflow name"),
    description: z.string().describe("Workflow description"),
  },
  async ({ workspaceId, name, description }) =>
    safe(() => client.createWorkflow({ workspaceId, name, description })),
);

server.tool(
  "update_workflow",
  "Update workflow name and/or description",
  {
    workflowId: z.number().describe("Workflow ID"),
    name: z.string().optional().describe("New name"),
    description: z.string().optional().describe("New description"),
  },
  async ({ workflowId, name, description }) =>
    safe(() => client.updateWorkflow({ workflowId, name, description })),
);

server.tool(
  "delete_workflow",
  "Delete (archive) a workflow",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.deleteWorkflow(workflowId)),
);

server.tool(
  "restore_workflow",
  "Restore a previously deleted/archived workflow",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.restoreWorkflow(workflowId)),
);

server.tool(
  "clone_workflow",
  "Clone an existing workflow",
  {
    workflowId: z.number().describe("Source workflow ID"),
    name: z.string().describe("Name for the cloned workflow"),
    workspaceId: z
      .number()
      .optional()
      .describe("Target workspace ID (defaults to same workspace)"),
  },
  async ({ workflowId, name, workspaceId }) =>
    safe(() => client.cloneWorkflow(workflowId, { name, workspaceId })),
);

// ── Flows (Steps) ────────────────────────────────────────────

server.tool(
  "list_workflow_flows",
  "List all flows/steps in a workflow, including their code",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.getWorkflowFlows(workflowId)),
);

server.tool(
  "get_flow",
  "Get a single flow/step details",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.getFlow(flowId)),
);

server.tool(
  "read_flow",
  "Read the program code of a flow/step",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.readFlow(flowId)),
);

server.tool(
  "create_flow",
  "Create a new flow/step in a workflow. flowType: HTTP_REQUEST, GENERAL_FUNCTION, SHELL_SCRIPT, or RPA. language: js or py. For RPA flows: prefer using create_rpa_flow instead — it auto-wraps your Python script in the correct format. If you use this tool directly for RPA, the program MUST be a JS arrow function returning lam.httpRequest or lam.rpa (NOT raw Python).",
  {
    workflowId: z.number().describe("Workflow ID"),
    name: z.string().describe("Step name"),
    description: z.string().describe("Step description"),
    program: z
      .string()
      .describe(
        "Program code. JS: (data) => { ... }  Python: def transform(data): ...",
      ),
    executionOrder: z.number().describe("Step position (starts at 1)"),
    language: z.enum(["js", "py"]).describe("Programming language"),
    flowType: z
      .enum(["HTTP_REQUEST", "GENERAL_FUNCTION", "SHELL_SCRIPT", "RPA"])
      .describe("Flow type"),
  },
  async (args) => {
    if (args.flowType === "RPA") {
      if (args.language !== "js") {
        return text(
          `Error: RPA flows must use language "js", not "${args.language}". The Python script must be embedded inside a JS arrow function. Use the create_rpa_flow tool instead — it handles this automatically.`,
        );
      }
      const prog = args.program.trim();
      if (!prog.includes("lam.httpRequest") && !prog.includes("lam.rpa")) {
        return text(
          `Error: RPA flow program must be a JS arrow function that returns "lam.httpRequest" or "lam.rpa" with the Python script embedded. You appear to have passed raw Python. Use the create_rpa_flow tool instead — it wraps your Python script in the correct format automatically.`,
        );
      }
    }
    return safe(() => client.createFlow(args));
  },
);

server.tool(
  "create_or_update_flows",
  "Bulk create or update multiple flows/steps in a workflow at once",
  {
    workflowId: z.number().describe("Workflow ID"),
    flows: z
      .array(
        z.object({
          workflowId: z.number(),
          name: z.string(),
          description: z.string(),
          program: z.string(),
          executionOrder: z.number(),
          language: z.string(),
          flowType: z.string(),
        }),
      )
      .describe("Array of flow objects"),
  },
  async ({ workflowId, flows }) =>
    safe(() => client.createOrUpdateFlows(workflowId, flows)),
);

server.tool(
  "update_flow",
  "Update an existing flow/step (name, description, program code, language)",
  {
    flowId: z.number().describe("Flow ID"),
    name: z.string().optional().describe("New name"),
    description: z.string().optional().describe("New description"),
    program: z.string().optional().describe("New program code"),
    language: z.string().optional().describe("New language (js or py)"),
  },
  async (args) => safe(() => client.updateFlow(args)),
);

server.tool(
  "delete_flow",
  "Delete a flow/step from a workflow",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.deleteFlow(flowId)),
);

server.tool(
  "get_flow_versions",
  "Get version history of a flow/step",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.getFlowVersions(flowId)),
);

server.tool(
  "read_flow_version",
  "Read a specific historical version of a flow's code",
  {
    flowId: z.number().describe("Flow ID"),
    versionId: z.number().describe("Version ID"),
  },
  async ({ flowId, versionId }) =>
    safe(() => client.readFlowVersion(flowId, versionId)),
);

// ── Executions ───────────────────────────────────────────────

server.tool(
  "list_executions",
  "List and search workflow executions with optional filters (date range, status, search text). Paginated.",
  {
    workflowId: z.number().describe("Workflow ID"),
    page: z.number().optional().describe("Page number (0-based, default 0)"),
    size: z.number().optional().describe("Page size (default 20)"),
    startDate: z.string().optional().describe("Filter: start date (ISO 8601)"),
    endDate: z.string().optional().describe("Filter: end date (ISO 8601)"),
    search: z.string().optional().describe("Search text"),
    status: z
      .string()
      .optional()
      .describe("Filter: SUCCESS, FAILED, RUNNING, PENDING, SKIPPED, UNKNOWN"),
    configurationId: z
      .union([z.number(), z.string()])
      .optional()
      .describe("Filter by configuration store ID (number or string)"),
    sortDirection: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort direction (default desc)"),
  },
  async ({ workflowId, ...params }) =>
    safe(() => client.listExecutions(workflowId, params)),
);

server.tool(
  "get_execution",
  "Get full details of a specific workflow execution including all flow run results",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getExecution(workflowId, executionId)),
);

server.tool(
  "get_execution_status",
  "Quick lightweight check of execution status (for polling async executions)",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getExecutionStatus(workflowId, executionId)),
);

server.tool(
  "get_execution_result",
  "Get only the final result of an execution (last step output)",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getExecutionResult(workflowId, executionId)),
);

server.tool(
  "get_full_execution",
  "Get the complete untruncated execution data (large payloads)",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getFullExecution(workflowId, executionId)),
);

server.tool(
  "get_global_workflow_object",
  "Get the global workflow object (shared state) for an execution",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getGlobalWorkflowObject(workflowId, executionId)),
);

server.tool(
  "get_flow_run_response",
  "Get the full response data for a specific flow run within an execution",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
    flowRunId: z.number().describe("Flow Run ID"),
  },
  async ({ workflowId, executionId, flowRunId }) =>
    safe(() => client.getFlowRunResponse(workflowId, executionId, flowRunId)),
);

server.tool(
  "get_flow_run_transformation",
  "Get the transformation/input data for a specific flow run",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
    flowRunId: z.number().describe("Flow Run ID"),
  },
  async ({ workflowId, executionId, flowRunId }) =>
    safe(() =>
      client.getFlowRunTransformation(workflowId, executionId, flowRunId),
    ),
);

server.tool(
  "get_flow_run_program",
  "Get the program code that was executed for a specific flow run",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
    flowRunId: z.number().describe("Flow Run ID"),
  },
  async ({ workflowId, executionId, flowRunId }) =>
    safe(() => client.getFlowRunProgram(workflowId, executionId, flowRunId)),
);

// ── Execute ──────────────────────────────────────────────────

server.tool(
  "execute_workflow",
  "Execute a workflow synchronously and return the result. Pass input data as the body.",
  {
    workflowId: z.number().describe("Workflow ID"),
    body: z.any().optional().describe("Input data for the workflow (JSON)"),
    configurationId: z
      .union([z.number(), z.string()])
      .optional()
      .describe("Configuration store ID to use (number or string)"),
    startFromStep: z
      .number()
      .optional()
      .describe("Start execution from this step number"),
    endAtStep: z
      .number()
      .optional()
      .describe("End execution at this step number"),
  },
  async ({ workflowId, body, configurationId, startFromStep, endAtStep }) =>
    safe(() =>
      client.executeWorkflow(workflowId, body, {
        configuration_id: configurationId,
        start_from_step: startFromStep,
        end_at_step: endAtStep,
      }),
    ),
);

server.tool(
  "execute_workflow_async",
  "Trigger an async workflow execution. Returns an execution ID for polling.",
  {
    workflowId: z.number().describe("Workflow ID"),
    body: z.any().optional().describe("Input data for the workflow (JSON)"),
    configurationId: z
      .union([z.number(), z.string()])
      .optional()
      .describe("Configuration store ID to use (number or string)"),
    startFromStep: z
      .number()
      .optional()
      .describe("Start execution from this step number"),
    endAtStep: z
      .number()
      .optional()
      .describe("End execution at this step number"),
  },
  async ({ workflowId, body, configurationId, startFromStep, endAtStep }) =>
    safe(() =>
      client.executeWorkflowAsync(workflowId, body, {
        configuration_id: configurationId,
        start_from_step: startFromStep,
        end_at_step: endAtStep,
      }),
    ),
);

// ── Conversations ────────────────────────────────────────────

server.tool(
  "list_conversations",
  "List all AI conversations for a workflow",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.listConversations(workflowId)),
);

server.tool(
  "get_conversation_messages",
  "Get all messages from a specific workflow conversation",
  {
    workflowId: z.number().describe("Workflow ID"),
    conversationId: z.number().describe("Conversation ID"),
  },
  async ({ workflowId, conversationId }) =>
    safe(() => client.getConversationMessages(workflowId, conversationId)),
);

// ── Configuration Stores ─────────────────────────────────────

server.tool(
  "list_config_stores",
  "List all configuration stores in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.listConfigStores(workspaceId)),
);

server.tool(
  "get_config_store",
  "Get a configuration store by its external ID",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.getConfigStore(externalId, workspaceId)),
);

server.tool(
  "get_config_properties",
  "Get all properties (key-value pairs) from a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.getConfigProperties(externalId, workspaceId)),
);

server.tool(
  "get_config_property",
  "Get a specific property value from a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    key: z.string().describe("Property key"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, key, workspaceId }) =>
    safe(() => client.getConfigProperty(externalId, key, workspaceId)),
);

server.tool(
  "update_config_property",
  "Create or update a property in a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
    key: z.string().describe("Property key"),
    value: z.string().describe("Property value"),
  },
  async ({ externalId, workspaceId, key, value }) =>
    safe(() =>
      client.updateConfigProperty(externalId, workspaceId, { key, value }),
    ),
);

server.tool(
  "remove_config_property",
  "Remove a property from a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    key: z.string().describe("Property key"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, key, workspaceId }) =>
    safe(() => client.removeConfigProperty(externalId, key, workspaceId)),
);

server.tool(
  "create_config_store",
  "Create a new configuration store",
  {
    workspaceId: z.number().describe("Workspace ID"),
    name: z.string().describe("Config store name"),
    externalId: z
      .string()
      .describe("Unique external ID (used in {{config.xxx}} references)"),
    properties: z
      .array(
        z.object({
          key: z.string().describe("Property key"),
          value: z.string().describe("Property value"),
        }),
      )
      .describe("Initial properties"),
  },
  async (args) => safe(() => client.createConfigStore(args)),
);

server.tool(
  "delete_config_store",
  "Delete (archive) a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.deleteConfigStore(externalId, workspaceId)),
);

server.tool(
  "restore_config_store",
  "Restore a previously archived configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.restoreConfigStore(externalId, workspaceId)),
);

// ── Issues ───────────────────────────────────────────────────

server.tool(
  "list_issues",
  "List all issues in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.listIssues(workspaceId)),
);

server.tool(
  "get_issue",
  "Get issue details",
  {
    workspaceId: z.number().describe("Workspace ID"),
    issueId: z.number().describe("Issue ID"),
  },
  async ({ workspaceId, issueId }) =>
    safe(() => client.getIssue(workspaceId, issueId)),
);

server.tool(
  "create_issue",
  "Create a new issue in a workspace",
  {
    workspaceId: z.number().describe("Workspace ID"),
    title: z.string().describe("Issue title"),
    description: z.string().describe("Issue description"),
    assignedUserId: z
      .number()
      .optional()
      .describe("User ID to assign the issue to"),
  },
  async ({ workspaceId, title, description, assignedUserId }) =>
    safe(() =>
      client.createIssue(workspaceId, {
        title,
        description,
        assignedUserId,
      }),
    ),
);

server.tool(
  "update_issue",
  "Update an existing issue (title, description, status, assignee)",
  {
    workspaceId: z.number().describe("Workspace ID"),
    issueId: z.number().describe("Issue ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z
      .enum(["OPEN", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE", "CLOSED"])
      .optional()
      .describe("New status"),
    assignedUserId: z.number().optional().describe("New assignee user ID"),
  },
  async ({ workspaceId, issueId, ...data }) =>
    safe(() => client.updateIssue(workspaceId, issueId, data)),
);

server.tool(
  "delete_issue",
  "Delete an issue",
  {
    workspaceId: z.number().describe("Workspace ID"),
    issueId: z.number().describe("Issue ID"),
  },
  async ({ workspaceId, issueId }) =>
    safe(() => client.deleteIssue(workspaceId, issueId)),
);

// ── Stats ────────────────────────────────────────────────────

server.tool(
  "get_flow_stats",
  "Get flow execution statistics for a workspace (total runs, success rate, avg duration, etc.)",
  {
    workspaceId: z.number().describe("Workspace ID"),
    days: z
      .number()
      .optional()
      .describe("Number of days to look back (default 7)"),
  },
  async ({ workspaceId, days }) =>
    safe(() => client.getFlowStats(workspaceId, days)),
);

server.tool(
  "get_recent_flow_runs",
  "Get recent flow runs across all workflows in a workspace",
  {
    workspaceId: z.number().describe("Workspace ID"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ workspaceId, limit }) =>
    safe(() => client.getRecentFlowRuns(workspaceId, limit)),
);

server.tool(
  "list_api_keys",
  "List API keys in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.listApiKeys(workspaceId)),
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WORKFLOW-CENTRIC TOOLS (improved UX)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "preview_flow_changes",
  "Show a diff of the current flow code vs your proposed changes BEFORE updating. Use this to review changes before pushing them to Laminar.",
  {
    flowId: z.number().describe("Flow ID to compare against"),
    proposedProgram: z
      .string()
      .describe("The new program code you want to set"),
    proposedName: z.string().optional().describe("New name (if changing)"),
    proposedDescription: z
      .string()
      .optional()
      .describe("New description (if changing)"),
  },
  async ({ flowId, proposedProgram, proposedName, proposedDescription }) => {
    try {
      const flow = await client.getFlow(flowId);
      const currentCode = await client.readFlow(flowId);
      const current =
        typeof currentCode === "string"
          ? currentCode
          : JSON.stringify(currentCode, null, 2);

      const lines = [
        `## Flow: ${flow.name} (ID: ${flowId})`,
        `**Type:** ${flow.flowType} | **Language:** ${flow.language} | **Order:** ${flow.executionOrder}`,
        "",
      ];

      if (proposedName && proposedName !== flow.name) {
        lines.push(`### Name: ${flow.name} → ${proposedName}`);
        lines.push("");
      }

      if (proposedDescription && proposedDescription !== flow.description) {
        lines.push(
          `### Description: ${flow.description} → ${proposedDescription}`,
        );
        lines.push("");
      }

      lines.push("### Code Diff");
      lines.push("```diff");
      lines.push(computeDiff(current, proposedProgram));
      lines.push("```");

      return text(lines.join("\n"));
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "get_workflow_overview",
  "Get a complete overview of a workflow: all steps with their code, recent executions, and config. Useful as context before making changes.",
  {
    workflowId: z.number().describe("Workflow ID"),
    includeExecutions: z
      .number()
      .optional()
      .describe("Number of recent executions to include (default 3)"),
  },
  async ({ workflowId, includeExecutions = 3 }) => {
    try {
      const [workflow, flows, executions] = await Promise.all([
        client.getWorkflow(workflowId),
        client.getWorkflowFlows(workflowId),
        client.listExecutions(workflowId, { size: includeExecutions }),
      ]);

      const flowList = Array.isArray(flows) ? flows : [];

      const flowsWithCode = await Promise.all(
        flowList.map(async (f: any) => {
          try {
            const code = await client.readFlow(f.id);
            return {
              ...f,
              code: typeof code === "string" ? code : JSON.stringify(code),
            };
          } catch {
            return { ...f, code: "(could not read)" };
          }
        }),
      );

      return ok({
        workflow,
        steps: flowsWithCode.map((f: any) => ({
          id: f.id,
          name: f.name,
          description: f.description,
          executionOrder: f.executionOrder,
          flowType: f.flowType,
          language: f.language,
          code: f.code,
        })),
        recentExecutions: executions?.content || executions || [],
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "get_execution_input",
  "Get the input data from a specific execution, so you can reuse it to test the workflow again. Returns data.input from the first step.",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID to get input from"),
  },
  async ({ workflowId, executionId }) => {
    try {
      const exec = await client.getExecution(workflowId, executionId);
      const flowRuns = exec?.flowRuns || [];
      if (flowRuns.length === 0)
        return text("No flow runs found in this execution.");

      const firstRun = flowRuns[0];
      let input: any = null;

      if (firstRun.transformation) {
        try {
          const t =
            typeof firstRun.transformation === "string"
              ? JSON.parse(firstRun.transformation)
              : firstRun.transformation;
          input = t?.input || t;
        } catch {
          input = firstRun.transformation;
        }
      }

      if (!input && firstRun.payload) {
        try {
          input =
            typeof firstRun.payload === "string"
              ? JSON.parse(firstRun.payload)
              : firstRun.payload;
        } catch {
          input = firstRun.payload;
        }
      }

      return ok({
        executionId,
        status: exec.status,
        startedAt: exec.startedAt,
        input,
        hint: "Use this input with execute_workflow to re-test the workflow",
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "test_workflow_step",
  "Execute a workflow up to (or from) a specific step for testing. Useful for isolating and debugging individual steps.",
  {
    workflowId: z.number().describe("Workflow ID"),
    step: z.number().describe("Step number to test"),
    mode: z
      .enum(["up_to", "single", "from"])
      .describe(
        "up_to: run steps 1..N, single: run only step N, from: run steps N..end",
      ),
    body: z
      .any()
      .optional()
      .describe(
        "Input data (JSON). Use get_execution_input to grab from a previous run.",
      ),
    configurationId: z
      .union([z.number(), z.string()])
      .optional()
      .describe("Configuration store ID (number or string)"),
  },
  async ({ workflowId, step, mode, body, configurationId }) => {
    try {
      const params: any = { configuration_id: configurationId };
      if (mode === "up_to") {
        params.end_at_step = step;
      } else if (mode === "single") {
        params.start_from_step = step;
        params.end_at_step = step;
      } else if (mode === "from") {
        params.start_from_step = step;
      }

      const result = await client.executeWorkflow(workflowId, body, params);
      return ok(result);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "compare_flow_versions",
  "Compare two versions of a flow side by side with a unified diff. Useful for reviewing what changed between versions.",
  {
    flowId: z.number().describe("Flow ID"),
    versionA: z
      .number()
      .optional()
      .describe("First version ID (omit for current)"),
    versionB: z.number().describe("Second version ID to compare against"),
  },
  async ({ flowId, versionA, versionB }) => {
    try {
      const [codeA, codeB] = await Promise.all([
        versionA
          ? client.readFlowVersion(flowId, versionA)
          : client.readFlow(flowId),
        client.readFlowVersion(flowId, versionB),
      ]);

      const strA =
        typeof codeA === "string" ? codeA : JSON.stringify(codeA, null, 2);
      const strB =
        typeof codeB === "string" ? codeB : JSON.stringify(codeB, null, 2);

      const labelA = versionA ? `Version ${versionA}` : "Current";
      const labelB = `Version ${versionB}`;

      return text(
        `## Flow ${flowId}: ${labelA} vs ${labelB}\n\n\`\`\`diff\n${computeDiff(strA, strB, labelA, labelB)}\n\`\`\``,
      );
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "diagnose_execution",
  "Analyze a workflow execution to find failures. Returns failed steps with errors, preceding step output, code, and for RPA flows: specific failure pattern analysis and fix suggestions.",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID to diagnose"),
  },
  async ({ workflowId, executionId }) => {
    try {
      const exec = await client.getExecution(workflowId, executionId);
      const flowRuns: any[] = exec?.flowRuns || [];

      const failures = flowRuns.filter((r: any) => r.status === "FAILED");

      if (failures.length === 0) {
        const summary = flowRuns.map((r: any) => ({
          step: r.executionOrder,
          name: r.flowName,
          status: r.status,
          duration: r.durationMs,
        }));
        return ok({
          executionId,
          overallStatus: exec.status,
          message: "No failed steps found.",
          stepSummary: summary,
        });
      }

      const details = failures.map((r: any) => {
        const prevStep = flowRuns.find(
          (p: any) =>
            p.executionOrder === r.executionOrder - 1 && p.status === "SUCCESS",
        );

        const errorStr = JSON.stringify(r.executionLog || r.response || "");
        const programStr = JSON.stringify(r.program || "");
        const isRpa = programStr.includes("lam.rpa") || programStr.includes("lam.httpRequest") || programStr.includes("pyautogui") || programStr.includes("uiautomation");

        let rpaAnalysis: { pattern: string; suggestion: string } | null = null;
        if (isRpa) {
          if (errorStr.includes("ElementNotFound") || errorStr.includes("not found") || errorStr.includes("Exists") || errorStr.includes("WindowControl")) {
            rpaAnalysis = {
              pattern: "element_not_found",
              suggestion: "The target UI element was not found. Possible causes: (1) the app hasn't fully loaded — add time.sleep() before the interaction, (2) the window title changed — use vm_inspect_ui window_list to check current titles, (3) the element's AutomationId or coordinates shifted — re-inspect with element_tree.",
            };
          } else if (errorStr.includes("timeout") || errorStr.includes("Timeout") || errorStr.includes("timed out")) {
            rpaAnalysis = {
              pattern: "timeout",
              suggestion: "The script timed out waiting for an element or action. Increase sleep/wait times, or add a retry loop that checks for the element before acting.",
            };
          } else if (errorStr.includes("click") || errorStr.includes("position") || errorStr.includes("coordinate")) {
            rpaAnalysis = {
              pattern: "click_target_missed",
              suggestion: "A click may have hit the wrong location. Screen resolution or window position may have changed. Use vm_inspect_ui element_at_point to verify coordinates, or switch to element-based interaction (AutomationId) instead of pixel coordinates.",
            };
          } else if (errorStr.includes("connection") || errorStr.includes("Connection") || errorStr.includes("ECONNREFUSED")) {
            rpaAnalysis = {
              pattern: "lds_connection_failed",
              suggestion: "Could not reach the Laminar Desktop Service. Check that the Cloudflare Tunnel is still active and the LDS process is running on the VM. Try vm_status to verify connectivity.",
            };
          } else if (errorStr.includes("resolution") || errorStr.includes("DPI") || errorStr.includes("scale")) {
            rpaAnalysis = {
              pattern: "resolution_mismatch",
              suggestion: "Script may have been built at a different screen resolution than it's running at. Use vm_inspect_ui screen_info to check current resolution, and re-record coordinates if needed.",
            };
          } else {
            rpaAnalysis = {
              pattern: "unknown_rpa_error",
              suggestion: "Review the stderr/stdout for the root cause. Common RPA issues: wrong window focused (use vm_reset_state first), element not interactable (check IsEnabled), unexpected dialog/popup blocking the target.",
            };
          }
        }

        return {
          stepName: r.flowName,
          executionOrder: r.executionOrder,
          status: r.status,
          duration: r.durationMs,
          error: r.executionLog || r.response,
          transformation: r.transformation,
          program: r.program,
          precedingStepOutput: prevStep
            ? {
                name: prevStep.flowName,
                response: prevStep.response,
              }
            : null,
          ...(rpaAnalysis && { rpaFailureAnalysis: rpaAnalysis }),
        };
      });

      const baseUrl = getApiBase();

      return ok({
        executionId,
        overallStatus: exec.status,
        startedAt: exec.startedAt,
        endedAt: exec.endedAt,
        failedStepCount: failures.length,
        totalSteps: flowRuns.length,
        failures: details,
        viewInPlatform: `${baseUrl.replace("/api.", "/app.")}/workflow/${workflowId}/execution/${executionId}`,
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ELASTICSEARCH LOG SEARCH (advanced — requires ES config)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "search_logs",
  "Full-text search across workflow execution logs, responses, programs, and transformations using Elasticsearch. Requires ES to be configured (see setup). Supports field syntax (status:FAILED), fuzzy search, date ranges, and raw ES queries.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    query: z
      .string()
      .optional()
      .describe(
        "Search text. Supports field:value syntax, wildcards, boolean operators, exact phrases in quotes.",
      ),
    workflowId: z
      .string()
      .optional()
      .describe("Filter to a single workflow ID"),
    workflowIds: z
      .array(z.string())
      .optional()
      .describe("Filter to multiple workflow IDs"),
    status: z
      .string()
      .optional()
      .describe("Filter by status: SUCCESS, FAILED, RUNNING, etc."),
    startDate: z.string().optional().describe("Start date (ISO 8601)"),
    endDate: z.string().optional().describe("End date (ISO 8601)"),
    fuzzy: z
      .boolean()
      .optional()
      .describe("Enable fuzzy matching (default false)"),
    includeGlobalObject: z
      .boolean()
      .optional()
      .describe(
        "Also search global workflow object — slower but more thorough",
      ),
    rawQuery: z
      .string()
      .optional()
      .describe("Raw Elasticsearch JSON query (advanced mode)"),
    size: z.number().optional().describe("Results per page (default 20)"),
    from: z.number().optional().describe("Offset for pagination"),
  },
  async (params) => {
    const blocked = requireES();
    if (blocked) return blocked;
    try {
      const results = await esService!.search(params);
      return ok(results);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "search_across_workflows",
  "Search for a value (order ID, error message, customer name, etc.) across multiple workflows in a time range. Great for incident investigation — finds correlated failures. Requires ES to be configured.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    query: z
      .string()
      .describe(
        "What to search for (order ID, error message, entity name, etc.)",
      ),
    workflowIds: z
      .array(z.string())
      .optional()
      .describe(
        "Specific workflow IDs to search (omit to search ALL workflows)",
      ),
    startDate: z.string().optional().describe("Start of time range (ISO 8601)"),
    endDate: z.string().optional().describe("End of time range (ISO 8601)"),
    status: z.string().optional().describe("Filter by status (e.g., FAILED)"),
    size: z.number().optional().describe("Max results (default 50)"),
  },
  async ({
    workspaceId,
    query,
    workflowIds,
    startDate,
    endDate,
    status,
    size,
  }) => {
    const blocked = requireES();
    if (blocked) return blocked;
    try {
      const results = await esService!.search({
        workspaceId,
        query,
        workflowIds,
        startDate,
        endDate,
        status,
        size: size || 50,
        fuzzy: true,
        includeGlobalObject: true,
      });

      // Group by workflow for easier reading
      const byWorkflow = new Map<string, any[]>();
      for (const hit of results.hits) {
        const wId = hit.workflowId || "unknown";
        if (!byWorkflow.has(wId)) byWorkflow.set(wId, []);
        byWorkflow.get(wId)!.push(hit);
      }

      return ok({
        total: results.total,
        took: results.took,
        query,
        timeRange: { startDate, endDate },
        byWorkflow: Object.fromEntries(byWorkflow),
        warning: results.warning,
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "investigate_incident",
  "Investigate an incident across workflows. Finds all failures in a time window, correlates by shared data, and produces a timeline. Works with or without Elasticsearch — ES gives full-text search, without ES falls back to API-based execution listing.",
  {
    workspaceId: z.number().describe("Workspace ID"),
    workflowIds: z.array(z.number()).describe("Workflow IDs to investigate"),
    startDate: z
      .string()
      .optional()
      .describe("Start of incident window (ISO 8601)"),
    endDate: z
      .string()
      .optional()
      .describe("End of incident window (ISO 8601)"),
    keywords: z
      .array(z.string())
      .optional()
      .describe("Search terms to correlate (order IDs, error messages, etc.)"),
    status: z.string().optional().describe("Filter status (default: FAILED)"),
  },
  async ({
    workspaceId,
    workflowIds,
    startDate,
    endDate,
    keywords,
    status,
  }) => {
    try {
      const filterStatus = status || "FAILED";

      if (esService && keywords?.length) {
        // ES-powered investigation: search for keywords across workflows
        const searchPromises = keywords.map((kw) =>
          esService!.search({
            workspaceId: String(workspaceId),
            query: kw,
            workflowIds: workflowIds.map(String),
            startDate,
            endDate,
            status: filterStatus,
            size: 20,
            fuzzy: true,
            includeGlobalObject: true,
          }),
        );

        const searchResults = await Promise.all(searchPromises);

        const allHits: any[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < searchResults.length; i++) {
          for (const hit of searchResults[i].hits) {
            if (!seen.has(hit.id)) {
              seen.add(hit.id);
              allHits.push({
                ...hit,
                matchedKeyword: keywords![i],
              });
            }
          }
        }

        allHits.sort(
          (a, b) =>
            new Date(a.startedAt || 0).getTime() -
            new Date(b.startedAt || 0).getTime(),
        );

        return ok({
          mode: "elasticsearch",
          totalMatches: allHits.length,
          keywords,
          timeline: allHits.map((h) => ({
            time: h.startedAt,
            workflowId: h.workflowId,
            workflowName: h.workflowName,
            executionId: h.executionId,
            status: h.status,
            matchedKeyword: h.matchedKeyword,
            score: h.score,
          })),
        });
      }

      // API-based fallback: list executions from each workflow
      const allExecs: any[] = [];
      await Promise.all(
        workflowIds.map(async (wId) => {
          try {
            const workflow = await client.getWorkflow(wId);
            const execs = await client.listExecutions(wId, {
              startDate,
              endDate,
              status: filterStatus,
              size: 20,
            });
            const list = execs?.content || execs || [];
            for (const exec of Array.isArray(list) ? list : []) {
              allExecs.push({
                workflowId: wId,
                workflowName: workflow.name,
                ...exec,
              });
            }
          } catch {}
        }),
      );

      allExecs.sort(
        (a, b) =>
          new Date(a.startedAt || 0).getTime() -
          new Date(b.startedAt || 0).getTime(),
      );

      // Diagnose each failed execution
      const diagnosed = await Promise.all(
        allExecs.slice(0, 10).map(async (exec) => {
          try {
            const full = await client.getExecution(exec.workflowId, exec.id);
            const failedSteps = (full.flowRuns || []).filter(
              (r: any) => r.status === "FAILED",
            );
            return {
              time: exec.startedAt,
              workflowId: exec.workflowId,
              workflowName: exec.workflowName,
              executionId: exec.id,
              status: exec.status,
              failedSteps: failedSteps.map((f: any) => ({
                step: f.executionOrder,
                name: f.flowName,
                error:
                  f.executionLog?.substring(0, 500) ||
                  (typeof f.response === "string"
                    ? f.response.substring(0, 500)
                    : JSON.stringify(f.response)?.substring(0, 500)),
              })),
            };
          } catch {
            return {
              time: exec.startedAt,
              workflowId: exec.workflowId,
              workflowName: exec.workflowName,
              executionId: exec.id,
              status: exec.status,
              failedSteps: [],
            };
          }
        }),
      );

      return ok({
        mode: "api",
        hint: "Configure Elasticsearch for keyword-based correlation search",
        totalFailures: allExecs.length,
        timeline: diagnosed,
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CRON JOB MANAGEMENT (advanced — requires CRON config)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "list_cron_jobs",
  "List all CRON jobs, optionally filtered by workflow. Requires CRON service to be configured.",
  {
    workflowId: z
      .string()
      .optional()
      .describe("Filter by workflow ID (omit for all jobs)"),
  },
  async ({ workflowId }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    return safe(() => cronService!.listJobs(workflowId));
  },
);

server.tool(
  "get_cron_job",
  "Get details of a specific CRON job",
  { jobId: z.string().describe("CRON job ID") },
  async ({ jobId }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    return safe(() => cronService!.getJob(jobId));
  },
);

server.tool(
  "create_cron_job",
  "Create a new CRON job to run a workflow on a schedule",
  {
    name: z.string().describe("Job name"),
    schedule: z
      .string()
      .describe("CRON expression (e.g., '0 */30 * * * *' for every 30 min)"),
    url: z
      .string()
      .describe(
        "Workflow execution URL (e.g., https://api.laminar.run/workflow/execute/external/{id}?api_key=...)",
      ),
    body: z
      .record(z.string(), z.any())
      .optional()
      .describe("JSON body to send with each execution"),
    enabled: z.boolean().optional().describe("Start enabled (default true)"),
    maxRuns: z
      .number()
      .optional()
      .describe("Max number of runs (null for unlimited)"),
  },
  async ({ name, schedule, url, body, enabled, maxRuns }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    return safe(() =>
      cronService!.createJob({
        name,
        schedule,
        url,
        body,
        enabled: enabled ?? true,
        max_runs: maxRuns,
      }),
    );
  },
);

server.tool(
  "update_cron_job",
  "Update an existing CRON job (name, schedule, URL, body, enabled)",
  {
    jobId: z.string().describe("CRON job ID"),
    name: z.string().optional().describe("New name"),
    schedule: z.string().optional().describe("New CRON schedule"),
    url: z.string().optional().describe("New execution URL"),
    body: z.record(z.string(), z.any()).optional().describe("New JSON body"),
    enabled: z.boolean().optional().describe("Enable or disable"),
  },
  async ({ jobId, ...updates }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    return safe(() => cronService!.updateJob(jobId, updates));
  },
);

server.tool(
  "toggle_cron_job",
  "Toggle a CRON job on/off",
  { jobId: z.string().describe("CRON job ID") },
  async ({ jobId }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    return safe(() => cronService!.toggleJob(jobId));
  },
);

server.tool(
  "trigger_cron_job",
  "Manually trigger a CRON job right now (runs it once immediately)",
  { jobId: z.string().describe("CRON job ID") },
  async ({ jobId }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    try {
      await cronService!.triggerJob(jobId);
      return text(`CRON job ${jobId} triggered successfully.`);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "delete_cron_job",
  "Delete a CRON job",
  { jobId: z.string().describe("CRON job ID") },
  async ({ jobId }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    try {
      await cronService!.deleteJob(jobId);
      return text(`CRON job ${jobId} deleted.`);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "schedule_retry",
  "Schedule automatic retries for a failed workflow execution. Creates a temporary CRON job that re-runs the workflow with the original input. Requires CRON service.",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Failed execution ID to retry"),
    schedule: z
      .string()
      .optional()
      .describe("CRON schedule (default: every 30 min — '0 */30 * * * *')"),
    maxAttempts: z
      .number()
      .optional()
      .describe("Max retry attempts (default 3)"),
    executionUrl: z
      .string()
      .describe(
        "Workflow execution URL with API key (e.g., https://api.laminar.run/workflow/execute/external/{id}?api_key=...)",
      ),
  },
  async ({ workflowId, executionId, schedule, maxAttempts, executionUrl }) => {
    const blocked = requireCron();
    if (blocked) return blocked;
    try {
      // Get original execution input
      const exec = await client.getExecution(workflowId, executionId);
      const flowRuns = exec?.flowRuns || [];
      let inputData: any = {};

      if (flowRuns.length > 0) {
        const first = flowRuns[0];
        if (first.transformation) {
          try {
            const t =
              typeof first.transformation === "string"
                ? JSON.parse(first.transformation)
                : first.transformation;
            inputData = t?.input || t;
          } catch {
            inputData = {};
          }
        }
      }

      const job = await cronService!.createJob({
        name: `Retry: Workflow ${workflowId} (Exec #${executionId})`,
        schedule: schedule || "0 */30 * * * *",
        url: executionUrl,
        body: {
          ...inputData,
          "lam.retryAttempt": true,
          "lam.originalExecutionId": executionId,
          "lam.retryReason": "mcp_scheduled_retry",
        },
        max_runs: maxAttempts || 3,
        is_temporary: true,
        enabled: true,
      });

      return ok({
        message: "Retry scheduled",
        jobId: job.id,
        schedule: schedule || "0 */30 * * * *",
        maxAttempts: maxAttempts || 3,
        originalInput: inputData,
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WORKFLOW SYNC — pull/push/init for git version control
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.tool(
  "init_project",
  "Scaffold a full Laminar project from a workspace. Pulls all (or selected) workflows into a git-ready directory with laminar.json manifest, GitHub Actions CI/CD configs, README, and .gitignore. This is the onboarding tool — run it once to set up version control for a workspace.",
  {
    workspaceId: z.number().describe("Workspace ID to pull workflows from"),
    outputDir: z
      .string()
      .describe(
        "Directory to create the project in (e.g., /Users/you/my-laminar-workflows)",
      ),
    workflowIds: z
      .array(z.number())
      .optional()
      .describe(
        "Specific workflow IDs to include (omit to pull ALL workflows)",
      ),
  },
  async ({ workspaceId, outputDir, workflowIds }) => {
    try {
      const resolved = path.resolve(outputDir);
      const result = await initProject(client, workspaceId, resolved, {
        workflowIds,
        apiBase: getApiBase(),
      });
      return ok({
        ...result,
        nextSteps: [
          `cd ${resolved}`,
          "git init && git add . && git commit -m 'Initial Laminar workflow sync'",
          "git remote add origin <your-github-repo-url>",
          "git push -u origin main",
          "Add LAMINAR_API_KEY as a repository secret in GitHub Settings > Secrets",
          "Done! Push to main to deploy, open PRs to preview changes.",
        ],
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "pull_workflow",
  "Download a workflow from Laminar to local files for version control. Creates a directory with individual step files + workflow.json metadata. Compatible with git.",
  {
    workflowId: z.number().describe("Workflow ID to pull"),
    outputDir: z
      .string()
      .describe(
        "Local directory to write files to (e.g., ./workflows/my-workflow)",
      ),
  },
  async ({ workflowId, outputDir }) => {
    try {
      const resolved = path.resolve(outputDir);
      const result = await pullWorkflow(client, workflowId, resolved);
      return ok({
        ...result,
        hint: "Files are ready for git. Edit step files in steps/, then use push_workflow to deploy.",
      });
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "push_workflow",
  "Deploy local workflow files to Laminar. Reads workflow.json + step files and pushes them via create_or_update_flows API.",
  {
    workflowDir: z
      .string()
      .describe("Local directory containing workflow.json and steps/ folder"),
    workflowId: z
      .number()
      .optional()
      .describe("Target workflow ID (overrides ID in workflow.json)"),
  },
  async ({ workflowDir, workflowId }) => {
    try {
      const resolved = path.resolve(workflowDir);
      const result = await pushWorkflow(client, resolved, workflowId);
      return ok(result);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "sync_status",
  "Compare local workflow files against what's deployed on Laminar. Shows which steps are modified, added, or unchanged.",
  {
    workflowDir: z
      .string()
      .describe("Local directory containing workflow.json and steps/ folder"),
    workflowId: z
      .number()
      .optional()
      .describe(
        "Workflow ID to compare against (overrides ID in workflow.json)",
      ),
  },
  async ({ workflowDir, workflowId }) => {
    try {
      const resolved = path.resolve(workflowDir);
      const result = await syncStatus(client, resolved, workflowId);
      return ok(result);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "pull_all",
  "Pull all workflows defined in the laminar.json manifest. Updates local step files from what's deployed on Laminar.",
  {
    projectDir: z
      .string()
      .describe("Root project directory containing laminar.json"),
  },
  async ({ projectDir }) => {
    try {
      const resolved = path.resolve(projectDir);
      const result = await pullAll(client, resolved);
      return ok(result);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

server.tool(
  "push_changed",
  "Push only the workflows that have local changes to Laminar. Reads laminar.json manifest, diffs each workflow, and deploys only the modified ones.",
  {
    projectDir: z
      .string()
      .describe("Root project directory containing laminar.json"),
  },
  async ({ projectDir }) => {
    try {
      const resolved = path.resolve(projectDir);
      const result = await pushChanged(client, resolved);
      return ok(result);
    } catch (e: any) {
      return text(`Error: ${e.message}`);
    }
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VM / LAMINAR DESKTOP SERVICE (session-based — user provides Cloudflare Tunnel URL at runtime)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Connection Management ────────────────────────────────────

server.tool(
  "vm_connect",
  "Connect to a Laminar Desktop Service running on a VM via its Cloudflare Tunnel URL. Call this before using any other vm_* tools. The URL is stored for the duration of this session.",
  {
    url: z
      .string()
      .describe(
        "Cloudflare Tunnel URL for the Laminar Desktop Service (e.g. https://xxx.trycloudflare.com)",
      ),
    apiKey: z
      .string()
      .optional()
      .describe("LDS API key (only needed if the LDS instance requires auth)"),
    serviceId: z
      .string()
      .optional()
      .describe(
        "LDS Service ID (only needed if the LDS instance requires auth)",
      ),
  },
  async ({ url, apiKey, serviceId }) => {
    try {
      const h = await lds.health(url);
      ldsConnection = { url, apiKey, serviceId };
      return ok({
        connected: true,
        url,
        version: h.version,
        uptime: h.uptime,
        status: h.status,
        authConfigured: !!(apiKey && serviceId),
      });
    } catch (e: any) {
      ldsConnection = null;
      return text(`Failed to connect to LDS at ${url}: ${e.message}`);
    }
  },
);

server.tool(
  "vm_disconnect",
  "Disconnect from the current VM / Laminar Desktop Service session",
  {},
  async () => {
    const wasConnected = !!ldsConnection;
    const prevUrl = ldsConnection?.url;
    ldsConnection = null;
    return text(
      wasConnected ? `Disconnected from ${prevUrl}` : "No VM was connected.",
    );
  },
);

server.tool(
  "vm_status",
  "Show current VM connection status (URL, connected or not)",
  {},
  async () => {
    if (!ldsConnection) return text(NOT_CONNECTED_VM);
    try {
      const h = await lds.health(ldsConnection.url);
      return ok({
        connected: true,
        url: ldsConnection.url,
        authConfigured: !!(ldsConnection.apiKey && ldsConnection.serviceId),
        lds: h,
      });
    } catch (e: any) {
      return ok({
        connected: true,
        url: ldsConnection.url,
        reachable: false,
        error: e.message,
      });
    }
  },
);

// ── Core VM Tools ────────────────────────────────────────────

server.tool(
  "vm_screenshot",
  "Capture a screenshot of the VM desktop. Returns the image as base64 PNG with metadata (width, height, capture duration).",
  {},
  async () => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      const res = await lds.screenshot(ldsConnection!.url, ldsAuth());
      return {
        content: [
          {
            type: "image" as const,
            data: res.image,
            mimeType: "image/png" as const,
          },
          {
            type: "text" as const,
            text: json({
              width: res.metadata.width,
              height: res.metadata.height,
              size_bytes: res.metadata.size_bytes,
              capture_duration_ms: res.metadata.capture_duration_ms,
              timestamp: res.metadata.timestamp,
            }),
          },
        ],
      };
    } catch (e: any) {
      return text(`Screenshot failed: ${e.message}`);
    }
  },
);

server.tool(
  "vm_execute_script",
  "Execute a Python script on the VM desktop via the Laminar Desktop Service. The script runs with full desktop access (pyautogui, uiautomation, etc.). The user will review the script before it executes. IMPORTANT: When building RPA workflows, you MUST call this to validate every script on the VM, then call vm_screenshot to verify the result, BEFORE saving the step with create_rpa_flow.",
  {
    script: z.string().describe("Python script to execute on the VM"),
    executionId: z.string().optional().describe("Execution ID for tracking"),
    flowId: z.string().optional().describe("Flow/workflow ID for tracking"),
  },
  async ({ script, executionId, flowId }) => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      const res = await lds.execute(
        ldsConnection!.url,
        script,
        { executionId, flowId },
        ldsAuth(),
      );
      return ok({
        success: res.success,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        executionTimeMs: res.executionTimeMs,
        skipped: res.skipped,
        stopped: res.stopped,
        resultData: res.resultData,
      });
    } catch (e: any) {
      return text(`Script execution failed: ${e.message}`);
    }
  },
);

server.tool(
  "vm_execution_status",
  "Get the current execution state on the VM (idle, running, paused, stopped, completed, failed)",
  {},
  async () => {
    const blocked = requireVM();
    if (blocked) return blocked;
    return safe(() => lds.executionStatus(ldsConnection!.url, ldsAuth()));
  },
);

server.tool(
  "vm_execution_control",
  "Send a control command to the currently running execution on the VM",
  {
    command: z
      .enum(["pause", "resume", "stop", "skip"])
      .describe("Control command to send"),
  },
  async ({ command }) => {
    const blocked = requireVM();
    if (blocked) return blocked;
    return safe(() => lds.executionControl(ldsConnection!.url, command, ldsAuth()));
  },
);

// ── UI Inspection ────────────────────────────────────────────

server.tool(
  "vm_inspect_ui",
  "Inspect UI elements on the VM desktop. Generates and executes the appropriate inspection script for the chosen framework. Use this to understand what is on screen, get element coordinates, and map the UI tree before writing RPA scripts.",
  {
    mode: z
      .enum([
        "window_list",
        "screen_info",
        "element_at_point",
        "element_tree",
        "focused_element",
      ])
      .describe(
        "window_list: list visible windows. screen_info: resolution/DPI/active window. element_at_point: inspect element at x,y. element_tree: accessibility tree for a window. focused_element: currently focused control.",
      ),
    x: z
      .number()
      .optional()
      .describe("X coordinate (for element_at_point mode)"),
    y: z
      .number()
      .optional()
      .describe("Y coordinate (for element_at_point mode)"),
    windowTitle: z
      .string()
      .optional()
      .describe(
        "Window title to inspect (for element_tree mode; omit to use the foreground window)",
      ),
    framework: z
      .enum(["auto", "uiautomation", "pywinauto", "jab"])
      .optional()
      .describe(
        "UI automation framework to use. auto (default) uses uiautomation. Use jab for Java/Swing apps, pywinauto for an alternative Windows UI backend.",
      ),
    depth: z
      .number()
      .optional()
      .describe(
        "Max depth for element_tree traversal (default 3). Keep low to avoid huge output.",
      ),
  },
  async ({ mode, x, y, windowTitle, framework, depth }) => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      const script = generateInspectScript({
        mode,
        x,
        y,
        windowTitle,
        framework: framework ?? "auto",
        depth,
      });
      const res = await lds.execute(
        ldsConnection!.url,
        script,
        { flowId: `inspect-${mode}` },
        ldsAuth(),
      );
      if (!res.success) {
        return text(
          `Inspection failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`,
        );
      }
      // Try to parse stdout as JSON for clean output
      try {
        const parsed = JSON.parse(res.stdout);
        return ok(parsed);
      } catch {
        return text(res.stdout);
      }
    } catch (e: any) {
      return text(`Inspection failed: ${e.message}`);
    }
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RPA FLOW BUILDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildRpaProgram(
  pythonScript: string,
  pattern: "cloudflare_tunnel" | "channel",
  flowId: string,
  stepName: string,
  stepDescription: string,
): string {
  const escaped = pythonScript.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  if (pattern === "channel") {
    return `(data) => {
  const pythonScript = \`
${escaped}
\`;
  return {
    "lam.rpa": {
      "script": pythonScript,
      "channelId": "{{config.channelId}}"
    }
  };
}`;
  }
  return `(data) => {
  const pythonScript = \`
${escaped}
\`;
  return {
    "lam.httpRequest": {
      "method": "POST",
      "url": "{{config.laminar_desktop_service_url}}/execute",
      "headers": {
        "Content-Type": "application/json",
        "X-API-Key": "{{config.laminar_desktop_service_api_key}}",
        "X-Service-ID": "{{config.laminar_desktop_service_id}}"
      },
      "body": {
        "flowId": "${flowId}",
        "script": pythonScript,
        "executionId": "1",
        "step": { "id": "${flowId}", "name": "${stepName.replace(/"/g, '\\"')}", "description": "${stepDescription.replace(/"/g, '\\"')}", "versionId": "v1.0" }
      }
    }
  };
}`;
}

server.tool(
  "create_rpa_flow",
  "Create an RPA flow step from a validated Python script. Automatically wraps the script in the correct Laminar JS format (lam.httpRequest for Cloudflare Tunnel, or lam.rpa for channel). Use this instead of create_flow for RPA steps — you only provide the Python script, the tool handles the JS wrapper.",
  {
    workflowId: z.number().describe("Workflow ID"),
    name: z.string().describe("Step name (e.g. 'Login to Open Dental')"),
    description: z.string().describe("What this step does"),
    pythonScript: z.string().describe("The validated Python RPA script (must have been tested via vm_execute_script first)"),
    executionOrder: z.number().describe("Step position in workflow (starts at 1)"),
    flowId: z.string().describe("Unique step identifier used in the request body (e.g. 'login-to-app')"),
    dispatchPattern: z
      .enum(["cloudflare_tunnel", "channel"])
      .default("cloudflare_tunnel")
      .describe("How to dispatch the script to the VM. Use cloudflare_tunnel (default) when a tunnel URL was provided via vm_connect, or channel when using pub/sub channelId."),
  },
  async ({ workflowId, name, description, pythonScript, executionOrder, flowId, dispatchPattern }) => {
    const program = buildRpaProgram(pythonScript, dispatchPattern, flowId, name, description);
    return safe(() =>
      client.createFlow({
        workflowId,
        name,
        description,
        program,
        executionOrder,
        language: "js",
        flowType: "RPA",
      }),
    );
  },
);

// ── VM Data Extraction Tools ─────────────────────────────────

server.tool(
  "vm_read_clipboard",
  "Read the current clipboard text content on the VM. Useful after performing a copy operation (Ctrl+C) to extract data from fields that aren't accessible via the UI tree. Combine with vm_execute_script to click a field, select all (Ctrl+A), copy (Ctrl+C), then read.",
  {},
  async () => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      const script = `
import json
try:
    import win32clipboard
    win32clipboard.OpenClipboard()
    try:
        data = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
    except TypeError:
        data = ""
    finally:
        win32clipboard.CloseClipboard()
except ImportError:
    import subprocess
    result = subprocess.run(['powershell', '-command', 'Get-Clipboard'], capture_output=True, text=True, timeout=5)
    data = result.stdout.strip()
print(json.dumps({"clipboard": data}))
`.trim();
      const res = await lds.execute(
        ldsConnection!.url,
        script,
        { flowId: "read-clipboard" },
        ldsAuth(),
      );
      if (!res.success) {
        return text(`Clipboard read failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
      }
      try {
        return ok(JSON.parse(res.stdout));
      } catch {
        return text(res.stdout);
      }
    } catch (e: any) {
      return text(`Clipboard read failed: ${e.message}`);
    }
  },
);

server.tool(
  "vm_screenshot_region",
  "Capture a cropped region of the VM desktop as a screenshot. Use when the full desktop screenshot is too low resolution to read text clearly. Returns the cropped image as base64 PNG.",
  {
    x: z.number().describe("Left edge X coordinate of the region"),
    y: z.number().describe("Top edge Y coordinate of the region"),
    width: z.number().describe("Width of the region in pixels"),
    height: z.number().describe("Height of the region in pixels"),
  },
  async ({ x, y, width, height }) => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      const script = `
import json, base64, io
from PIL import ImageGrab

img = ImageGrab.grab(bbox=(${x}, ${y}, ${x + width}, ${y + height}))
buf = io.BytesIO()
img.save(buf, format='PNG')
b64 = base64.b64encode(buf.getvalue()).decode('ascii')
print(json.dumps({"image": b64, "width": img.width, "height": img.height}))
`.trim();
      const res = await lds.execute(
        ldsConnection!.url,
        script,
        { flowId: "screenshot-region" },
        ldsAuth(),
      );
      if (!res.success) {
        return text(`Region screenshot failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
      }
      try {
        const parsed = JSON.parse(res.stdout);
        return {
          content: [
            {
              type: "image" as const,
              data: parsed.image,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: json({ width: parsed.width, height: parsed.height, region: { x, y, width, height } }),
            },
          ],
        };
      } catch {
        return text(res.stdout);
      }
    } catch (e: any) {
      return text(`Region screenshot failed: ${e.message}`);
    }
  },
);

// ── Debug & Iteration Tools ──────────────────────────────────

server.tool(
  "debug_rpa_step",
  "Run a Python RPA script with full before/after diagnostics. Takes a screenshot BEFORE execution, runs the script, then takes a screenshot AFTER. Returns both screenshots plus stdout/stderr/exit code. Use this during RPA development to see exactly what changed.",
  {
    script: z.string().describe("Python script to execute on the VM"),
    stepName: z.string().optional().describe("Optional name for tracking"),
  },
  async ({ script, stepName }) => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      const beforeShot = await lds.screenshot(ldsConnection!.url, ldsAuth());
      const execResult = await lds.execute(
        ldsConnection!.url,
        script,
        { flowId: stepName ? `debug-${stepName}` : "debug-step" },
        ldsAuth(),
      );
      const afterShot = await lds.screenshot(ldsConnection!.url, ldsAuth());
      return {
        content: [
          { type: "text" as const, text: "## Before Execution" },
          { type: "image" as const, data: beforeShot.image, mimeType: "image/png" as const },
          {
            type: "text" as const,
            text: json({
              success: execResult.success,
              exitCode: execResult.exitCode,
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              executionTimeMs: execResult.executionTimeMs,
            }),
          },
          { type: "text" as const, text: "## After Execution" },
          { type: "image" as const, data: afterShot.image, mimeType: "image/png" as const },
        ],
      };
    } catch (e: any) {
      return text(`Debug step failed: ${e.message}`);
    }
  },
);

server.tool(
  "vm_reset_state",
  "Reset the VM application to a known state (Smart Launch). Closes all dialogs/popups for the target app and optionally navigates to a specific screen. Use before running an RPA workflow to ensure a clean starting point.",
  {
    appName: z.string().describe("Application name or window title pattern (e.g. 'Open Dental')"),
    action: z
      .enum(["close_dialogs", "close_app", "minimize_all", "focus_app"])
      .default("close_dialogs")
      .describe("What reset action to perform"),
  },
  async ({ appName, action }) => {
    const blocked = requireVM();
    if (blocked) return blocked;
    try {
      let script: string;
      if (action === "close_dialogs") {
        script = `
import json, time
import uiautomation as auto

app_pattern = ${JSON.stringify(appName)}
closed = []
root = auto.GetRootControl()
for win in root.GetChildren():
    try:
        if app_pattern.lower() in (win.Name or '').lower():
            for child in win.GetChildren():
                try:
                    if child.ControlTypeName in ('Window', 'Pane') and child.Name:
                        child_rect = child.BoundingRectangle
                        parent_rect = win.BoundingRectangle
                        if child_rect.width() < parent_rect.width() * 0.95:
                            import pyautogui
                            pyautogui.press('escape')
                            time.sleep(0.3)
                            closed.append(child.Name)
                except Exception:
                    pass
    except Exception:
        pass
print(json.dumps({"action": "close_dialogs", "app": app_pattern, "closed": closed}))
`.trim();
      } else if (action === "close_app") {
        script = `
import json, subprocess
app_pattern = ${JSON.stringify(appName)}
result = subprocess.run(['taskkill', '/FI', f'WINDOWTITLE eq *{app_pattern}*', '/F'], capture_output=True, text=True)
print(json.dumps({"action": "close_app", "app": app_pattern, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}))
`.trim();
      } else if (action === "minimize_all") {
        script = `
import json
import pyautogui
pyautogui.hotkey('win', 'd')
import time; time.sleep(0.5)
print(json.dumps({"action": "minimize_all"}))
`.trim();
      } else {
        script = `
import json, time
import uiautomation as auto

app_pattern = ${JSON.stringify(appName)}
root = auto.GetRootControl()
found = False
for win in root.GetChildren():
    try:
        if app_pattern.lower() in (win.Name or '').lower():
            win.SetActive()
            time.sleep(0.3)
            found = True
            print(json.dumps({"action": "focus_app", "app": app_pattern, "window": win.Name, "found": True}))
            break
    except Exception:
        pass
if not found:
    print(json.dumps({"action": "focus_app", "app": app_pattern, "found": False}))
`.trim();
      }

      const res = await lds.execute(
        ldsConnection!.url,
        script,
        { flowId: `reset-state-${action}` },
        ldsAuth(),
      );
      if (!res.success) {
        return text(`Reset failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
      }
      try {
        return ok(JSON.parse(res.stdout));
      } catch {
        return text(res.stdout);
      }
    } catch (e: any) {
      return text(`Reset failed: ${e.message}`);
    }
  },
);

server.tool(
  "batch_test_rpa",
  "Run a workflow multiple times with different inputs and collect results. Useful for testing RPA workflows against a batch of test cases. Returns a summary of pass/fail for each input.",
  {
    workflowId: z.number().describe("Workflow ID to test"),
    testInputs: z.array(z.record(z.string(), z.unknown())).describe("Array of input objects to test with"),
  },
  async ({ workflowId, testInputs }) => {
    const results: Array<{ index: number; input: unknown; status: string; error?: string; executionId?: number; durationMs?: number }> = [];
    for (let i = 0; i < testInputs.length; i++) {
      try {
        const exec = await client.executeWorkflow(workflowId, testInputs[i]);
        const status = exec?.status || (exec?.error ? "FAILED" : "COMPLETED");
        results.push({
          index: i,
          input: testInputs[i],
          status,
          executionId: exec?.executionId,
          error: exec?.error,
        });
      } catch (e: any) {
        results.push({ index: i, input: testInputs[i], status: "ERROR", error: e.message });
      }
    }
    const passed = results.filter(r => r.status === "COMPLETED").length;
    const failed = results.length - passed;
    return ok({
      summary: { total: results.length, passed, failed },
      results,
    });
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BROWSER RPA (session-based)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface BrowserConnection {
  baseUrl: string;
  bearerToken: string;
  slackChannelId?: string;
  sessionId?: string;
}

let browserConnection: BrowserConnection | null = null;

const NOT_CONNECTED_BROWSER = `No browser RPA service connected. Call browser_connect with the service base URL and bearer token first.`;

function requireBrowser() {
  if (!browserConnection) return text(NOT_CONNECTED_BROWSER);
  return null;
}

function requireBrowserSession() {
  const conn = requireBrowser();
  if (conn) return conn;
  if (!browserConnection!.sessionId) return text("No active browser session. Call browser_create_session first.");
  return null;
}

server.tool(
  "browser_connect",
  "Connect to a browser RPA service (e.g. for web-based automation). Store the service URL and auth token for subsequent browser_* calls.",
  {
    baseUrl: z.string().describe("Browser RPA service base URL"),
    bearerToken: z.string().describe("Bearer token for authentication"),
    slackChannelId: z.string().optional().describe("Optional Slack channel ID for notifications"),
  },
  async ({ baseUrl, bearerToken, slackChannelId }) => {
    browserConnection = { baseUrl: baseUrl.replace(/\/+$/, ""), bearerToken, slackChannelId };
    return ok({ connected: true, baseUrl: browserConnection.baseUrl });
  },
);

server.tool(
  "browser_create_session",
  "Create a new browser session. Returns a sessionId used by all subsequent browser actions. Call browser_connect first.",
  {},
  async () => {
    const blocked = requireBrowser();
    if (blocked) return blocked;
    try {
      const res = await fetch(`${browserConnection!.baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${browserConnection!.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          browserConnection!.slackChannelId
            ? { slackChannelId: browserConnection!.slackChannelId }
            : {},
        ),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as { sessionId: string };
      browserConnection!.sessionId = data.sessionId;
      return ok({ sessionId: data.sessionId });
    } catch (e: any) {
      return text(`Failed to create browser session: ${e.message}`);
    }
  },
);

server.tool(
  "browser_act",
  "Send an action to the browser session. Actions are described in natural language (e.g. 'click the login button', 'type hello@example.com into the email field', 'navigate to https://example.com').",
  {
    message: z.string().describe("Natural language action to perform in the browser"),
    sessionId: z.string().optional().describe("Session ID (defaults to the current session from browser_create_session)"),
  },
  async ({ message, sessionId: explicitSessionId }) => {
    const blocked = requireBrowserSession();
    if (blocked && !explicitSessionId) return blocked!;
    const sid = explicitSessionId || browserConnection!.sessionId!;
    try {
      const res = await fetch(`${browserConnection!.baseUrl}/sessions/${sid}/act`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${browserConnection!.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return ok(await res.json());
    } catch (e: any) {
      return text(`Browser action failed: ${e.message}`);
    }
  },
);

server.tool(
  "browser_extract",
  "Extract data from the current browser page. Provide natural language instructions describing what data to extract (e.g. 'extract the patient name and appointment date').",
  {
    instructions: z.string().describe("What data to extract from the current page"),
    sessionId: z.string().optional().describe("Session ID (defaults to the current session)"),
  },
  async ({ instructions, sessionId: explicitSessionId }) => {
    const blocked = requireBrowserSession();
    if (blocked && !explicitSessionId) return blocked!;
    const sid = explicitSessionId || browserConnection!.sessionId!;
    try {
      const res = await fetch(`${browserConnection!.baseUrl}/sessions/${sid}/extract`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${browserConnection!.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ instructions }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return ok(await res.json());
    } catch (e: any) {
      return text(`Browser extraction failed: ${e.message}`);
    }
  },
);

server.tool(
  "browser_screenshot",
  "Get a screenshot of the current browser page.",
  {
    sessionId: z.string().optional().describe("Session ID (defaults to the current session)"),
  },
  async ({ sessionId: explicitSessionId }) => {
    const blocked = requireBrowserSession();
    if (blocked && !explicitSessionId) return blocked!;
    const sid = explicitSessionId || browserConnection!.sessionId!;
    try {
      const res = await fetch(`${browserConnection!.baseUrl}/sessions/${sid}/screenshot`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${browserConnection!.bearerToken}`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as { image?: string; screenshot?: string };
      const imageData = data.image || data.screenshot;
      if (imageData) {
        return {
          content: [
            { type: "image" as const, data: imageData, mimeType: "image/png" as const },
          ],
        };
      }
      return ok(data);
    } catch (e: any) {
      return text(`Browser screenshot failed: ${e.message}`);
    }
  },
);

server.tool(
  "browser_close_session",
  "Close and clean up the current browser session.",
  {
    sessionId: z.string().optional().describe("Session ID to close (defaults to the current session)"),
  },
  async ({ sessionId: explicitSessionId }) => {
    const blocked = requireBrowser();
    if (blocked) return blocked;
    const sid = explicitSessionId || browserConnection?.sessionId;
    if (!sid) return text("No session to close.");
    try {
      const res = await fetch(`${browserConnection!.baseUrl}/sessions/${sid}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${browserConnection!.bearerToken}`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      if (browserConnection && browserConnection.sessionId === sid) {
        browserConnection.sessionId = undefined;
      }
      return ok({ closed: true, sessionId: sid });
    } catch (e: any) {
      return text(`Failed to close browser session: ${e.message}`);
    }
  },
);

server.tool(
  "create_browser_rpa_flow",
  "Create a browser RPA workflow step that wraps a browser session API call in the correct Laminar lam.httpRequest format. Use this for web-based RPA automation.",
  {
    workflowId: z.number().describe("Workflow ID"),
    name: z.string().describe("Step name"),
    description: z.string().describe("What this step does"),
    executionOrder: z.number().describe("Step position in workflow"),
    actionType: z.enum(["create_session", "act", "extract", "close_session"]).describe("What browser action this step performs"),
    actionPayload: z.record(z.string(), z.unknown()).optional().describe("Payload for the action (e.g. {message: 'click login'} for act, {instructions: 'get patient name'} for extract)"),
    sessionIdRef: z.string().optional().describe("Data reference to the session ID from a previous step (e.g. 'data.step_1.response.sessionId')"),
  },
  async ({ workflowId, name, description, executionOrder, actionType, actionPayload, sessionIdRef }) => {
    let program: string;
    const sessionRef = sessionIdRef || "data.step_1.response.sessionId";

    if (actionType === "create_session") {
      program = `(data) => {
    return {
        "lam.httpRequest": {
            "method": "POST",
            "url": "{{config.baseUrl}}/sessions",
            "headers": {
                "Authorization": "Bearer {{config.bearerToken}}"
            },
            "body": {"slackChannelId": "{{config.slackChannelId}}"}
        }
    };
}`;
    } else if (actionType === "act") {
      const msg = (actionPayload as any)?.message || "describe the action";
      program = `(data) => {
    const sessionId = ${sessionRef};
    return {
        "lam.httpRequest": {
            "method": "POST",
            "url": \`{{config.baseUrl}}/sessions/\${sessionId}/act\`,
            "headers": {
                "Authorization": "Bearer {{config.bearerToken}}",
                "Content-Type": "application/json"
            },
            "body": ${JSON.stringify(actionPayload || { message: msg }, null, 12).replace(/^/gm, "            ").trim()}
        }
    };
}`;
    } else if (actionType === "extract") {
      const instr = (actionPayload as any)?.instructions || "extract the data";
      program = `(data) => {
    const sessionId = ${sessionRef};
    return {
        "lam.httpRequest": {
            "method": "POST",
            "url": \`{{config.baseUrl}}/sessions/\${sessionId}/extract\`,
            "headers": {
                "Authorization": "Bearer {{config.bearerToken}}",
                "Content-Type": "application/json"
            },
            "body": ${JSON.stringify(actionPayload || { instructions: instr }, null, 12).replace(/^/gm, "            ").trim()}
        }
    };
}`;
    } else {
      program = `(data) => {
    const sessionId = ${sessionRef};
    return {
        "lam.httpRequest": {
            "method": "DELETE",
            "url": \`{{config.baseUrl}}/sessions/\${sessionId}\`,
            "headers": {
                "Authorization": "Bearer {{config.bearerToken}}"
            }
        }
    };
}`;
    }

    return safe(() =>
      client.createFlow({
        workflowId,
        name,
        description,
        program,
        executionOrder,
        language: "js",
        flowType: "HTTP_REQUEST",
      }),
    );
  },
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PROMPTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.prompt(
  "laminar-workflow-guide",
  "Comprehensive guide for creating and editing Laminar workflows — step types, data access patterns, available libraries, and best practices",
  {},
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Please use this Laminar platform specification when creating or editing workflows:

# Laminar Workflow Specification

## Step Structure
Every step is a JSON object with these fields:
- \`name\`: (string) Descriptive name
- \`description\`: (string) Detailed explanation
- \`program\`: (string) Code to execute (JS or Python)
- \`executionOrder\`: (integer) Position in workflow (starts at 1)
- \`flowType\`: (string) "HTTP_REQUEST", "GENERAL_FUNCTION", "SHELL_SCRIPT", "RPA"
- \`language\`: (string) "js" or "py" (NOTE: RPA flows must ALWAYS use "js")

## Program Signatures
**Python (py):**
\`\`\`python
def transform(data):
    # Your logic here
    return {}
\`\`\`

**JavaScript (js):**
\`\`\`javascript
(data) => {
    // Your code here
    return {};
}
\`\`\`

## Return Values by flowType

### HTTP_REQUEST
\`\`\`json
{
  "lam.httpRequest": {
    "method": "GET|POST|PUT|DELETE|PATCH",
    "url": "String",
    "headers": "Object (optional)",
    "pathParams": "Object (optional)",
    "queryParams": "Object (optional)",
    "body": "Object (optional)",
    "authentication": {
      "type": "basic|bearer|oauth2|apikey",
      "token": "{{config.token}}"
    },
    "retry": { "maxAttempts": "Number" },
    "pagination": {
      "next": { "queryParams": {}, "headers": {}, "body": {} },
      "stopCondition": "JS function receiving ctx",
      "maxPages": 10
    },
    "loopUntil": {
      "condition": "(ctx) => ctx.response.status === 'completed'",
      "maxAttempts": 20,
      "strategy": "exponential",
      "initialDelay": "2s",
      "maxDelay": "60s",
      "multiplier": 2
    }
  }
}
\`\`\`

Multiple requests: use \`"lam.httpRequests"\` (plural) with an array.

### SHELL_SCRIPT
\`\`\`json
{
  "lam.shell": {
    "script": "Bash script as string",
    "environment": {},
    "timeout": 300,
    "binaryDataIds": []
  }
}
\`\`\`

### RPA (Desktop Automation)
**IMPORTANT: Use the \`create_rpa_flow\` tool to save RPA steps.** It accepts your validated Python script and automatically wraps it in the correct JS format. You do NOT need to construct the wrapper yourself.

RPA flows internally use \`language: "js"\` with the Python embedded in a JS arrow function. Two dispatch patterns exist:
- **\`lam.httpRequest\`** (Cloudflare Tunnel — default) — sends the script to the VM via HTTP
- **\`lam.rpa\`** (channelId) — sends via pub/sub channel

The \`create_rpa_flow\` tool handles both patterns via the \`dispatchPattern\` parameter (default: \`cloudflare_tunnel\`).

**NEVER** save raw Python as the program for an RPA flow. **NEVER** manually construct the JS wrapper — use \`create_rpa_flow\`.

### Configuration Updates
\`\`\`json
{
  "lam.updateConfig": {
    "configurationId": "my-config",
    "properties": [{ "key": "k", "value": "v" }],
    "createIfNotExists": true,
    "configurationName": "Auto-generated Config"
  }
}
\`\`\`

### Redis Key-Value Store
\`\`\`json
{
  "lam.kvStore": {
    "operation": "set|get|delete|exists|list|increment|decrement|transaction",
    "key": "user:session:token",
    "value": {},
    "ttl": 3600,
    "redisUrl": "{{config.redisUrl}}"
  }
}
\`\`\`

### Cron Job Management
\`\`\`json
{
  "lam.cron": {
    "operation": "create|update|delete",
    "name": "Daily Report",
    "schedule": "0 0 9 * * *",
    "url": "https://api.laminar.run/workflow/execute/external/{id}?api_key=key",
    "body": {}
  }
}
\`\`\`

### Custom Response (lam.response)
\`\`\`json
{
  "lam.response": {
    "statusCode": 200,
    "message": "Success",
    "data": {},
    "error": { "code": "ERROR_CODE", "message": "Error description" }
  }
}
\`\`\`
Note: Workflow exits immediately when lam.response is encountered.

## Data Access Patterns
- \`data.input\`: Original workflow input
- \`data.step_N.response\`: HTTP request output from step N
- \`data.step_N.data\`: General function output from step N
- \`data.step_N.stdout\`: Shell output from step N
- \`data.step_N.stderr\`: Shell error from step N
- \`data.step_N.cronJobId\`: Cron job ID from step N
- \`data.step_N.response["lam.kvStore.value"]\`: KV store value
- \`data.step_N.response["lam.binaryDataId"]\`: File download reference

## Available Libraries
- **Python:** json, datetime, math, statistics, collections, itertools, functools, re, copy, decimal, csv, io, dataclasses, typing, enum
- **JavaScript:** lodash (as _), date-fns (format, parseISO)

## Security
Use \`{{config.variableName}}\` for sensitive values (API keys, tokens, passwords). These reference configuration store properties.

## Best Practices
1. **Minimize steps** — combine operations when logical, fewer steps = faster execution
2. **Don't JSON.stringify request bodies** — pass objects directly
3. **File downloads** auto-create \`lam.binaryDataId\` — don't process as text
4. **Use {{config.variables}}** for sensitive data, not hardcoded values
5. **Access errors** via \`data.step_N.response.error\` and \`data.step_N.response.statusCode\``,
        },
      },
    ],
  }),
);

server.prompt(
  "debug-workflow-execution",
  "Analyze a failed workflow execution and suggest fixes",
  {
    workflowId: z.string().describe("Workflow ID to debug"),
    executionId: z.string().describe("Failed execution ID"),
  },
  async ({ workflowId, executionId }) => {
    const wId = parseInt(workflowId);
    const eId = parseInt(executionId);
    let executionData: any;
    let flowsData: any;

    try {
      executionData = await client.getExecution(wId, eId);
      flowsData = await client.getWorkflowFlows(wId);
    } catch (e: any) {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Failed to fetch execution data: ${e.message}`,
            },
          },
        ],
      };
    }

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please debug this Laminar workflow execution.

## Workflow Flows (Steps):
${json(flowsData)}

## Execution Details:
${json(executionData)}

Analyze the execution, identify failures, explain root causes, and suggest specific code fixes for the failing steps. Use the Laminar workflow specification (available via the laminar-workflow-guide prompt) for correct syntax.`,
          },
        },
      ],
    };
  },
);

server.prompt(
  "build-rpa-workflow",
  "Iteratively build an RPA workflow on a VM using the Laminar Desktop Service. Guides you through connecting to the VM, researching the target app's UI framework, taking screenshots, inspecting UI elements, writing and testing RPA scripts, and saving each working step as a Laminar workflow flow.",
  {
    workspaceId: z.string().describe("Laminar workspace ID"),
    task: z
      .string()
      .describe(
        "Description of what to automate (e.g. 'Log into Centricity, navigate to Documents, download the latest report')",
      ),
    appName: z
      .string()
      .describe(
        "Name of the application to automate (e.g. 'Centricity', 'SAP GUI', 'Epic Hyperspace')",
      ),
    workflowId: z
      .string()
      .optional()
      .describe(
        "Existing workflow ID to add steps to (omit to create a new workflow)",
      ),
  },
  async ({ workspaceId, task, appName, workflowId }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are building an RPA workflow on the Laminar platform. Your goal is to iteratively create automation steps that run on a VM via the Laminar Desktop Service (LDS).

## Task
${task}

## Target Application
${appName}

## Workspace
ID: ${workspaceId}${workflowId ? `\nExisting workflow ID: ${workflowId} (add steps to this workflow)` : "\nCreate a new workflow for this automation."}

## CRITICAL RULES

### Rule 1 — MANDATORY VALIDATION
**NEVER save a step without first validating it on the VM.** Every RPA script MUST pass this sequence:
1. \`vm_execute_script\` — run on the VM
2. \`vm_screenshot\` — visually confirm it worked
3. Only then → save via \`create_rpa_flow\`

### Rule 2 — USE \`create_rpa_flow\` TO SAVE (NOT \`create_flow\`)
When saving an RPA step, call **\`create_rpa_flow\`** — it automatically wraps your Python script in the correct Laminar JS format. You only pass the Python script; the tool handles the \`lam.httpRequest\` / \`lam.rpa\` wrapper.

**NEVER** call \`create_flow\` with raw Python for an RPA step. **NEVER** try to construct the JS wrapper yourself.

### Rule 3 — COMBINE ui_inspect + screenshots + clipboard
Screenshots alone are unreliable for reading data (resolution issues, misreads). ALWAYS combine multiple methods. See the Data Extraction Strategy section below.

## Procedure

### 1. Connect to the VM
If no VM is connected, ask for the **Cloudflare Tunnel URL** and call \`vm_connect\`.

### 2. Research the Target Application
Based on "${appName}", pick the UI automation framework:
- **.NET / WPF / WinForms** → \`uiautomation\` (default) or \`pywinauto\`
- **Java / Swing** → \`jab\` (Java Access Bridge)
- **Electron / web-based desktop** → \`pywinauto\` or pyautogui
- **Legacy Win32** → \`uiautomation\`

Start with \`uiautomation\` if unsure.

### 3. Initial Survey (ALWAYS do this first)
Before writing any automation:
1. \`vm_screenshot\` — see the desktop state
2. \`vm_inspect_ui\` mode \`screen_info\` — get resolution
3. \`vm_inspect_ui\` mode \`window_list\` — list windows
4. Verify the target app is running

### 4. Iterative Build Loop — For EACH step:

**a. OBSERVE — Understand the current state (REQUIRED)**
- \`vm_screenshot\` to see the screen
- \`vm_inspect_ui\` with \`element_tree\` to map UI elements
- \`vm_inspect_ui\` with \`element_at_point\` for specific elements

**b. WRITE — Create the Python RPA script**
- Use the appropriate framework (pyautogui for mouse/keyboard, uiautomation/pywinauto for element-based)
- Include error handling and waits
- Explain what it does before executing

**c. VALIDATE — Test on the VM (REQUIRED)**
- \`vm_execute_script\` — run the script
- Or use \`debug_rpa_step\` for full before/after screenshots + diagnostics
- Fix and re-run if errors occur

**d. VERIFY — Confirm visually (REQUIRED)**
- \`vm_screenshot\` immediately after
- If result is wrong, go back to (b)

**e. SAVE — Call \`create_rpa_flow\` (only after c + d pass)**
- Pass the validated Python script, step name, description, flowId, and executionOrder
- The tool handles all JS wrapping automatically
- Default dispatch: \`cloudflare_tunnel\` (uses \`lam.httpRequest\`)

### 5. End-to-End Validation
After all steps are built:
- \`execute_workflow\` to run the full sequence
- \`vm_screenshot\` to verify final state
- \`diagnose_execution\` if anything fails

### 6. Iterate with the User
- Present completed workflow summary
- Make adjustments, re-validate changed steps

## Data Extraction Strategy

When you need to READ data from the screen (not just click/type), follow this priority order. **Do NOT rely solely on screenshots for data reading.**

### Priority 1: Accessibility Tree (most reliable)
- \`vm_inspect_ui\` with \`element_tree\` on the target window
- If the tree exposes text values, this is the most reliable method
- Use \`element_at_point\` for specific fields
- Use \`focused_element\` to read the current field

### Priority 2: Open Accessible Dialogs
- Many apps expose more data when you open edit/detail dialogs
- Double-click on a row or click "Edit" to open a modal — the modal often has better accessibility support
- Then use \`element_tree\` on the modal

### Priority 3: Clipboard Extraction
- Use \`vm_execute_script\` to click a field, then Ctrl+A, Ctrl+C
- Call \`vm_read_clipboard\` to get the copied text
- Works for individual fields, text areas, and some grid cells

### Priority 4: Keyboard Navigation
- Tab through fields, reading each via \`vm_inspect_ui\` \`focused_element\`
- Useful when the accessibility tree returns element structure but not values

### Priority 5: Zoomed Screenshot
- Use \`vm_screenshot_region\` to crop a specific area for better resolution
- Only for small text that can't be accessed any other way

### Priority 6: Alternative Application Paths
- Think creatively! Look for:
  - Reports or Print menus that export data
  - List/Search views with better accessibility
  - CLI tools or command-line interfaces the app provides
  - Export to CSV/clipboard options
  - Alternative windows/dialogs that show the same data more accessibly
- Use \`vm_execute_script\` to run Python code that queries the app's data directly if a CLI or API exists

### Priority 7: Full Screenshot (VERIFICATION ONLY)
- Full desktop screenshots are for **verifying actions worked**, NOT for reading data
- If you must use a screenshot to read data, acknowledge it's unreliable and suggest a better approach to the user

## Debugging Tools

- **\`debug_rpa_step\`** — runs a script with before/after screenshots and full diagnostics (stdout, stderr, exit code). Use during development.
- **\`vm_reset_state\`** — Smart Launch: close dialogs, reset app to known state. Use before testing.
- **\`vm_read_clipboard\`** — read clipboard after a copy operation.
- **\`vm_screenshot_region\`** — crop/zoom a region for better text reading.
- **\`batch_test_rpa\`** — run the workflow with multiple test inputs.

## Important Rules
- **VALIDATE BEFORE SAVING** — no exceptions unless user explicitly opts out
- **Use \`create_rpa_flow\`** — never construct JS wrappers manually
- **Use \`{{config.variables}}\` for secrets** — never hardcode credentials
- **Combine extraction methods** — accessibility tree + clipboard + screenshots
- **Start simple** — get basic automation working before adding sophistication
- **Add waits** — use \`time.sleep()\` or element-wait patterns between actions
- **Handle errors** — try/except with meaningful messages
- **Keep scripts focused** — one logical action per step`,
        },
      },
    ],
  }),
);

server.prompt(
  "build-browser-rpa-workflow",
  "Iteratively build a browser-based RPA workflow using the Laminar Browser RPA service. Guides you through creating a browser session, performing actions, extracting data, and saving each step as a Laminar workflow flow.",
  {
    workspaceId: z.string().describe("Laminar workspace ID"),
    task: z
      .string()
      .describe(
        "Description of what to automate (e.g. 'Log into athenaHealth, navigate to patient chart, extract insurance info')",
      ),
    targetUrl: z
      .string()
      .describe("Starting URL for the web application"),
    workflowId: z
      .string()
      .optional()
      .describe("Existing workflow ID to add steps to (omit to create a new workflow)"),
  },
  async ({ workspaceId, task, targetUrl, workflowId }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are building a browser-based RPA workflow on the Laminar platform. Your goal is to automate web application interactions using the Browser RPA session API.

## Task
${task}

## Target URL
${targetUrl}

## Workspace
ID: ${workspaceId}${workflowId ? `\nExisting workflow ID: ${workflowId} (add steps to this workflow)` : "\nCreate a new workflow for this automation."}

## How Browser RPA Works

The Browser RPA service provides a session-based API:
1. **Create Session** — starts a browser instance, returns a sessionId
2. **Act** — sends natural-language actions (e.g. "click the login button", "type hello@example.com in the email field")
3. **Extract** — extracts data from the current page via natural-language instructions
4. **Screenshot** — captures the current browser state
5. **Close Session** — cleans up

## Procedure

### 1. Connect to Browser RPA Service
Call \`browser_connect\` with the service base URL and bearer token. Ask the user if not known.

### 2. Create a Browser Session
Call \`browser_create_session\` to get a sessionId.

### 3. Iterative Build Loop — For EACH step:

**a. ACT — Perform the browser action**
- Call \`browser_act\` with a natural-language description of what to do
- Be specific: "navigate to ${targetUrl}", "click the Submit button", "type 'john@example.com' into the email input field"

**b. VERIFY — Confirm the action worked**
- Call \`browser_screenshot\` to see the current state
- If the action didn't produce the expected result, retry with a more specific instruction

**c. EXTRACT — Get data if needed**
- Call \`browser_extract\` with instructions like "extract the patient name and date of birth"
- This returns structured data from the page

**d. SAVE — Persist as a workflow step**
- Call \`create_browser_rpa_flow\` with the action type and payload
- For the first step, use actionType "create_session"
- For navigation/interaction steps, use actionType "act"
- For data extraction steps, use actionType "extract"
- For cleanup, use actionType "close_session"

### 4. End-to-End Validation
- Run the full workflow via \`execute_workflow\`
- Verify the final state

### 5. Iterate with the User
- Present the completed workflow
- Make adjustments as needed

## Important Rules
- **Always verify actions with screenshots** before saving
- **Use \`create_browser_rpa_flow\`** to save steps — it generates the correct \`lam.httpRequest\` wrapper
- **Use \`{{config.variables}}\`** for credentials (bearerToken, baseUrl, etc.)
- **Be specific in actions** — natural language should be unambiguous
- **Handle 2FA/MFA** — if login requires verification codes, use waitForInput patterns
- **One action per step** — keep steps focused and debuggable`,
        },
      },
    ],
  }),
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  const { auth, baseUrl } = await resolveAuth();
  client = new LaminarClient(auth, baseUrl);
  scheduleTokenRefresh();

  // Initialize optional services
  const svcConfig = loadServiceConfig();

  if (svcConfig.elasticsearch) {
    esService = new ElasticsearchService(svcConfig.elasticsearch);
    console.error("Elasticsearch: configured");
  } else {
    console.error("Elasticsearch: not configured (log search disabled)");
  }

  if (svcConfig.cron) {
    cronService = new CronService(svcConfig.cron);
    console.error("CRON service: configured");
  } else {
    console.error("CRON service: not configured (scheduling disabled)");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Laminar MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
