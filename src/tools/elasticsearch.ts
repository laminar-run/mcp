import { z } from "zod";
import { ok, text, NOT_CONFIGURED_ES } from "../helpers.js";
import type { ToolDeps } from "../types.js";

function requireES(deps: ToolDeps) {
  if (!deps.esService()) return text(NOT_CONFIGURED_ES);
  return null;
}

export function register(deps: ToolDeps) {
  const { server } = deps;

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
      const blocked = requireES(deps);
      if (blocked) return blocked;
      try {
        const results = await deps.esService()!.search(params);
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
      startDate: z
        .string()
        .optional()
        .describe("Start of time range (ISO 8601)"),
      endDate: z
        .string()
        .optional()
        .describe("End of time range (ISO 8601)"),
      status: z
        .string()
        .optional()
        .describe("Filter by status (e.g., FAILED)"),
      size: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ workspaceId, query, workflowIds, startDate, endDate, status, size }) => {
      const blocked = requireES(deps);
      if (blocked) return blocked;
      try {
        const results = await deps.esService()!.search({
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
        .describe(
          "Search terms to correlate (order IDs, error messages, etc.)",
        ),
      status: z
        .string()
        .optional()
        .describe("Filter status (default: FAILED)"),
    },
    async ({ workspaceId, workflowIds, startDate, endDate, keywords, status }) => {
      try {
        const filterStatus = status || "FAILED";
        const es = deps.esService();

        if (es && keywords?.length) {
          const searchPromises = keywords.map((kw) =>
            es.search({
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

        // API-based fallback
        const client = deps.client();
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
}
