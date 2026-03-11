import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { json } from "../helpers.js";

export function register({ server, client }: ToolDeps) {
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
        executionData = await client().getExecution(wId, eId);
        flowsData = await client().getWorkflowFlows(wId);
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
}
