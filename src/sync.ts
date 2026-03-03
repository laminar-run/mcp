/**
 * Workflow sync — pull/push workflows between Laminar and local filesystem.
 * Supports per-workflow operations and workspace-level manifests (laminar.json).
 */

import fs from "node:fs";
import path from "node:path";
import type { LaminarClient } from "./laminar-client.js";
import { computeDiff } from "./diff.js";

// ── Types ────────────────────────────────────────────────────

export interface StepMeta {
  name: string;
  description: string;
  language: string;
  executionOrder: number;
  flowType: string;
  _file: string;
  _flowId?: number;
}

export interface WorkflowMeta {
  workflowId: number;
  workflowName?: string;
  pulledAt?: string;
  steps: StepMeta[];
}

export interface LaminarManifest {
  workspace: number;
  apiBase?: string;
  workflows: Record<string, { id: number; name: string }>;
}

// ── Helpers ──────────────────────────────────────────────────

export function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[:'"/\\()]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function readManifest(projectDir: string): LaminarManifest {
  const p = path.join(projectDir, "laminar.json");
  if (!fs.existsSync(p)) {
    throw new Error(`No laminar.json found in ${projectDir}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function writeManifest(projectDir: string, manifest: LaminarManifest) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "laminar.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8"
  );
}

// ── Pull ─────────────────────────────────────────────────────

export async function pullWorkflow(
  client: LaminarClient,
  workflowId: number,
  outputDir: string
): Promise<{ stepsWritten: number; directory: string }> {
  const [workflow, flows] = await Promise.all([
    client.getWorkflow(workflowId),
    client.getWorkflowFlows(workflowId),
  ]);
  const flowList: any[] = Array.isArray(flows) ? flows : [];
  if (!flowList.length) throw new Error("No flows found in workflow");

  const stepsDir = path.join(outputDir, "steps");
  fs.mkdirSync(stepsDir, { recursive: true });

  const metadata: StepMeta[] = [];

  for (const flow of flowList) {
    const order = flow.executionOrder || 0;
    const lang = flow.language || "js";
    const ext = lang === "py" ? "py" : "js";
    const filename = `${String(order).padStart(2, "0")}_${sanitize(flow.name || "unnamed")}.${ext}`;

    let code: string;
    try {
      const raw = await client.readFlow(flow.id);
      code = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    } catch {
      code = flow.program || "";
    }

    fs.writeFileSync(path.join(stepsDir, filename), code, "utf-8");
    metadata.push({
      name: flow.name,
      description: flow.description || "",
      language: lang,
      executionOrder: order,
      flowType: flow.flowType || "GENERAL_FUNCTION",
      _file: filename,
      _flowId: flow.id,
    });
  }

  const meta: WorkflowMeta = {
    workflowId,
    workflowName: workflow.name,
    pulledAt: new Date().toISOString(),
    steps: metadata,
  };

  fs.writeFileSync(
    path.join(outputDir, "workflow.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf-8"
  );

  return { stepsWritten: metadata.length, directory: outputDir };
}

// ── Push ─────────────────────────────────────────────────────

export async function pushWorkflow(
  client: LaminarClient,
  workflowDir: string,
  workflowId?: number
): Promise<{
  stepsPushed: number;
  workflowId: number;
  details: Array<{ step: string; action: string }>;
}> {
  const metaPath = path.join(workflowDir, "workflow.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error(`No workflow.json found in ${workflowDir}`);
  }

  const meta: WorkflowMeta = JSON.parse(
    fs.readFileSync(metaPath, "utf-8")
  );
  const wId = workflowId || meta.workflowId;
  if (!wId) throw new Error("No workflowId specified or found in metadata");

  const stepsDir = path.join(workflowDir, "steps");
  const details: Array<{ step: string; action: string }> = [];
  const hasFlowIds = meta.steps.every((s) => s._flowId);

  if (hasFlowIds) {
    for (const step of meta.steps) {
      const filePath = path.join(stepsDir, step._file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Step file not found: ${step._file}`);
      }
      await client.updateFlow({
        flowId: step._flowId!,
        name: step.name,
        description: step.description,
        program: fs.readFileSync(filePath, "utf-8"),
        language: step.language,
      });
      details.push({
        step: `${step.executionOrder}: ${step.name}`,
        action: `updated (flow ${step._flowId})`,
      });
    }
  } else {
    const payloads = meta.steps.map((step) => {
      const filePath = path.join(stepsDir, step._file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Step file not found: ${step._file}`);
      }
      return {
        workflowId: wId,
        name: step.name,
        description: step.description,
        program: fs.readFileSync(filePath, "utf-8"),
        executionOrder: step.executionOrder,
        language: step.language,
        flowType: step.flowType,
      };
    });
    await client.createOrUpdateFlows(wId, payloads);
    for (const step of meta.steps) {
      details.push({
        step: `${step.executionOrder}: ${step.name}`,
        action: "bulk create/update",
      });
    }
  }

  return { stepsPushed: meta.steps.length, workflowId: wId, details };
}

// ── Sync status ──────────────────────────────────────────────

export async function syncStatus(
  client: LaminarClient,
  workflowDir: string,
  workflowId?: number
): Promise<{
  localSteps: number;
  remoteSteps: number;
  changes: Array<{
    step: string;
    status: "modified" | "added_locally" | "added_remotely" | "unchanged";
    diff?: string;
  }>;
}> {
  const metaPath = path.join(workflowDir, "workflow.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error(`No workflow.json found in ${workflowDir}`);
  }

  const meta: WorkflowMeta = JSON.parse(
    fs.readFileSync(metaPath, "utf-8")
  );
  const wId = workflowId || meta.workflowId;
  const stepsDir = path.join(workflowDir, "steps");

  const remoteFlows: any[] = await (async () => {
    const f = await client.getWorkflowFlows(wId);
    return Array.isArray(f) ? f : [];
  })();

  const localByOrder = new Map(
    meta.steps.map((s) => [s.executionOrder, s])
  );
  const remoteByOrder = new Map(
    remoteFlows.map((r: any) => [r.executionOrder as number, r])
  );

  const allOrders = [
    ...new Set([...localByOrder.keys(), ...remoteByOrder.keys()]),
  ].sort((a, b) => a - b);

  const changes: Array<{
    step: string;
    status: "modified" | "added_locally" | "added_remotely" | "unchanged";
    diff?: string;
  }> = [];

  for (const order of allOrders) {
    const local = localByOrder.get(order);
    const remote = remoteByOrder.get(order);

    if (local && !remote) {
      changes.push({ step: `${order}: ${local.name}`, status: "added_locally" });
    } else if (!local && remote) {
      changes.push({ step: `${order}: ${remote.name}`, status: "added_remotely" });
    } else if (local && remote) {
      const filePath = path.join(stepsDir, local._file);
      const localCode = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf-8")
        : "";

      let remoteCode: string;
      try {
        const raw = await client.readFlow(remote.id);
        remoteCode = typeof raw === "string" ? raw : JSON.stringify(raw);
      } catch {
        remoteCode = remote.program || "";
      }

      if (localCode.trim() !== remoteCode.trim()) {
        changes.push({
          step: `${order}: ${local.name}`,
          status: "modified",
          diff: computeDiff(remoteCode, localCode, "remote", "local"),
        });
      } else {
        changes.push({ step: `${order}: ${local.name}`, status: "unchanged" });
      }
    }
  }

  return { localSteps: meta.steps.length, remoteSteps: remoteFlows.length, changes };
}

// ── Manifest-level operations ────────────────────────────────

export async function initProject(
  client: LaminarClient,
  workspaceId: number,
  outputDir: string,
  opts?: { workflowIds?: number[]; apiBase?: string }
): Promise<{
  projectDir: string;
  workflowsPulled: number;
  manifest: LaminarManifest;
}> {
  const allWorkflows: any[] = await client.listWorkflows(workspaceId);
  const toPull = opts?.workflowIds
    ? allWorkflows.filter((w: any) => opts.workflowIds!.includes(w.id))
    : allWorkflows;

  if (!toPull.length) throw new Error("No workflows to pull");

  fs.mkdirSync(outputDir, { recursive: true });

  const manifest: LaminarManifest = {
    workspace: workspaceId,
    apiBase: opts?.apiBase,
    workflows: {},
  };

  const workflowsDir = path.join(outputDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });

  for (const wf of toPull) {
    const dirName = sanitize(wf.name);
    const wfDir = path.join(workflowsDir, dirName);
    try {
      await pullWorkflow(client, wf.id, wfDir);
      manifest.workflows[dirName] = { id: wf.id, name: wf.name };
    } catch (e: any) {
      manifest.workflows[dirName] = { id: wf.id, name: `${wf.name} (pull failed: ${e.message})` };
    }
  }

  writeManifest(outputDir, manifest);

  // .gitignore
  fs.writeFileSync(
    path.join(outputDir, ".gitignore"),
    "node_modules/\n.DS_Store\n",
    "utf-8"
  );

  // GitHub Actions
  const ghDir = path.join(outputDir, ".github", "workflows");
  fs.mkdirSync(ghDir, { recursive: true });

  fs.writeFileSync(
    path.join(ghDir, "laminar-deploy.yml"),
    DEPLOY_YML,
    "utf-8"
  );

  fs.writeFileSync(
    path.join(ghDir, "laminar-preview.yml"),
    PREVIEW_YML,
    "utf-8"
  );

  // README
  fs.writeFileSync(
    path.join(outputDir, "README.md"),
    generateReadme(workspaceId, manifest),
    "utf-8"
  );

  return {
    projectDir: outputDir,
    workflowsPulled: Object.keys(manifest.workflows).length,
    manifest,
  };
}

export async function pullAll(
  client: LaminarClient,
  projectDir: string
): Promise<{
  pulled: Array<{ workflow: string; steps: number }>;
  errors: Array<{ workflow: string; error: string }>;
}> {
  const manifest = readManifest(projectDir);
  const workflowsDir = path.join(projectDir, "workflows");
  const pulled: Array<{ workflow: string; steps: number }> = [];
  const errors: Array<{ workflow: string; error: string }> = [];

  for (const [dirName, wf] of Object.entries(manifest.workflows)) {
    try {
      const result = await pullWorkflow(
        client,
        wf.id,
        path.join(workflowsDir, dirName)
      );
      pulled.push({ workflow: `${dirName} (${wf.id})`, steps: result.stepsWritten });
    } catch (e: any) {
      errors.push({ workflow: `${dirName} (${wf.id})`, error: e.message });
    }
  }

  return { pulled, errors };
}

export async function pushChanged(
  client: LaminarClient,
  projectDir: string
): Promise<{
  pushed: Array<{ workflow: string; steps: number; details: Array<{ step: string; action: string }> }>;
  unchanged: string[];
  errors: Array<{ workflow: string; error: string }>;
}> {
  const manifest = readManifest(projectDir);
  const workflowsDir = path.join(projectDir, "workflows");
  const pushed: Array<{ workflow: string; steps: number; details: Array<{ step: string; action: string }> }> = [];
  const unchanged: string[] = [];
  const errors: Array<{ workflow: string; error: string }> = [];

  for (const [dirName, wf] of Object.entries(manifest.workflows)) {
    const wfDir = path.join(workflowsDir, dirName);
    try {
      const status = await syncStatus(client, wfDir, wf.id);
      const hasChanges = status.changes.some((c) => c.status !== "unchanged");

      if (!hasChanges) {
        unchanged.push(`${dirName} (${wf.id})`);
        continue;
      }

      const result = await pushWorkflow(client, wfDir, wf.id);
      pushed.push({
        workflow: `${dirName} (${wf.id})`,
        steps: result.stepsPushed,
        details: result.details,
      });
    } catch (e: any) {
      errors.push({ workflow: `${dirName} (${wf.id})`, error: e.message });
    }
  }

  return { pushed, unchanged, errors };
}

// ── GitHub Action templates ──────────────────────────────────

const DEPLOY_YML = `name: Deploy Laminar Workflows

on:
  push:
    branches: [main]
    paths: ['workflows/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Deploy changed workflows
        env:
          LAMINAR_API_KEY: \${{ secrets.LAMINAR_API_KEY }}
        run: |
          npx @laminar/mcp-server push --changed
`;

const PREVIEW_YML = `name: Preview Laminar Changes

on:
  pull_request:
    paths: ['workflows/**']

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Diff workflows
        id: diff
        env:
          LAMINAR_API_KEY: \${{ secrets.LAMINAR_API_KEY }}
        run: |
          npx @laminar/mcp-server diff --json > diff-output.json

      - name: Comment PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            try {
              const diff = JSON.parse(fs.readFileSync('diff-output.json', 'utf8'));
              const body = ['## Laminar Workflow Changes', ''];
              for (const [wf, changes] of Object.entries(diff)) {
                body.push('### ' + wf);
                for (const c of changes) {
                  body.push('- **' + c.step + '**: ' + c.status);
                  if (c.diff) body.push('\\n' + '\`\`\`diff' + '\\n' + c.diff + '\\n' + '\`\`\`');
                }
              }
              await github.rest.issues.createComment({
                issue_number: context.issue.number,
                owner: context.repo.owner,
                repo: context.repo.repo,
                body: body.join('\\n')
              });
            } catch (e) {
              console.error('No diff output or error:', e.message);
            }
`;

function generateReadme(workspaceId: number, manifest: LaminarManifest): string {
  const wfList = Object.entries(manifest.workflows)
    .map(([dir, wf]) => `- \`workflows/${dir}/\` — ${wf.name} (ID: ${wf.id})`)
    .join("\n");

  return `# Laminar Workflows

This repository contains version-controlled [Laminar](https://laminar.run) workflows for workspace **${workspaceId}**.

## Workflows

${wfList}

## Setup

1. Add your \`LAMINAR_API_KEY\` as a repository secret in GitHub Settings > Secrets
2. Push to \`main\` to deploy, open PRs to preview changes

## Development

Edit step files directly in \`workflows/<name>/steps/\`. Each file is a standalone JS or Python function.

### Pull latest from Laminar

\`\`\`bash
npx @laminar/mcp-server pull --all
\`\`\`

### Push changes to Laminar

\`\`\`bash
npx @laminar/mcp-server push --changed
\`\`\`

### Check what's different

\`\`\`bash
npx @laminar/mcp-server diff
\`\`\`

## Structure

- \`laminar.json\` — Project manifest (workspace ID, workflow mappings)
- \`workflows/<name>/workflow.json\` — Step metadata (names, types, execution order)
- \`workflows/<name>/steps/\` — Individual step files (JS/Python)
- \`.github/workflows/\` — CI/CD automation
`;
}
