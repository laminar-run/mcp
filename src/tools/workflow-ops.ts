import { z } from "zod";
import { ok, text } from "../helpers.js";
import { computeDiff } from "../diff.js";
import type { ToolDeps } from "../types.js";

export function register(deps: ToolDeps) {
  const { server } = deps;

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
        const flow = await deps.client().getFlow(flowId);
        const currentCode = await deps.client().readFlow(flowId);
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
          deps.client().getWorkflow(workflowId),
          deps.client().getWorkflowFlows(workflowId),
          deps.client().listExecutions(workflowId, { size: includeExecutions }),
        ]);

        const flowList = Array.isArray(flows) ? flows : [];

        const flowsWithCode = await Promise.all(
          flowList.map(async (f: any) => {
            try {
              const code = await deps.client().readFlow(f.id);
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
          recentExecutions: executions,
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
        const exec = await deps.client().getExecution(workflowId, executionId);
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

        const result = await deps
          .client()
          .executeWorkflow(workflowId, body, params);
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
            ? deps.client().readFlowVersion(flowId, versionA)
            : deps.client().readFlow(flowId),
          deps.client().readFlowVersion(flowId, versionB),
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
        const exec = await deps
          .client()
          .getExecution(workflowId, executionId);
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
              p.executionOrder === r.executionOrder - 1 &&
              p.status === "SUCCESS",
          );

          const errorStr = JSON.stringify(r.executionLog || r.response || "");
          const programStr = JSON.stringify(r.program || "");
          const isRpa =
            programStr.includes("lam.rpa") ||
            programStr.includes("lam.httpRequest") ||
            programStr.includes("pyautogui") ||
            programStr.includes("uiautomation");

          let rpaAnalysis: { pattern: string; suggestion: string } | null =
            null;
          if (isRpa) {
            if (
              errorStr.includes("ElementNotFound") ||
              errorStr.includes("not found") ||
              errorStr.includes("Exists") ||
              errorStr.includes("WindowControl")
            ) {
              rpaAnalysis = {
                pattern: "element_not_found",
                suggestion:
                  "The target UI element was not found. Possible causes: (1) the app hasn't fully loaded — add time.sleep() before the interaction, (2) the window title changed — use vm_inspect_ui window_list to check current titles, (3) the element's AutomationId or coordinates shifted — re-inspect with element_tree.",
              };
            } else if (
              errorStr.includes("timeout") ||
              errorStr.includes("Timeout") ||
              errorStr.includes("timed out")
            ) {
              rpaAnalysis = {
                pattern: "timeout",
                suggestion:
                  "The script timed out waiting for an element or action. Increase sleep/wait times, or add a retry loop that checks for the element before acting.",
              };
            } else if (
              errorStr.includes("click") ||
              errorStr.includes("position") ||
              errorStr.includes("coordinate")
            ) {
              rpaAnalysis = {
                pattern: "click_target_missed",
                suggestion:
                  'A click may have hit the wrong location. Screen resolution or window position may have changed. Use vm_inspect_ui element_at_point to verify coordinates, or switch to element-based interaction (AutomationId) instead of pixel coordinates.',
              };
            } else if (
              errorStr.includes("connection") ||
              errorStr.includes("Connection") ||
              errorStr.includes("ECONNREFUSED")
            ) {
              rpaAnalysis = {
                pattern: "lds_connection_failed",
                suggestion:
                  "Could not reach the Laminar Desktop Service. Check that the Cloudflare Tunnel is still active and the LDS process is running on the VM. Try vm_status to verify connectivity.",
              };
            } else if (
              errorStr.includes("resolution") ||
              errorStr.includes("DPI") ||
              errorStr.includes("scale")
            ) {
              rpaAnalysis = {
                pattern: "resolution_mismatch",
                suggestion:
                  "Script may have been built at a different screen resolution than it's running at. Use vm_inspect_ui screen_info to check current resolution, and re-record coordinates if needed.",
              };
            } else {
              rpaAnalysis = {
                pattern: "unknown_rpa_error",
                suggestion:
                  "Review the stderr/stdout for the root cause. Common RPA issues: wrong window focused (use vm_reset_state first), element not interactable (check IsEnabled), unexpected dialog/popup blocking the target.",
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

        const baseUrl = deps.getApiBase();

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
}
