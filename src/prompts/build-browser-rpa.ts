import { z } from "zod";
import type { ToolDeps } from "../types.js";

export function register({ server }: ToolDeps) {
  server.prompt(
    "build-browser-rpa-workflow",
    "Iteratively build a browser-based RPA workflow using the Laminar Browser RPA service. Guides you through creating a browser session, performing actions, extracting data, and saving each step as a Laminar workflow flow.",
    {
      workspaceId: z.string().describe("Laminar workspace ID"),
      task: z
        .string()
        .describe(
          "Description of what to automate (e.g. 'Log into athenaHealth, navigate to patient chart, extract insurance info')",
        ),
      targetUrl: z
        .string()
        .describe("Starting URL for the web application"),
      workflowId: z
        .string()
        .optional()
        .describe("Existing workflow ID to add steps to (omit to create a new workflow)"),
    },
    async ({ workspaceId, task, targetUrl, workflowId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are building a browser-based RPA workflow on the Laminar platform. Your goal is to automate web application interactions using the Browser RPA session API.

## Task
${task}

## Target URL
${targetUrl}

## Workspace
ID: ${workspaceId}${workflowId ? `\nExisting workflow ID: ${workflowId} (add steps to this workflow)` : "\nCreate a new workflow for this automation."}

## How Browser RPA Works

The Browser RPA service provides a session-based API:
1. **Create Session** — starts a browser instance, returns a sessionId
2. **Act** — sends natural-language actions (e.g. "click the login button", "type hello@example.com in the email field")
3. **Extract** — extracts data from the current page via natural-language instructions
4. **Screenshot** — captures the current browser state
5. **Close Session** — cleans up

## Procedure

### 1. Connect to Browser RPA Service
Call \`browser_connect\` with the service base URL and bearer token. Ask the user if not known.

### 2. Create a Browser Session
Call \`browser_create_session\` to get a sessionId.

### 3. Iterative Build Loop — For EACH step:

**a. ACT — Perform the browser action**
- Call \`browser_act\` with a natural-language description of what to do
- Be specific: "navigate to ${targetUrl}", "click the Submit button", "type 'john@example.com' into the email input field"

**b. VERIFY — Confirm the action worked**
- Call \`browser_screenshot\` to see the current state
- If the action didn't produce the expected result, retry with a more specific instruction

**c. EXTRACT — Get data if needed**
- Call \`browser_extract\` with instructions like "extract the patient name and date of birth"
- This returns structured data from the page

**d. SAVE — Persist as a workflow step**
- Call \`create_browser_rpa_flow\` with the action type and payload
- For the first step, use actionType "create_session"
- For navigation/interaction steps, use actionType "act"
- For data extraction steps, use actionType "extract"
- For cleanup, use actionType "close_session"

### 4. End-to-End Validation
- Run the full workflow via \`execute_workflow\`
- Verify the final state

### 5. Iterate with the User
- Present the completed workflow
- Make adjustments as needed

## Important Rules
- **Always verify actions with screenshots** before saving
- **Use \`create_browser_rpa_flow\`** to save steps — it generates the correct \`lam.httpRequest\` wrapper
- **Use \`{{config.variables}}\`** for credentials (bearerToken, baseUrl, etc.)
- **Be specific in actions** — natural language should be unambiguous
- **Handle 2FA/MFA** — if login requires verification codes, use waitForInput patterns
- **One action per step** — keep steps focused and debuggable`,
          },
        },
      ],
    }),
  );
}
