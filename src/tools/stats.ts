import { z } from "zod";
import { safe } from "../helpers.js";
import type { ToolDeps } from "../types.js";

export function register(deps: ToolDeps) {
  const { server } = deps;

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
      safe(() => deps.client().getFlowStats(workspaceId, days)),
  );

  server.tool(
    "get_recent_flow_runs",
    "Get recent flow runs across all workflows in a workspace",
    {
      workspaceId: z.number().describe("Workspace ID"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ workspaceId, limit }) =>
      safe(() => deps.client().getRecentFlowRuns(workspaceId, limit)),
  );

  server.tool(
    "list_api_keys",
    "List API keys in a workspace",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().listApiKeys(workspaceId)),
  );
}
