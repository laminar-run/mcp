import { z } from "zod";
import { safe } from "../helpers.js";
import type { ToolDeps } from "../types.js";

export function register(deps: ToolDeps) {
  const { server } = deps;

  server.tool(
    "list_issues",
    "List all issues in a workspace",
    { workspaceId: z.number().describe("Workspace ID") },
    async ({ workspaceId }) =>
      safe(() => deps.client().listIssues(workspaceId)),
  );

  server.tool(
    "get_issue",
    "Get issue details",
    {
      workspaceId: z.number().describe("Workspace ID"),
      issueId: z.number().describe("Issue ID"),
    },
    async ({ workspaceId, issueId }) =>
      safe(() => deps.client().getIssue(workspaceId, issueId)),
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
        deps.client().createIssue(workspaceId, {
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
      safe(() => deps.client().updateIssue(workspaceId, issueId, data)),
  );

  server.tool(
    "delete_issue",
    "Delete an issue",
    {
      workspaceId: z.number().describe("Workspace ID"),
      issueId: z.number().describe("Issue ID"),
    },
    async ({ workspaceId, issueId }) =>
      safe(() => deps.client().deleteIssue(workspaceId, issueId)),
  );
}
