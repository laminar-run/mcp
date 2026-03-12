/**
 * Shared MCP response helpers and error message constants.
 */

export function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: json(data) }] };
}

export function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

export async function safe<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e: any) {
    return text(`Error: ${e.message}`);
  }
}

export const NOT_CONFIGURED_ES = `Elasticsearch is not configured. Log search requires ES credentials.

**Option 1 — Environment variables:**
  ELASTICSEARCH_ENDPOINT=https://your-es-cluster
  ELASTICSEARCH_API_KEY=your-api-key
  ELASTICSEARCH_INDEX_NAME=search-workflow-executions (optional)

**Option 2 — Config file** (~/.laminar/config.json):
  {
    "elasticsearch": {
      "endpoint": "https://your-es-cluster",
      "apiKey": "your-api-key"
    }
  }

**Option 3 — Run setup:** laminar-mcp-setup → Advanced Settings`;

export const NOT_CONFIGURED_CRON = `CRON service is not configured. Scheduling requires CRON credentials.

**Option 1 — Environment variables:**
  CRON_API_KEY=your-cron-api-key
  CRON_API_BASE=https://cron.laminar.run (optional)

**Option 2 — Config file** (~/.laminar/config.json):
  {
    "cron": {
      "apiKey": "your-cron-api-key"
    }
  }

**Option 3 — Run setup:** laminar-mcp-setup → Advanced Settings`;

export const NOT_CONNECTED_VM = `No VM connected. Ask the user for their Cloudflare Tunnel URL for the Laminar Desktop Service, then call vm_connect.`;

export const NOT_CONNECTED_BROWSER = `No browser RPA service connected. Call browser_connect with the service base URL and bearer token first.`;

export function buildRpaProgram(
  pythonScript: string,
  pattern: "cloudflare_tunnel" | "channel",
  flowId: string,
  stepName: string,
  stepDescription: string,
): string {
  const escaped = pythonScript.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  if (pattern === "channel") {
    return `(data) => {
  const pythonScript = \`
${escaped}
\`;
  return {
    "lam.rpa": {
      "script": pythonScript,
      "channelId": "{{config.channelId}}"
    }
  };
}`;
  }
  return `(data) => {
  const pythonScript = \`
${escaped}
\`;
  return {
    "lam.httpRequest": {
      "method": "POST",
      "url": "{{config.laminar_desktop_service_url}}/execute",
      "headers": {
        "Content-Type": "application/json",
        "X-API-Key": "{{config.laminar_desktop_service_api_key}}",
        "X-Service-ID": "{{config.laminar_desktop_service_id}}"
      },
      "body": {
        "flowId": "${flowId}",
        "script": pythonScript,
        "executionId": "1",
        "step": { "id": "${flowId}", "name": "${stepName.replace(/"/g, '\\"')}", "description": "${stepDescription.replace(/"/g, '\\"')}", "versionId": "v1.0" }
      }
    }
  };
}`;
}
