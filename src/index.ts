#!/usr/bin/env node

/**
 * Laminar MCP Server
 *
 * Brings your Laminar workspace into Cursor / Claude Code.
 * Supports reading executions, searching them, editing workflows,
 * managing configurations, and more.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LaminarClient, type LaminarAuth } from "./laminar-client.js";

const TOKEN_PATH = path.join(os.homedir(), ".laminar", "tokens.json");
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // epoch ms
  api_base?: string;
}

function getApiBase(): string {
  const stored = readStoredTokens();
  return stored?.api_base || process.env.LAMINAR_API_BASE || "https://api.laminar.run";
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
  refreshToken: string
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

  // Still fresh
  if (Date.now() < tokens.expires_at - REFRESH_BUFFER_MS) {
    return tokens.access_token;
  }

  // Try refresh
  if (tokens.refresh_token) {
    console.error("Refreshing Laminar access token...");
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    if (refreshed) {
      writeStoredTokens(refreshed);
      console.error("Token refreshed.");
      return refreshed.access_token;
    }
  }

  // Expired and can't refresh — use what we have (will fail at API level)
  console.error(
    "Warning: Token expired and refresh failed. Run `npm run setup` to re-authenticate."
  );
  return tokens.access_token;
}

// ─── Resolve auth ────────────────────────────────────────────
// Priority: LAMINAR_API_KEY > env token > stored tokens from setup
async function resolveAuth(): Promise<{ auth: LaminarAuth; baseUrl: string }> {
  const apiKey = process.env.LAMINAR_API_KEY;
  const accessToken = process.env.LAMINAR_ACCESS_TOKEN;
  const baseUrl = getApiBase();

  if (apiKey) return { auth: { type: "apiKey", token: apiKey }, baseUrl };
  if (accessToken) return { auth: { type: "bearer", token: accessToken }, baseUrl };

  // Try stored tokens from `npm run setup`
  const stored = readStoredTokens();
  if (stored) {
    const token = await getValidToken();
    return { auth: { type: "bearer", token }, baseUrl };
  }

  console.error(
    "No auth found. Run `npm run setup` to sign in, or set LAMINAR_API_KEY."
  );
  process.exit(1);
}

let client: LaminarClient;

// Auto-refresh timer
function scheduleTokenRefresh() {
  const tokens = readStoredTokens();
  if (!tokens?.refresh_token) return;

  const msUntilRefresh = Math.max(
    tokens.expires_at - REFRESH_BUFFER_MS - Date.now(),
    60_000
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

// ─── Server ──────────────────────────────────────────────────
const server = new McpServer({
  name: "laminar",
  version: "1.0.0",
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TOOLS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Auth / User ──────────────────────────────────────────────

server.tool("get_current_user", "Get the current authenticated user info", {}, async () =>
  safe(() => client.getMe())
);

// ── Workspaces ───────────────────────────────────────────────

server.tool(
  "list_workspaces",
  "List all workspaces the user has access to",
  {},
  async () => safe(() => client.listWorkspaces())
);

server.tool(
  "get_workspace",
  "Get workspace details by ID",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.getWorkspace(workspaceId))
);

server.tool(
  "get_workspace_users",
  "List all users in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) =>
    safe(() => client.getWorkspaceUsers(workspaceId))
);

// ── Workflows ────────────────────────────────────────────────

server.tool(
  "list_workflows",
  "List all workflows in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) =>
    safe(() => client.listWorkflows(workspaceId))
);

server.tool(
  "list_archived_workflows",
  "List archived workflows in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) =>
    safe(() => client.listArchivedWorkflows(workspaceId))
);

server.tool(
  "get_workflow",
  "Get workflow details including name, description, created date",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.getWorkflow(workflowId))
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
    safe(() => client.createWorkflow({ workspaceId, name, description }))
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
    safe(() => client.updateWorkflow({ workflowId, name, description }))
);

server.tool(
  "delete_workflow",
  "Delete (archive) a workflow",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) => safe(() => client.deleteWorkflow(workflowId))
);

server.tool(
  "restore_workflow",
  "Restore a previously deleted/archived workflow",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) =>
    safe(() => client.restoreWorkflow(workflowId))
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
    safe(() => client.cloneWorkflow(workflowId, { name, workspaceId }))
);

// ── Flows (Steps) ────────────────────────────────────────────

server.tool(
  "list_workflow_flows",
  "List all flows/steps in a workflow, including their code",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) =>
    safe(() => client.getWorkflowFlows(workflowId))
);

server.tool(
  "get_flow",
  "Get a single flow/step details",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.getFlow(flowId))
);

server.tool(
  "read_flow",
  "Read the program code of a flow/step",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.readFlow(flowId))
);

server.tool(
  "create_flow",
  "Create a new flow/step in a workflow. flowType: HTTP_REQUEST, GENERAL_FUNCTION, SHELL_SCRIPT, or RPA. language: js or py.",
  {
    workflowId: z.number().describe("Workflow ID"),
    name: z.string().describe("Step name"),
    description: z.string().describe("Step description"),
    program: z
      .string()
      .describe(
        'Program code. JS: (data) => { ... }  Python: def transform(data): ...'
      ),
    executionOrder: z.number().describe("Step position (starts at 1)"),
    language: z.enum(["js", "py"]).describe("Programming language"),
    flowType: z
      .enum(["HTTP_REQUEST", "GENERAL_FUNCTION", "SHELL_SCRIPT", "RPA"])
      .describe("Flow type"),
  },
  async (args) => safe(() => client.createFlow(args))
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
        })
      )
      .describe("Array of flow objects"),
  },
  async ({ workflowId, flows }) =>
    safe(() => client.createOrUpdateFlows(workflowId, flows))
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
  async (args) => safe(() => client.updateFlow(args))
);

server.tool(
  "delete_flow",
  "Delete a flow/step from a workflow",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.deleteFlow(flowId))
);

server.tool(
  "get_flow_versions",
  "Get version history of a flow/step",
  { flowId: z.number().describe("Flow ID") },
  async ({ flowId }) => safe(() => client.getFlowVersions(flowId))
);

server.tool(
  "read_flow_version",
  "Read a specific historical version of a flow's code",
  {
    flowId: z.number().describe("Flow ID"),
    versionId: z.number().describe("Version ID"),
  },
  async ({ flowId, versionId }) =>
    safe(() => client.readFlowVersion(flowId, versionId))
);

// ── Executions ───────────────────────────────────────────────

server.tool(
  "list_executions",
  "List and search workflow executions with optional filters (date range, status, search text). Paginated.",
  {
    workflowId: z.number().describe("Workflow ID"),
    page: z.number().optional().describe("Page number (0-based, default 0)"),
    size: z.number().optional().describe("Page size (default 20)"),
    startDate: z
      .string()
      .optional()
      .describe("Filter: start date (ISO 8601)"),
    endDate: z
      .string()
      .optional()
      .describe("Filter: end date (ISO 8601)"),
    search: z.string().optional().describe("Search text"),
    status: z
      .string()
      .optional()
      .describe("Filter: SUCCESS, FAILED, RUNNING, PENDING, SKIPPED, UNKNOWN"),
    configurationId: z
      .number()
      .optional()
      .describe("Filter by configuration store ID"),
    sortDirection: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort direction (default desc)"),
  },
  async ({ workflowId, ...params }) =>
    safe(() => client.listExecutions(workflowId, params))
);

server.tool(
  "get_execution",
  "Get full details of a specific workflow execution including all flow run results",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getExecution(workflowId, executionId))
);

server.tool(
  "get_execution_status",
  "Quick lightweight check of execution status (for polling async executions)",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getExecutionStatus(workflowId, executionId))
);

server.tool(
  "get_execution_result",
  "Get only the final result of an execution (last step output)",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getExecutionResult(workflowId, executionId))
);

server.tool(
  "get_full_execution",
  "Get the complete untruncated execution data (large payloads)",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getFullExecution(workflowId, executionId))
);

server.tool(
  "get_global_workflow_object",
  "Get the global workflow object (shared state) for an execution",
  {
    workflowId: z.number().describe("Workflow ID"),
    executionId: z.number().describe("Execution ID"),
  },
  async ({ workflowId, executionId }) =>
    safe(() => client.getGlobalWorkflowObject(workflowId, executionId))
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
    safe(() =>
      client.getFlowRunResponse(workflowId, executionId, flowRunId)
    )
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
      client.getFlowRunTransformation(workflowId, executionId, flowRunId)
    )
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
    safe(() =>
      client.getFlowRunProgram(workflowId, executionId, flowRunId)
    )
);

// ── Execute ──────────────────────────────────────────────────

server.tool(
  "execute_workflow",
  "Execute a workflow synchronously and return the result. Pass input data as the body.",
  {
    workflowId: z.number().describe("Workflow ID"),
    body: z.any().optional().describe("Input data for the workflow (JSON)"),
    configurationId: z
      .number()
      .optional()
      .describe("Configuration store ID to use"),
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
      })
    )
);

server.tool(
  "execute_workflow_async",
  "Trigger an async workflow execution. Returns an execution ID for polling.",
  {
    workflowId: z.number().describe("Workflow ID"),
    body: z.any().optional().describe("Input data for the workflow (JSON)"),
    configurationId: z
      .number()
      .optional()
      .describe("Configuration store ID to use"),
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
      })
    )
);

// ── Conversations ────────────────────────────────────────────

server.tool(
  "list_conversations",
  "List all AI conversations for a workflow",
  { workflowId: z.number().describe("Workflow ID") },
  async ({ workflowId }) =>
    safe(() => client.listConversations(workflowId))
);

server.tool(
  "get_conversation_messages",
  "Get all messages from a specific workflow conversation",
  {
    workflowId: z.number().describe("Workflow ID"),
    conversationId: z.number().describe("Conversation ID"),
  },
  async ({ workflowId, conversationId }) =>
    safe(() =>
      client.getConversationMessages(workflowId, conversationId)
    )
);

// ── Configuration Stores ─────────────────────────────────────

server.tool(
  "list_config_stores",
  "List all configuration stores in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) =>
    safe(() => client.listConfigStores(workspaceId))
);

server.tool(
  "get_config_store",
  "Get a configuration store by its external ID",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.getConfigStore(externalId, workspaceId))
);

server.tool(
  "get_config_properties",
  "Get all properties (key-value pairs) from a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.getConfigProperties(externalId, workspaceId))
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
    safe(() => client.getConfigProperty(externalId, key, workspaceId))
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
      client.updateConfigProperty(externalId, workspaceId, { key, value })
    )
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
    safe(() =>
      client.removeConfigProperty(externalId, key, workspaceId)
    )
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
        })
      )
      .describe("Initial properties"),
  },
  async (args) => safe(() => client.createConfigStore(args))
);

server.tool(
  "delete_config_store",
  "Delete (archive) a configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.deleteConfigStore(externalId, workspaceId))
);

server.tool(
  "restore_config_store",
  "Restore a previously archived configuration store",
  {
    externalId: z.string().describe("Configuration store external ID"),
    workspaceId: z.number().describe("Workspace ID"),
  },
  async ({ externalId, workspaceId }) =>
    safe(() => client.restoreConfigStore(externalId, workspaceId))
);

// ── Issues ───────────────────────────────────────────────────

server.tool(
  "list_issues",
  "List all issues in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.listIssues(workspaceId))
);

server.tool(
  "get_issue",
  "Get issue details",
  {
    workspaceId: z.number().describe("Workspace ID"),
    issueId: z.number().describe("Issue ID"),
  },
  async ({ workspaceId, issueId }) =>
    safe(() => client.getIssue(workspaceId, issueId))
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
      })
    )
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
    safe(() => client.updateIssue(workspaceId, issueId, data))
);

server.tool(
  "delete_issue",
  "Delete an issue",
  {
    workspaceId: z.number().describe("Workspace ID"),
    issueId: z.number().describe("Issue ID"),
  },
  async ({ workspaceId, issueId }) =>
    safe(() => client.deleteIssue(workspaceId, issueId))
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
    safe(() => client.getFlowStats(workspaceId, days))
);

server.tool(
  "get_recent_flow_runs",
  "Get recent flow runs across all workflows in a workspace",
  {
    workspaceId: z.number().describe("Workspace ID"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ workspaceId, limit }) =>
    safe(() => client.getRecentFlowRuns(workspaceId, limit))
);

server.tool(
  "list_api_keys",
  "List API keys in a workspace",
  { workspaceId: z.number().describe("Workspace ID") },
  async ({ workspaceId }) => safe(() => client.listApiKeys(workspaceId))
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
  })
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
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  const { auth, baseUrl } = await resolveAuth();
  client = new LaminarClient(auth, baseUrl);
  scheduleTokenRefresh();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Laminar MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
