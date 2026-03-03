#!/usr/bin/env node

/**
 * Laminar CLI — manage workflows from the terminal or CI/CD pipelines.
 *
 * Usage:
 *   laminar init   --workspace <id> [--output <dir>]
 *   laminar pull   [--all | --workflow <id> --output <dir>]
 *   laminar push   [--changed | --workflow <dir>]
 *   laminar diff   [--all | --workflow <dir>]
 *
 * Auth: Set LAMINAR_API_KEY env var, or run `laminar-mcp-setup` first.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { LaminarClient, type LaminarAuth } from "./laminar-client.js";
import {
  initProject,
  pullWorkflow,
  pullAll,
  pushWorkflow,
  pushChanged,
  syncStatus,
  readManifest,
} from "./sync.js";

const TOKEN_PATH = path.join(os.homedir(), ".laminar", "tokens.json");
const CONFIG_PATH = path.join(os.homedir(), ".laminar", "config.json");

// ── Auth ─────────────────────────────────────────────────────

function resolveAuth(): { auth: LaminarAuth; baseUrl: string } {
  const apiKey = process.env.LAMINAR_API_KEY;
  if (apiKey) {
    const base =
      process.env.LAMINAR_API_BASE || "https://api.laminar.run";
    return { auth: { type: "apiKey", token: apiKey }, baseUrl: base };
  }

  const accessToken = process.env.LAMINAR_ACCESS_TOKEN;
  if (accessToken) {
    const base =
      process.env.LAMINAR_API_BASE || "https://api.laminar.run";
    return { auth: { type: "bearer", token: accessToken }, baseUrl: base };
  }

  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      return {
        auth: { type: "bearer", token: tokens.access_token },
        baseUrl: tokens.api_base || "https://api.laminar.run",
      };
    }
  } catch {}

  console.error(
    "No auth found. Set LAMINAR_API_KEY or run: laminar-mcp-setup"
  );
  process.exit(1);
}

// ── Arg parsing ──────────────────────────────────────────────

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const command = args[0] || "help";
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

function flag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function requireFlag(flags: Record<string, string | boolean>, key: string, desc: string): string {
  const v = flag(flags, key);
  if (!v) {
    console.error(`Missing required flag: --${key} (${desc})`);
    process.exit(1);
  }
  return v;
}

// ── Commands ─────────────────────────────────────────────────

async function cmdInit(client: LaminarClient, flags: Record<string, string | boolean>) {
  const workspaceId = parseInt(
    requireFlag(flags, "workspace", "Workspace ID")
  );
  const outputDir = path.resolve(flag(flags, "output") || ".");

  console.log(`Initializing project from workspace ${workspaceId}...`);
  const result = await initProject(client, workspaceId, outputDir);

  console.log(`\nPulled ${result.workflowsPulled} workflows to ${result.projectDir}`);
  console.log("\nNext steps:");
  console.log("  git init && git add . && git commit -m 'Initial Laminar workflow sync'");
  console.log("  git remote add origin <your-github-repo-url>");
  console.log("  git push -u origin main");
  console.log("  Add LAMINAR_API_KEY as a GitHub repo secret");
}

async function cmdPull(client: LaminarClient, flags: Record<string, string | boolean>) {
  if (flags.all) {
    const projectDir = path.resolve(flag(flags, "project") || ".");
    console.log(`Pulling all workflows from manifest...`);
    const result = await pullAll(client, projectDir);
    for (const p of result.pulled) {
      console.log(`  ✓ ${p.workflow}: ${p.steps} steps`);
    }
    for (const e of result.errors) {
      console.error(`  ✗ ${e.workflow}: ${e.error}`);
    }
    return;
  }

  const workflowId = parseInt(
    requireFlag(flags, "workflow", "Workflow ID")
  );
  const outputDir = path.resolve(
    requireFlag(flags, "output", "Output directory")
  );

  console.log(`Pulling workflow ${workflowId}...`);
  const result = await pullWorkflow(client, workflowId, outputDir);
  console.log(`  ✓ ${result.stepsWritten} steps → ${result.directory}`);
}

async function cmdPush(client: LaminarClient, flags: Record<string, string | boolean>) {
  if (flags.changed) {
    const projectDir = path.resolve(flag(flags, "project") || ".");
    console.log("Pushing changed workflows...");
    const result = await pushChanged(client, projectDir);

    for (const p of result.pushed) {
      console.log(`  ✓ ${p.workflow}: deployed ${p.steps} steps`);
      for (const d of p.details) {
        console.log(`      ${d.step} → ${d.action}`);
      }
    }
    for (const u of result.unchanged) {
      console.log(`  - ${u}: no changes`);
    }
    for (const e of result.errors) {
      console.error(`  ✗ ${e.workflow}: ${e.error}`);
    }

    console.log(
      `\nDone: ${result.pushed.length} deployed, ${result.unchanged.length} unchanged, ${result.errors.length} errors`
    );
    return;
  }

  const workflowDir = path.resolve(
    requireFlag(flags, "workflow", "Workflow directory")
  );
  console.log(`Pushing workflow from ${workflowDir}...`);
  const result = await pushWorkflow(client, workflowDir);
  console.log(`  ✓ ${result.stepsPushed} steps deployed to workflow ${result.workflowId}`);
}

async function cmdDiff(client: LaminarClient, flags: Record<string, string | boolean>) {
  if (flags.all || flags.json) {
    const projectDir = path.resolve(flag(flags, "project") || ".");
    const manifest = readManifest(projectDir);
    const workflowsDir = path.join(projectDir, "workflows");
    const allDiffs: Record<string, any> = {};

    for (const [dirName, wf] of Object.entries(manifest.workflows)) {
      const wfDir = path.join(workflowsDir, dirName);
      try {
        const status = await syncStatus(client, wfDir, wf.id);
        allDiffs[`${wf.name} (${wf.id})`] = status.changes;
      } catch (e: any) {
        allDiffs[`${wf.name} (${wf.id})`] = [
          { step: "error", status: "error", diff: e.message },
        ];
      }
    }

    if (flags.json) {
      console.log(JSON.stringify(allDiffs, null, 2));
      return;
    }

    for (const [wfName, changes] of Object.entries(allDiffs)) {
      const modified = (changes as any[]).filter(
        (c) => c.status !== "unchanged"
      );
      if (modified.length === 0) {
        console.log(`${wfName}: no changes`);
        continue;
      }
      console.log(`\n${wfName}:`);
      for (const c of changes as any[]) {
        if (c.status === "unchanged") continue;
        console.log(`  ${c.status.toUpperCase()} ${c.step}`);
        if (c.diff) {
          for (const line of c.diff.split("\n").slice(0, 20)) {
            console.log(`    ${line}`);
          }
        }
      }
    }
    return;
  }

  const workflowDir = path.resolve(
    requireFlag(flags, "workflow", "Workflow directory")
  );
  const result = await syncStatus(client, workflowDir);
  for (const c of result.changes) {
    const icon =
      c.status === "unchanged" ? "-" : c.status === "modified" ? "M" : "+";
    console.log(`  ${icon} ${c.step}`);
    if (c.diff) {
      for (const line of c.diff.split("\n").slice(0, 20)) {
        console.log(`    ${line}`);
      }
    }
  }
}

function showHelp() {
  console.log(`
Laminar CLI — manage workflows from the terminal

Usage:
  laminar <command> [flags]

Commands:
  init    Scaffold a project from a Laminar workspace
          --workspace <id>     Workspace ID (required)
          --output <dir>       Output directory (default: .)

  pull    Download workflows from Laminar
          --all                Pull all workflows in laminar.json
          --workflow <id>      Pull a specific workflow ID
          --output <dir>       Output directory (with --workflow)
          --project <dir>      Project root (with --all, default: .)

  push    Deploy workflows to Laminar
          --changed            Push only modified workflows from laminar.json
          --workflow <dir>     Push a specific workflow directory
          --project <dir>      Project root (with --changed, default: .)

  diff    Compare local files against deployed
          --all                Diff all workflows in laminar.json
          --json               Output as JSON (for CI)
          --workflow <dir>     Diff a specific workflow directory
          --project <dir>      Project root (with --all, default: .)

  help    Show this message

Auth:
  Set LAMINAR_API_KEY env var, or run laminar-mcp-setup first.
`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.help) {
    showHelp();
    return;
  }

  const { auth, baseUrl } = resolveAuth();
  const client = new LaminarClient(auth, baseUrl);

  switch (command) {
    case "init":
      await cmdInit(client, flags);
      break;
    case "pull":
      await cmdPull(client, flags);
      break;
    case "push":
      await cmdPush(client, flags);
      break;
    case "diff":
    case "status":
      await cmdDiff(client, flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
