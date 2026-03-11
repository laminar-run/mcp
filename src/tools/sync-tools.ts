import path from "node:path";
import { z } from "zod";
import { ok, text } from "../helpers.js";
import {
  initProject,
  pullAll,
  pullWorkflow,
  pushChanged,
  pushWorkflow,
  syncStatus,
} from "../sync.js";
import type { ToolDeps } from "../types.js";

export function register(deps: ToolDeps) {
  const { server } = deps;

  server.tool(
    "init_project",
    "Scaffold a full Laminar project from a workspace. Pulls all (or selected) workflows into a git-ready directory with laminar.json manifest, GitHub Actions CI/CD configs, README, and .gitignore. This is the onboarding tool — run it once to set up version control for a workspace.",
    {
      workspaceId: z
        .number()
        .describe("Workspace ID to pull workflows from"),
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
        const result = await initProject(
          deps.client(),
          workspaceId,
          resolved,
          { workflowIds, apiBase: deps.getApiBase() },
        );
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
        const result = await pullWorkflow(deps.client(), workflowId, resolved);
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
        .describe(
          "Local directory containing workflow.json and steps/ folder",
        ),
      workflowId: z
        .number()
        .optional()
        .describe("Target workflow ID (overrides ID in workflow.json)"),
    },
    async ({ workflowDir, workflowId }) => {
      try {
        const resolved = path.resolve(workflowDir);
        const result = await pushWorkflow(deps.client(), resolved, workflowId);
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
        .describe(
          "Local directory containing workflow.json and steps/ folder",
        ),
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
        const result = await syncStatus(deps.client(), resolved, workflowId);
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
        const result = await pullAll(deps.client(), resolved);
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
        const result = await pushChanged(deps.client(), resolved);
        return ok(result);
      } catch (e: any) {
        return text(`Error: ${e.message}`);
      }
    },
  );
}
