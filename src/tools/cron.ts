import { z } from "zod";
import { ok, text, safe, NOT_CONFIGURED_CRON } from "../helpers.js";
import type { ToolDeps } from "../types.js";

function requireCron(deps: ToolDeps) {
  if (!deps.cronService()) return text(NOT_CONFIGURED_CRON);
  return null;
}

export function register(deps: ToolDeps) {
  const { server } = deps;

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
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      return safe(() => deps.cronService()!.listJobs(workflowId));
    },
  );

  server.tool(
    "get_cron_job",
    "Get details of a specific CRON job",
    { jobId: z.string().describe("CRON job ID") },
    async ({ jobId }) => {
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      return safe(() => deps.cronService()!.getJob(jobId));
    },
  );

  server.tool(
    "create_cron_job",
    "Create a new CRON job to run a workflow on a schedule",
    {
      name: z.string().describe("Job name"),
      schedule: z
        .string()
        .describe(
          "CRON expression (e.g., '0 */30 * * * *' for every 30 min)",
        ),
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
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      return safe(() =>
        deps.cronService()!.createJob({
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
      body: z
        .record(z.string(), z.any())
        .optional()
        .describe("New JSON body"),
      enabled: z.boolean().optional().describe("Enable or disable"),
    },
    async ({ jobId, ...updates }) => {
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      return safe(() => deps.cronService()!.updateJob(jobId, updates));
    },
  );

  server.tool(
    "toggle_cron_job",
    "Toggle a CRON job on/off",
    { jobId: z.string().describe("CRON job ID") },
    async ({ jobId }) => {
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      return safe(() => deps.cronService()!.toggleJob(jobId));
    },
  );

  server.tool(
    "trigger_cron_job",
    "Manually trigger a CRON job right now (runs it once immediately)",
    { jobId: z.string().describe("CRON job ID") },
    async ({ jobId }) => {
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      try {
        await deps.cronService()!.triggerJob(jobId);
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
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      try {
        await deps.cronService()!.deleteJob(jobId);
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
        .describe(
          "CRON schedule (default: every 30 min — '0 */30 * * * *')",
        ),
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
      const blocked = requireCron(deps);
      if (blocked) return blocked;
      try {
        const exec = await deps
          .client()
          .getExecution(workflowId, executionId);
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

        const job = await deps.cronService()!.createJob({
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
}
