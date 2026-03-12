import { z } from "zod";
import { ok, text, json, NOT_CONNECTED_VM } from "../helpers.js";
import { ldsConnection, setLdsConnection, ldsAuth } from "../state.js";
import * as lds from "../lds-client.js";
import { generateInspectScript } from "../inspect-scripts.js";
import type { ToolDeps } from "../types.js";

function requireVM() {
  if (!ldsConnection) return text(NOT_CONNECTED_VM);
  return null;
}

export function register(deps: ToolDeps) {
  const { server } = deps;

  // ── Connection management ─────────────────────────────────

  server.tool(
    "vm_connect",
    "Connect to a Windows VM via Laminar Desktop Service (Cloudflare Tunnel URL). Must be called before any other vm_* tool.",
    {
      url: z.string().describe("LDS base URL (Cloudflare Tunnel)"),
      apiKey: z.string().optional().describe("LDS API key"),
      serviceId: z.string().optional().describe("LDS service ID"),
    },
    async ({ url, apiKey, serviceId }) => {
      try {
        const health = await lds.health(url);
        setLdsConnection({ url, apiKey, serviceId });
        return ok({
          connected: true,
          url,
          authenticated: !!(apiKey && serviceId),
          service: health,
        });
      } catch (e: any) {
        return text(`Failed to connect to VM at ${url}: ${e.message}`);
      }
    },
  );

  server.tool(
    "vm_disconnect",
    "Disconnect from the current VM",
    {},
    async () => {
      setLdsConnection(null);
      return text("Disconnected from VM.");
    },
  );

  server.tool(
    "vm_status",
    "Check health/status of the connected VM",
    {},
    async () => {
      const err = requireVM();
      if (err) return err;
      try {
        const health = await lds.health(ldsConnection!.url);
        return ok({ connected: true, url: ldsConnection!.url, ...health });
      } catch (e: any) {
        return text(`VM unreachable: ${e.message}`);
      }
    },
  );

  // ── Screenshot ────────────────────────────────────────────

  server.tool(
    "vm_screenshot",
    "Take a full-screen screenshot of the connected VM",
    {},
    async () => {
      const err = requireVM();
      if (err) return err;
      try {
        const res = await lds.screenshot(ldsConnection!.url, ldsAuth());
        const { width, height, size_bytes, capture_duration_ms, timestamp } =
          res.metadata;
        return {
          content: [
            {
              type: "image" as const,
              data: res.image,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: json({
                width,
                height,
                size_bytes,
                capture_duration_ms,
                timestamp,
              }),
            },
          ],
        };
      } catch (e: any) {
        return text(`Screenshot failed: ${e.message}`);
      }
    },
  );

  server.tool(
    "vm_screenshot_region",
    "Capture a specific rectangular region of the VM screen",
    {
      x: z.number().describe("Left X coordinate"),
      y: z.number().describe("Top Y coordinate"),
      width: z.number().describe("Region width in pixels"),
      height: z.number().describe("Region height in pixels"),
    },
    async ({ x, y, width, height }) => {
      const err = requireVM();
      if (err) return err;
      const x2 = x + width;
      const y2 = y + height;
      const script = `
import json, base64, io
from PIL import ImageGrab

img = ImageGrab.grab(bbox=(${x}, ${y}, ${x2}, ${y2}))
buf = io.BytesIO()
img.save(buf, format="PNG")
b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
print(json.dumps({"image": b64, "width": img.width, "height": img.height}))
`.trim();
      try {
        const res = await lds.execute(
          ldsConnection!.url,
          script,
          undefined,
          ldsAuth(),
        );
        if (!res.success) {
          return text(`Region screenshot failed: ${res.stderr || "unknown error"}`);
        }
        const parsed = JSON.parse(res.stdout);
        return {
          content: [
            {
              type: "image" as const,
              data: parsed.image,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: json({
                width: parsed.width,
                height: parsed.height,
                region: { x, y, width, height },
              }),
            },
          ],
        };
      } catch (e: any) {
        return text(`Region screenshot failed: ${e.message}`);
      }
    },
  );

  // ── Script execution ──────────────────────────────────────

  server.tool(
    "vm_execute_script",
    "Execute a Python script on the connected VM. Returns stdout, stderr, exit code, and timing.",
    {
      script: z.string().describe("Python script to execute"),
      executionId: z.string().optional().describe("Execution ID for tracking"),
      flowId: z.string().optional().describe("Flow ID for tracking"),
    },
    async ({ script, executionId, flowId }) => {
      const err = requireVM();
      if (err) return err;
      try {
        const res = await lds.execute(
          ldsConnection!.url,
          script,
          { executionId, flowId },
          ldsAuth(),
        );
        return ok({
          success: res.success,
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          executionTimeMs: res.executionTimeMs,
          skipped: res.skipped,
          stopped: res.stopped,
          resultData: res.resultData,
        });
      } catch (e: any) {
        return text(`Execution failed: ${e.message}`);
      }
    },
  );

  // ── Execution status / control ────────────────────────────

  server.tool(
    "vm_execution_status",
    "Get current execution status on the VM (active script, progress, queue)",
    {},
    async () => {
      const err = requireVM();
      if (err) return err;
      try {
        const status = await lds.executionStatus(
          ldsConnection!.url,
          ldsAuth(),
        );
        return ok(status);
      } catch (e: any) {
        return text(`Failed to get execution status: ${e.message}`);
      }
    },
  );

  server.tool(
    "vm_execution_control",
    "Control script execution on the VM (pause, resume, stop, skip)",
    {
      command: z
        .enum(["pause", "resume", "stop", "skip"])
        .describe("Control command"),
    },
    async ({ command }) => {
      const err = requireVM();
      if (err) return err;
      try {
        const result = await lds.executionControl(
          ldsConnection!.url,
          command,
          ldsAuth(),
        );
        return ok(result);
      } catch (e: any) {
        return text(`Execution control failed: ${e.message}`);
      }
    },
  );

  // ── UI inspection ─────────────────────────────────────────

  server.tool(
    "vm_inspect_ui",
    "Inspect the Windows UI on the VM: list windows, get element trees, find elements at coordinates, get focused element, or query screen info.",
    {
      mode: z
        .enum([
          "window_list",
          "screen_info",
          "element_at_point",
          "element_tree",
          "focused_element",
        ])
        .describe("Inspection mode"),
      x: z.number().optional().describe("X coordinate (for element_at_point)"),
      y: z.number().optional().describe("Y coordinate (for element_at_point)"),
      windowTitle: z
        .string()
        .optional()
        .describe("Window title filter (for element_tree)"),
      framework: z
        .enum(["auto", "uiautomation", "pywinauto", "jab"])
        .optional()
        .describe("Automation framework (default: auto → uiautomation)"),
      depth: z
        .number()
        .optional()
        .describe("Max tree depth (for element_tree, default 3)"),
    },
    async ({ mode, x, y, windowTitle, framework, depth }) => {
      const err = requireVM();
      if (err) return err;
      const script = generateInspectScript({
        mode,
        x,
        y,
        windowTitle,
        framework,
        depth,
      });
      try {
        const res = await lds.execute(
          ldsConnection!.url,
          script,
          undefined,
          ldsAuth(),
        );
        if (!res.success) {
          return text(
            `UI inspection failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`,
          );
        }
        try {
          return ok(JSON.parse(res.stdout));
        } catch {
          return text(res.stdout);
        }
      } catch (e: any) {
        return text(`UI inspection failed: ${e.message}`);
      }
    },
  );

  // ── Clipboard ─────────────────────────────────────────────

  server.tool(
    "vm_read_clipboard",
    "Read the current clipboard contents from the VM",
    {},
    async () => {
      const err = requireVM();
      if (err) return err;
      const script = `
import json

clipboard_text = ""
try:
    import win32clipboard
    win32clipboard.OpenClipboard()
    try:
        clipboard_text = win32clipboard.GetClipboardData()
    except TypeError:
        clipboard_text = ""
    finally:
        win32clipboard.CloseClipboard()
except ImportError:
    import subprocess
    result = subprocess.run(["powershell", "-command", "Get-Clipboard"], capture_output=True, text=True)
    clipboard_text = result.stdout.strip()

print(json.dumps({"clipboard": clipboard_text}))
`.trim();
      try {
        const res = await lds.execute(
          ldsConnection!.url,
          script,
          undefined,
          ldsAuth(),
        );
        if (!res.success) {
          return text(`Clipboard read failed: ${res.stderr || "unknown error"}`);
        }
        try {
          return ok(JSON.parse(res.stdout));
        } catch {
          return text(res.stdout);
        }
      } catch (e: any) {
        return text(`Clipboard read failed: ${e.message}`);
      }
    },
  );
}
