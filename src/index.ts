#!/usr/bin/env node

/**
 * Minicor MCP Server (formerly Laminar)
 *
 * Brings your Minicor workspace into Cursor / Claude Code.
 * Core tools always available; Elasticsearch + CRON unlock with advanced setup.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { loadServiceConfig } from "./config.js";
import { LaminarClient, type LaminarAuth } from "./laminar-client.js";
import {
  getTokenPath,
  getWriteTokenPath,
  regionToApiBase,
  apiBaseToRegion,
  type Region,
} from "./paths.js";
import { CronService, ElasticsearchService } from "./services.js";
import type { ToolDeps } from "./types.js";

import { register as registerCore } from "./tools/core.js";
import { register as registerWorkflowOps } from "./tools/workflow-ops.js";
import { register as registerConfigStores } from "./tools/config-stores.js";
import { register as registerIssues } from "./tools/issues.js";
import { register as registerStats } from "./tools/stats.js";
import { register as registerElasticsearch } from "./tools/elasticsearch.js";
import { register as registerCron } from "./tools/cron.js";
import { register as registerSyncTools } from "./tools/sync-tools.js";
import { register as registerVm } from "./tools/vm.js";
import { register as registerVmRpa } from "./tools/vm-rpa.js";
import { register as registerBrowser } from "./tools/browser.js";

import { register as registerWorkflowGuide } from "./prompts/workflow-guide.js";
import { register as registerDebugExecution } from "./prompts/debug-execution.js";
import { register as registerBuildRpa } from "./prompts/build-rpa.js";
import { register as registerBuildBrowserRpa } from "./prompts/build-browser-rpa.js";

// ─── Token management ────────────────────────────────────────

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  api_base?: string;
  region?: Region;
}

function readStoredTokens(): StoredTokens | null {
  try {
    const tokenPath = getTokenPath();
    if (!fs.existsSync(tokenPath)) return null;
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens: StoredTokens) {
  const writePath = getWriteTokenPath();
  const dir = path.dirname(writePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(tokens, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function getApiBase(): string {
  const stored = readStoredTokens();
  if (stored?.region) return regionToApiBase(stored.region);
  if (stored?.api_base) return stored.api_base;
  return regionToApiBase("us");
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<StoredTokens | null> {
  const base = getApiBase();
  try {
    const res = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
      api_base: base,
      region: apiBaseToRegion(base),
    };
  } catch {
    return null;
  }
}

async function getValidToken(): Promise<string> {
  const tokens = readStoredTokens();
  if (!tokens) throw new Error("No stored tokens");

  if (Date.now() < tokens.expires_at - REFRESH_BUFFER_MS) {
    return tokens.access_token;
  }

  if (tokens.refresh_token) {
    console.error("Refreshing access token...");
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    if (refreshed) {
      writeStoredTokens(refreshed);
      console.error("Token refreshed.");
      return refreshed.access_token;
    }
  }

  console.error(
    "Warning: Token expired and refresh failed. Run `minicor-mcp-setup` to re-authenticate.",
  );
  return tokens.access_token;
}

// ─── Resolve auth ────────────────────────────────────────────

async function resolveAuth(): Promise<{ auth: LaminarAuth; baseUrl: string }> {
  const baseUrl = getApiBase();
  const stored = readStoredTokens();
  if (stored) {
    const token = await getValidToken();
    return { auth: { type: "bearer", token }, baseUrl };
  }

  console.error(
    "Not authenticated. Run `minicor-mcp-setup` to sign in or create an account.",
  );
  process.exit(1);
}

// ─── Server state ────────────────────────────────────────────

let client: LaminarClient;
let esService: ElasticsearchService | null = null;
let cronService: CronService | null = null;

const server = new McpServer({
  name: "minicor",
  version: "2.0.0",
});

function scheduleTokenRefresh() {
  const tokens = readStoredTokens();
  if (!tokens?.refresh_token) return;

  const msUntilRefresh = Math.max(
    tokens.expires_at - REFRESH_BUFFER_MS - Date.now(),
    60_000,
  );

  setTimeout(async () => {
    try {
      const token = await getValidToken();
      client = new LaminarClient({ type: "bearer", token }, getApiBase());
      console.error("Token auto-refreshed, client updated.");
    } catch (e: any) {
      console.error("Auto-refresh failed:", e.message);
    }
    scheduleTokenRefresh();
  }, msUntilRefresh);
}

// ─── Register all tools and prompts ──────────────────────────

function registerAll() {
  const deps: ToolDeps = {
    server,
    client: () => client,
    getApiBase,
    esService: () => esService,
    cronService: () => cronService,
  };

  registerCore(deps);
  registerWorkflowOps(deps);
  registerConfigStores(deps);
  registerIssues(deps);
  registerStats(deps);
  registerElasticsearch(deps);
  registerCron(deps);
  registerSyncTools(deps);
  registerVm(deps);
  registerVmRpa(deps);
  registerBrowser(deps);

  registerWorkflowGuide(deps);
  registerDebugExecution(deps);
  registerBuildRpa(deps);
  registerBuildBrowserRpa(deps);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const { auth, baseUrl } = await resolveAuth();
  client = new LaminarClient(auth, baseUrl);
  scheduleTokenRefresh();

  const svcConfig = loadServiceConfig();

  if (svcConfig.elasticsearch) {
    esService = new ElasticsearchService(svcConfig.elasticsearch);
    console.error("Elasticsearch: configured");
  } else {
    console.error("Elasticsearch: not configured (log search disabled)");
  }

  if (svcConfig.cron) {
    cronService = new CronService(svcConfig.cron);
    console.error("CRON service: configured");
  } else {
    console.error("CRON service: not configured (scheduling disabled)");
  }

  registerAll();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Minicor MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
