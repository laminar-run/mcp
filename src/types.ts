/**
 * Shared types for tool module registration.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LaminarClient } from "./laminar-client.js";
import type { ElasticsearchService, CronService } from "./services.js";

export interface ToolDeps {
  server: McpServer;
  client: () => LaminarClient;
  getApiBase: () => string;
  esService: () => ElasticsearchService | null;
  cronService: () => CronService | null;
}
