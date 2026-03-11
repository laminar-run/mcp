import { z } from "zod";
import { ok, text, json, safe, NOT_CONNECTED_BROWSER } from "../helpers.js";
import {
  browserConnection,
  setBrowserConnection,
  updateBrowserSession,
} from "../state.js";
import type { ToolDeps } from "../types.js";

function requireBrowser() {
  if (!browserConnection) return text(NOT_CONNECTED_BROWSER);
  return null;
}

function requireBrowserSession() {
  const conn = requireBrowser();
  if (conn) return conn;
  if (!browserConnection!.sessionId)
    return text(
      "No active browser session. Call browser_create_session first.",
    );
  return null;
}

function browserFetch(path: string, init?: RequestInit) {
  const url = `${browserConnection!.baseUrl.replace(/\/+$/, "")}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${browserConnection!.bearerToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

function sessionId(override?: string): string {
  return override ?? browserConnection!.sessionId!;
}

export function register(deps: ToolDeps) {
  const { server } = deps;

  // ── Connection ────────────────────────────────────────────

  server.tool(
    "browser_connect",
    "Connect to a browser RPA service (e.g. Browser-Use). Provide the base URL and bearer token.",
    {
      baseUrl: z.string().describe("Browser service base URL"),
      bearerToken: z.string().describe("Bearer authentication token"),
      slackChannelId: z
        .string()
        .optional()
        .describe("Optional Slack channel ID for notifications"),
    },
    async ({ baseUrl, bearerToken, slackChannelId }) => {
      setBrowserConnection({ baseUrl, bearerToken, slackChannelId });
      return ok({
        connected: true,
        baseUrl,
        hasSlackChannel: !!slackChannelId,
      });
    },
  );

  // ── Session management ────────────────────────────────────

  server.tool(
    "browser_create_session",
    "Create a new browser session on the connected service",
    {},
    async () => {
      const err = requireBrowser();
      if (err) return err;
      try {
        const res = await browserFetch("/sessions", { method: "POST" });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return text(`Failed to create session (${res.status}): ${body}`);
        }
        const data = (await res.json()) as { id: string; [k: string]: unknown };
        updateBrowserSession(data.id);
        return ok({ sessionId: data.id, ...data });
      } catch (e: any) {
        return text(`Failed to create session: ${e.message}`);
      }
    },
  );

  server.tool(
    "browser_close_session",
    "Close a browser session",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Session ID (defaults to current session)"),
    },
    async ({ sessionId: sid }) => {
      const err = requireBrowserSession();
      if (err && !sid) return err;
      const id = sessionId(sid);
      try {
        const res = await browserFetch(`/sessions/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return text(`Failed to close session (${res.status}): ${body}`);
        }
        if (!sid || sid === browserConnection!.sessionId) {
          updateBrowserSession(undefined);
        }
        return ok({ closed: true, sessionId: id });
      } catch (e: any) {
        return text(`Failed to close session: ${e.message}`);
      }
    },
  );

  // ── Browser actions ───────────────────────────────────────

  server.tool(
    "browser_act",
    "Send a natural-language action to the browser session (e.g. 'click login button', 'type hello into search').",
    {
      message: z.string().describe("Natural-language action instruction"),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID (defaults to current session)"),
    },
    async ({ message, sessionId: sid }) => {
      const err = requireBrowserSession();
      if (err && !sid) return err;
      const id = sessionId(sid);
      try {
        const res = await browserFetch(`/sessions/${id}/act`, {
          method: "POST",
          body: JSON.stringify({ message }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return text(`browser_act failed (${res.status}): ${body}`);
        }
        return ok(await res.json());
      } catch (e: any) {
        return text(`browser_act failed: ${e.message}`);
      }
    },
  );

  server.tool(
    "browser_extract",
    "Extract structured data from the current browser page using natural-language instructions.",
    {
      instructions: z.string().describe("What data to extract from the page"),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID (defaults to current session)"),
    },
    async ({ instructions, sessionId: sid }) => {
      const err = requireBrowserSession();
      if (err && !sid) return err;
      const id = sessionId(sid);
      try {
        const res = await browserFetch(`/sessions/${id}/extract`, {
          method: "POST",
          body: JSON.stringify({ instructions }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return text(`browser_extract failed (${res.status}): ${body}`);
        }
        return ok(await res.json());
      } catch (e: any) {
        return text(`browser_extract failed: ${e.message}`);
      }
    },
  );

  // ── Screenshot ────────────────────────────────────────────

  server.tool(
    "browser_screenshot",
    "Take a screenshot of the current browser session",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Session ID (defaults to current session)"),
    },
    async ({ sessionId: sid }) => {
      const err = requireBrowserSession();
      if (err && !sid) return err;
      const id = sessionId(sid);
      try {
        const res = await browserFetch(`/sessions/${id}/screenshot`, {
          method: "GET",
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return text(`browser_screenshot failed (${res.status}): ${body}`);
        }
        const data = (await res.json()) as {
          image: string;
          [k: string]: unknown;
        };
        return {
          content: [
            {
              type: "image" as const,
              data: data.image,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: json({ sessionId: id }),
            },
          ],
        };
      } catch (e: any) {
        return text(`browser_screenshot failed: ${e.message}`);
      }
    },
  );

  // ── Browser RPA flow creation ─────────────────────────────

  server.tool(
    "create_browser_rpa_flow",
    "Create a browser RPA flow step that makes HTTP requests to the browser service. Builds the lam.httpRequest program with config variables for the action type.",
    {
      workflowId: z.number().describe("Workflow ID"),
      name: z.string().describe("Step name"),
      description: z.string().describe("Step description"),
      executionOrder: z.number().describe("Step position (starts at 1)"),
      actionType: z
        .enum(["create_session", "act", "extract", "close_session"])
        .describe("Browser action type"),
      actionPayload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Additional payload fields (e.g. { message } for act, { instructions } for extract)",
        ),
      sessionIdRef: z
        .string()
        .optional()
        .describe(
          'Expression to resolve session ID at runtime (e.g. "data.sessionId")',
        ),
    },
    async ({
      workflowId,
      name,
      description,
      executionOrder,
      actionType,
      actionPayload,
      sessionIdRef,
    }) => {
      const sidExpr = sessionIdRef ?? "data.sessionId";
      let method: string;
      let pathExpr: string;
      let bodyExpr: string;

      switch (actionType) {
        case "create_session":
          method = "POST";
          pathExpr = "/sessions";
          bodyExpr = "{}";
          break;
        case "act":
          method = "POST";
          pathExpr = `\`/sessions/\${${sidExpr}}/act\``;
          bodyExpr = JSON.stringify(actionPayload ?? { message: "{{data.message}}" });
          break;
        case "extract":
          method = "POST";
          pathExpr = `\`/sessions/\${${sidExpr}}/extract\``;
          bodyExpr = JSON.stringify(
            actionPayload ?? { instructions: "{{data.instructions}}" },
          );
          break;
        case "close_session":
          method = "DELETE";
          pathExpr = `\`/sessions/\${${sidExpr}}\``;
          bodyExpr = "undefined";
          break;
      }

      const program = `(data) => {
  const sessionPath = ${actionType === "create_session" ? `"${pathExpr}"` : pathExpr};
  return {
    "lam.httpRequest": {
      "method": "${method}",
      "url": \`\${"{{config.browser_service_url}}"}\${sessionPath}\`,
      "headers": {
        "Authorization": "Bearer {{config.browser_service_token}}",
        "Content-Type": "application/json"
      }${bodyExpr !== "undefined" ? `,\n      "body": ${bodyExpr}` : ""}
    }
  };
}`;

      return safe(() =>
        deps.client().createFlow({
          workflowId,
          name,
          description,
          program,
          executionOrder,
          flowType: "HTTP_REQUEST",
          language: "js",
        }),
      );
    },
  );
}
