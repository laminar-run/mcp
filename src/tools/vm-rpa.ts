import { z } from "zod";
import {
  ok,
  text,
  json,
  safe,
  buildRpaProgram,
  NOT_CONNECTED_VM,
} from "../helpers.js";
import { ldsConnection, ldsAuth } from "../state.js";
import * as lds from "../lds-client.js";
import type { ToolDeps } from "../types.js";

function requireVM() {
  if (!ldsConnection) return text(NOT_CONNECTED_VM);
  return null;
}

export function register(deps: ToolDeps) {
  const { server } = deps;

  // ── RPA flow creation ─────────────────────────────────────

  server.tool(
    "create_rpa_flow",
    "Create an RPA flow step that executes a Python script on the VM. Wraps your Python in the correct lam.httpRequest or lam.rpa dispatch format automatically.",
    {
      workflowId: z.number().describe("Workflow ID"),
      name: z.string().describe("Step name"),
      description: z.string().describe("Step description"),
      pythonScript: z.string().describe("Python script to execute on VM"),
      executionOrder: z.number().describe("Step position (starts at 1)"),
      flowId: z
        .string()
        .describe("Flow ID used inside the RPA payload for tracking"),
      dispatchPattern: z
        .enum(["cloudflare_tunnel", "channel"])
        .default("cloudflare_tunnel")
        .describe("How the script is dispatched to the VM"),
    },
    async ({
      workflowId,
      name,
      description,
      pythonScript,
      executionOrder,
      flowId,
      dispatchPattern,
    }) => {
      const program = buildRpaProgram(
        pythonScript,
        dispatchPattern,
        flowId,
        name,
        description,
      );
      return safe(() =>
        deps.client().createFlow({
          workflowId,
          name,
          description,
          program,
          executionOrder,
          flowType: "RPA",
          language: "js",
        }),
      );
    },
  );

  // ── Debug / test ──────────────────────────────────────────

  server.tool(
    "debug_rpa_step",
    "Debug an RPA step: takes a BEFORE screenshot, executes the script, takes an AFTER screenshot, and returns all results side-by-side.",
    {
      script: z.string().describe("Python script to execute"),
      stepName: z
        .string()
        .optional()
        .describe("Step label for the debug output"),
    },
    async ({ script, stepName }) => {
      const err = requireVM();
      if (err) return err;
      try {
        const before = await lds.screenshot(ldsConnection!.url, ldsAuth());
        const execResult = await lds.execute(
          ldsConnection!.url,
          script,
          undefined,
          ldsAuth(),
        );
        const after = await lds.screenshot(ldsConnection!.url, ldsAuth());

        return {
          content: [
            {
              type: "text" as const,
              text: `── ${stepName ?? "RPA Step"} ── BEFORE ──`,
            },
            {
              type: "image" as const,
              data: before.image,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: json({
                success: execResult.success,
                exitCode: execResult.exitCode,
                stdout: execResult.stdout,
                stderr: execResult.stderr,
                executionTimeMs: execResult.executionTimeMs,
                skipped: execResult.skipped,
                stopped: execResult.stopped,
              }),
            },
            {
              type: "text" as const,
              text: `── ${stepName ?? "RPA Step"} ── AFTER ──`,
            },
            {
              type: "image" as const,
              data: after.image,
              mimeType: "image/png" as const,
            },
          ],
        };
      } catch (e: any) {
        return text(`Debug RPA step failed: ${e.message}`);
      }
    },
  );

  // ── VM state reset ────────────────────────────────────────

  server.tool(
    "vm_reset_state",
    "Reset VM UI state: close dialogs, close an app, minimize all windows, or focus an app.",
    {
      appName: z.string().describe("Application name to target"),
      action: z
        .enum(["close_dialogs", "close_app", "minimize_all", "focus_app"])
        .default("close_dialogs")
        .describe("Reset action to perform"),
    },
    async ({ appName, action }) => {
      const err = requireVM();
      if (err) return err;

      let script: string;
      switch (action) {
        case "close_dialogs":
          script = `
import uiautomation as auto, time, json

app_name = ${JSON.stringify(appName)}
root = auto.GetRootControl()
closed = []
for win in root.GetChildren():
    try:
        if app_name.lower() in (win.Name or "").lower():
            for child in win.GetChildren():
                if child.ControlTypeName in ("Window", "Pane"):
                    child.SendKeys("{Escape}")
                    closed.append(child.Name or child.ControlTypeName)
                    time.sleep(0.3)
    except Exception:
        pass
print(json.dumps({"action": "close_dialogs", "app": app_name, "closed": closed}))
`.trim();
          break;

        case "close_app":
          script = `
import subprocess, json

app_name = ${JSON.stringify(appName)}
result = subprocess.run(["taskkill", "/IM", app_name, "/F"], capture_output=True, text=True)
print(json.dumps({"action": "close_app", "app": app_name, "stdout": result.stdout.strip(), "stderr": result.stderr.strip(), "exitCode": result.returncode}))
`.trim();
          break;

        case "minimize_all":
          script = `
import subprocess, json

subprocess.run(["powershell", "-command", "(New-Object -ComObject Shell.Application).MinimizeAll()"], capture_output=True)
print(json.dumps({"action": "minimize_all", "success": True}))
`.trim();
          break;

        case "focus_app":
          script = `
import uiautomation as auto, json

app_name = ${JSON.stringify(appName)}
root = auto.GetRootControl()
found = False
for win in root.GetChildren():
    try:
        if app_name.lower() in (win.Name or "").lower():
            win.SetActive()
            found = True
            print(json.dumps({"action": "focus_app", "app": app_name, "window": win.Name, "focused": True}))
            break
    except Exception:
        pass
if not found:
    print(json.dumps({"action": "focus_app", "app": app_name, "focused": False, "error": "Window not found"}))
`.trim();
          break;
      }

      try {
        const res = await lds.execute(
          ldsConnection!.url,
          script,
          undefined,
          ldsAuth(),
        );
        if (!res.success) {
          return text(
            `vm_reset_state(${action}) failed: ${res.stderr || res.stdout}`,
          );
        }
        try {
          return ok(JSON.parse(res.stdout));
        } catch {
          return text(res.stdout);
        }
      } catch (e: any) {
        return text(`vm_reset_state failed: ${e.message}`);
      }
    },
  );

  // ── Batch testing ─────────────────────────────────────────

  server.tool(
    "batch_test_rpa",
    "Run a workflow for each set of test inputs and collect pass/fail results.",
    {
      workflowId: z.number().describe("Workflow ID to execute"),
      testInputs: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Array of input objects — one execution per entry"),
    },
    async ({ workflowId, testInputs }) => {
      const results: Array<{
        index: number;
        input: Record<string, unknown>;
        passed: boolean;
        result?: unknown;
        error?: string;
      }> = [];

      for (let i = 0; i < testInputs.length; i++) {
        try {
          const res = await deps
            .client()
            .executeWorkflow(workflowId, testInputs[i]);
          results.push({ index: i, input: testInputs[i], passed: true, result: res });
        } catch (e: any) {
          results.push({
            index: i,
            input: testInputs[i],
            passed: false,
            error: e.message,
          });
        }
      }

      const passed = results.filter((r) => r.passed).length;
      return ok({
        summary: {
          total: testInputs.length,
          passed,
          failed: testInputs.length - passed,
        },
        results,
      });
    },
  );

  // ── Setup guide ───────────────────────────────────────────

  server.tool(
    "get_lds_setup_guide",
    "Get the step-by-step guide for installing the Laminar Desktop Service (LDS) on a Windows VM and connecting it via Cloudflare Tunnel.",
    {},
    async () => {
      return text(`# Laminar Desktop Service (LDS) — Setup Guide

## Prerequisites
- Windows 10/11 or Windows Server VM
- Administrator access
- Port 1016 open for inbound traffic

## Step 1: Run the bootstrap script
Copy \`vm_setup.bat\` to the VM and run **as Administrator**.
This installs Git, Python 3.11, and VS Code via Chocolatey.

## Step 2: Clone and configure LDS
Open **Git Bash** and run:
\`\`\`bash
git clone <your-lds-repo-url>
cd laminar-desktop-service
cp .env.example .env
\`\`\`

Edit \`.env\` with your workspace values:
- \`LAMINAR_DESKTOP_SERVICE_API_KEY\` — from your Minicor workspace
- \`LAMINAR_DESKTOP_SERVICE_ID\` — from your Minicor workspace
- \`PORT=1016\` (default)
- \`SCRIPT_VM_NAME\` — a name for this VM

## Step 3: Set up Python environment
\`\`\`bash
./1-setup-python.sh    # sets up the Flask venv
./setup.sh             # sets up the script execution venv
\`\`\`

## Step 4: Start the LDS server
\`\`\`
2-start-app.bat
\`\`\`
Verify: \`curl http://localhost:1016/health\` should return \`{"status": "healthy"}\`

## Step 5 (Optional): Install as Windows service
For auto-start on boot:
\`\`\`powershell
.\\windows\\install-chocolatey.ps1
.\\windows\\install-nssm.ps1
.\\windows\\setup-service.ps1
\`\`\`

## Step 6: Expose via Cloudflare Tunnel
Install cloudflared on the VM, then run:
\`\`\`bash
cloudflared tunnel --url http://localhost:1016
\`\`\`
This produces a URL like \`https://xxxx-yyyy.trycloudflare.com\`. Copy this URL.

## Step 7: Connect from Cursor / Claude Code
Call the \`vm_connect\` tool with the tunnel URL:
\`\`\`json
{ "url": "https://xxxx-yyyy.trycloudflare.com" }
\`\`\`
You can now use \`vm_screenshot\`, \`vm_execute_script\`, \`vm_inspect_ui\`, and all other VM tools.

## Troubleshooting
- **LDS won't start**: Check Python is on PATH, check .env values, check port 1016 is free
- **Tunnel fails**: Ensure cloudflared is installed and port 1016 is accessible locally
- **vm_connect fails**: Verify the tunnel URL is correct and LDS is running (\`/health\` endpoint)
`);
    },
  );
}
