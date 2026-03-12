import { z } from "zod";
import type { ToolDeps } from "../types.js";

export function register({ server }: ToolDeps) {
  server.prompt(
    "build-rpa-workflow",
    "Iteratively build an RPA workflow on a VM using the Laminar Desktop Service. Guides you through connecting to the VM, researching the target app's UI framework, taking screenshots, inspecting UI elements, writing and testing RPA scripts, and saving each working step as a Laminar workflow flow.",
    {
      workspaceId: z.string().describe("Laminar workspace ID"),
      task: z
        .string()
        .describe(
          "Description of what to automate (e.g. 'Log into Centricity, navigate to Documents, download the latest report')",
        ),
      appName: z
        .string()
        .describe(
          "Name of the application to automate (e.g. 'Centricity', 'SAP GUI', 'Epic Hyperspace')",
        ),
      workflowId: z
        .string()
        .optional()
        .describe(
          "Existing workflow ID to add steps to (omit to create a new workflow)",
        ),
    },
    async ({ workspaceId, task, appName, workflowId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are building an RPA workflow on the Laminar platform. Your goal is to iteratively create automation steps that run on a VM via the Laminar Desktop Service (LDS).

## Task
${task}

## Target Application
${appName}

## Workspace
ID: ${workspaceId}${workflowId ? `\nExisting workflow ID: ${workflowId} (add steps to this workflow)` : "\nCreate a new workflow for this automation."}

## CRITICAL RULES

### Rule 1 — MANDATORY VALIDATION
**NEVER save a step without first validating it on the VM.** Every RPA script MUST pass this sequence:
1. \`vm_execute_script\` — run on the VM
2. \`vm_screenshot\` — visually confirm it worked
3. Only then → save via \`create_rpa_flow\`

### Rule 2 — USE \`create_rpa_flow\` TO SAVE (NOT \`create_flow\`)
When saving an RPA step, call **\`create_rpa_flow\`** — it automatically wraps your Python script in the correct Laminar JS format. You only pass the Python script; the tool handles the \`lam.httpRequest\` / \`lam.rpa\` wrapper.

**NEVER** call \`create_flow\` with raw Python for an RPA step. **NEVER** try to construct the JS wrapper yourself.

### Rule 3 — COMBINE ui_inspect + screenshots + clipboard
Screenshots alone are unreliable for reading data (resolution issues, misreads). ALWAYS combine multiple methods. See the Data Extraction Strategy section below.

## Procedure

### 1. Connect to the VM
If no VM is connected, ask for the **Cloudflare Tunnel URL** and call \`vm_connect\`.

### 2. Research the Target Application
Based on "${appName}", pick the UI automation framework:
- **.NET / WPF / WinForms** → \`uiautomation\` (default) or \`pywinauto\`
- **Java / Swing** → \`jab\` (Java Access Bridge)
- **Electron / web-based desktop** → \`pywinauto\` or pyautogui
- **Legacy Win32** → \`uiautomation\`

Start with \`uiautomation\` if unsure.

### 3. Initial Survey (ALWAYS do this first)
Before writing any automation:
1. \`vm_screenshot\` — see the desktop state
2. \`vm_inspect_ui\` mode \`screen_info\` — get resolution
3. \`vm_inspect_ui\` mode \`window_list\` — list windows
4. Verify the target app is running

### 4. Iterative Build Loop — For EACH step:

**a. OBSERVE — Understand the current state (REQUIRED)**
- \`vm_screenshot\` to see the screen
- \`vm_inspect_ui\` with \`element_tree\` to map UI elements
- \`vm_inspect_ui\` with \`element_at_point\` for specific elements

**b. WRITE — Create the Python RPA script**
- Use the appropriate framework (pyautogui for mouse/keyboard, uiautomation/pywinauto for element-based)
- Include error handling and waits
- Explain what it does before executing

**c. VALIDATE — Test on the VM (REQUIRED)**
- \`vm_execute_script\` — run the script
- Or use \`debug_rpa_step\` for full before/after screenshots + diagnostics
- Fix and re-run if errors occur

**d. VERIFY — Confirm visually (REQUIRED)**
- \`vm_screenshot\` immediately after
- If result is wrong, go back to (b)

**e. SAVE — Call \`create_rpa_flow\` (only after c + d pass)**
- Pass the validated Python script, step name, description, flowId, and executionOrder
- The tool handles all JS wrapping automatically
- Default dispatch: \`cloudflare_tunnel\` (uses \`lam.httpRequest\`)

### 5. End-to-End Validation
After all steps are built:
- \`execute_workflow\` to run the full sequence
- \`vm_screenshot\` to verify final state
- \`diagnose_execution\` if anything fails

### 6. Iterate with the User
- Present completed workflow summary
- Make adjustments, re-validate changed steps

## Data Extraction Strategy

When you need to READ data from the screen (not just click/type), follow this priority order. **Do NOT rely solely on screenshots for data reading.**

### Priority 1: Accessibility Tree (most reliable)
- \`vm_inspect_ui\` with \`element_tree\` on the target window
- If the tree exposes text values, this is the most reliable method
- Use \`element_at_point\` for specific fields
- Use \`focused_element\` to read the current field

### Priority 2: Open Accessible Dialogs
- Many apps expose more data when you open edit/detail dialogs
- Double-click on a row or click "Edit" to open a modal — the modal often has better accessibility support
- Then use \`element_tree\` on the modal

### Priority 3: Clipboard Extraction
- Use \`vm_execute_script\` to click a field, then Ctrl+A, Ctrl+C
- Call \`vm_read_clipboard\` to get the copied text
- Works for individual fields, text areas, and some grid cells

### Priority 4: Keyboard Navigation
- Tab through fields, reading each via \`vm_inspect_ui\` \`focused_element\`
- Useful when the accessibility tree returns element structure but not values

### Priority 5: Zoomed Screenshot
- Use \`vm_screenshot_region\` to crop a specific area for better resolution
- Only for small text that can't be accessed any other way

### Priority 6: Alternative Application Paths
- Think creatively! Look for:
  - Reports or Print menus that export data
  - List/Search views with better accessibility
  - CLI tools or command-line interfaces the app provides
  - Export to CSV/clipboard options
  - Alternative windows/dialogs that show the same data more accessibly
- Use \`vm_execute_script\` to run Python code that queries the app's data directly if a CLI or API exists

### Priority 7: Full Screenshot (VERIFICATION ONLY)
- Full desktop screenshots are for **verifying actions worked**, NOT for reading data
- If you must use a screenshot to read data, acknowledge it's unreliable and suggest a better approach to the user

## Debugging Tools

- **\`debug_rpa_step\`** — runs a script with before/after screenshots and full diagnostics (stdout, stderr, exit code). Use during development.
- **\`vm_reset_state\`** — Smart Launch: close dialogs, reset app to known state. Use before testing.
- **\`vm_read_clipboard\`** — read clipboard after a copy operation.
- **\`vm_screenshot_region\`** — crop/zoom a region for better text reading.
- **\`batch_test_rpa\`** — run the workflow with multiple test inputs.

## Important Rules
- **VALIDATE BEFORE SAVING** — no exceptions unless user explicitly opts out
- **Use \`create_rpa_flow\`** — never construct JS wrappers manually
- **Use \`{{config.variables}}\` for secrets** — never hardcode credentials
- **Combine extraction methods** — accessibility tree + clipboard + screenshots
- **Start simple** — get basic automation working before adding sophistication
- **Add waits** — use \`time.sleep()\` or element-wait patterns between actions
- **Handle errors** — try/except with meaningful messages
- **Keep scripts focused** — one logical action per step`,
          },
        },
      ],
    }),
  );
}
