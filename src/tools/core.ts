import { z } from "zod";
import { ok, text, safe } from "../helpers.js";
import type { ToolDeps } from "../types.js";

export function register(deps: ToolDeps) {
  const { server } = deps;

  // ── Auth / User ──────────────────────────────────────────────

  server.tool(
    "get_current_user",
    "Get the current authenticated user info",
    {},
    async () => safe(() => deps.client().getMe()),
  );

  // ── Workspaces ───────────────────────────────────────────────

  server.tool(
    "list_workspaces",
    "List all workspaces the user has access to",
    {},
    async () => safe(() => deps.client().listWorkspaces()),
  );

  server.tool(
    "get_workspace",
    "Get workspace details by ID",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().getWorkspace(workspaceId)),
  );

  server.tool(
    "get_workspace_users",
    "List all users in a workspace",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().getWorkspaceUsers(workspaceId)),
  );

  // ── Workflows ────────────────────────────────────────────────

  server.tool(
    "list_workflows",
    "List all workflows in a workspace",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().listWorkflows(workspaceId)),
  );

  server.tool(
    "list_archived_workflows",
    "List archived workflows in a workspace",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().listArchivedWorkflows(workspaceId)),
  );

  server.tool(
    "get_workflow",
    "Get workflow details including name, description, created date",
    { workflowId: z.number().describe("Workflow ID") },
    async ({ workflowId }) =>
      safe(() => deps.client().getWorkflow(workflowId)),
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
      safe(() =>
        deps.client().createWorkflow({ workspaceId, name, description }),
      ),
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
      safe(() =>
        deps.client().updateWorkflow({ workflowId, name, description }),
      ),
  );

  server.tool(
    "delete_workflow",
    "Delete (archive) a workflow",
    { workflowId: z.number().describe("Workflow ID") },
    async ({ workflowId }) =>
      safe(() => deps.client().deleteWorkflow(workflowId)),
  );

  server.tool(
    "restore_workflow",
    "Restore a previously deleted/archived workflow",
    { workflowId: z.number().describe("Workflow ID") },
    async ({ workflowId }) =>
      safe(() => deps.client().restoreWorkflow(workflowId)),
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
      safe(() =>
        deps.client().cloneWorkflow(workflowId, { name, workspaceId }),
      ),
  );

  // ── Flows (Steps) ──────────────────────────────────────────

  server.tool(
    "list_workflow_flows",
    "List all flows/steps in a workflow, including their code",
    { workflowId: z.number().describe("Workflow ID") },
    async ({ workflowId }) =>
      safe(() => deps.client().getWorkflowFlows(workflowId)),
  );

  server.tool(
    "get_flow",
    "Get a single flow/step details",
    { flowId: z.number().describe("Flow ID") },
    async ({ flowId }) => safe(() => deps.client().getFlow(flowId)),
  );

  server.tool(
    "read_flow",
    "Read the program code of a flow/step",
    { flowId: z.number().describe("Flow ID") },
    async ({ flowId }) => safe(() => deps.client().readFlow(flowId)),
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
      return safe(() => deps.client().createFlow(args));
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
      safe(() => deps.client().createOrUpdateFlows(workflowId, flows)),
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
    async (args) => safe(() => deps.client().updateFlow(args)),
  );

  server.tool(
    "delete_flow",
    "Delete a flow/step from a workflow",
    { flowId: z.number().describe("Flow ID") },
    async ({ flowId }) => safe(() => deps.client().deleteFlow(flowId)),
  );

  server.tool(
    "get_flow_versions",
    "Get version history of a flow/step",
    { flowId: z.number().describe("Flow ID") },
    async ({ flowId }) => safe(() => deps.client().getFlowVersions(flowId)),
  );

  server.tool(
    "read_flow_version",
    "Read a specific historical version of a flow's code",
    {
      flowId: z.number().describe("Flow ID"),
      versionId: z.number().describe("Version ID"),
    },
    async ({ flowId, versionId }) =>
      safe(() => deps.client().readFlowVersion(flowId, versionId)),
  );

  // ── Executions ─────────────────────────────────────────────

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
        .describe(
          "Filter: SUCCESS, FAILED, RUNNING, PENDING, SKIPPED, UNKNOWN",
        ),
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
      safe(() => deps.client().listExecutions(workflowId, params)),
  );

  server.tool(
    "get_execution",
    "Get full details of a specific workflow execution including all flow run results",
    {
      workflowId: z.number().describe("Workflow ID"),
      executionId: z.number().describe("Execution ID"),
    },
    async ({ workflowId, executionId }) =>
      safe(() => deps.client().getExecution(workflowId, executionId)),
  );

  server.tool(
    "get_execution_status",
    "Quick lightweight check of execution status (for polling async executions)",
    {
      workflowId: z.number().describe("Workflow ID"),
      executionId: z.number().describe("Execution ID"),
    },
    async ({ workflowId, executionId }) =>
      safe(() => deps.client().getExecutionStatus(workflowId, executionId)),
  );

  server.tool(
    "get_execution_result",
    "Get only the final result of an execution (last step output)",
    {
      workflowId: z.number().describe("Workflow ID"),
      executionId: z.number().describe("Execution ID"),
    },
    async ({ workflowId, executionId }) =>
      safe(() => deps.client().getExecutionResult(workflowId, executionId)),
  );

  server.tool(
    "get_full_execution",
    "Get the complete untruncated execution data (large payloads)",
    {
      workflowId: z.number().describe("Workflow ID"),
      executionId: z.number().describe("Execution ID"),
    },
    async ({ workflowId, executionId }) =>
      safe(() => deps.client().getFullExecution(workflowId, executionId)),
  );

  server.tool(
    "get_global_workflow_object",
    "Get the global workflow object (shared state) for an execution",
    {
      workflowId: z.number().describe("Workflow ID"),
      executionId: z.number().describe("Execution ID"),
    },
    async ({ workflowId, executionId }) =>
      safe(() =>
        deps.client().getGlobalWorkflowObject(workflowId, executionId),
      ),
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
        deps.client().getFlowRunResponse(workflowId, executionId, flowRunId),
      ),
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
        deps
          .client()
          .getFlowRunTransformation(workflowId, executionId, flowRunId),
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
      safe(() =>
        deps.client().getFlowRunProgram(workflowId, executionId, flowRunId),
      ),
  );

  // ── Execute ────────────────────────────────────────────────

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
        deps.client().executeWorkflow(workflowId, body, {
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
        deps.client().executeWorkflowAsync(workflowId, body, {
          configuration_id: configurationId,
          start_from_step: startFromStep,
          end_at_step: endAtStep,
        }),
      ),
  );

  // ── Conversations ──────────────────────────────────────────

  server.tool(
    "list_conversations",
    "List all AI conversations for a workflow",
    { workflowId: z.number().describe("Workflow ID") },
    async ({ workflowId }) =>
      safe(() => deps.client().listConversations(workflowId)),
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
        deps.client().getConversationMessages(workflowId, conversationId),
      ),
  );
}
