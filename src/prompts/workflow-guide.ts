import type { ToolDeps } from "../types.js";

export function register({ server }: ToolDeps) {
  server.prompt(
    "laminar-workflow-guide",
    "Comprehensive guide for creating and editing Laminar workflows — step types, data access patterns, available libraries, and best practices",
    {},
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please use this Laminar platform specification when creating or editing workflows:

# Laminar Workflow Specification

## Step Structure
Every step is a JSON object with these fields:
- \`name\`: (string) Descriptive name
- \`description\`: (string) Detailed explanation
- \`program\`: (string) Code to execute (JS or Python)
- \`executionOrder\`: (integer) Position in workflow (starts at 1)
- \`flowType\`: (string) "HTTP_REQUEST", "GENERAL_FUNCTION", "SHELL_SCRIPT", "RPA"
- \`language\`: (string) "js" or "py" (NOTE: RPA flows must ALWAYS use "js")

## Program Signatures
**Python (py):**
\`\`\`python
def transform(data):
    # Your logic here
    return {}
\`\`\`

**JavaScript (js):**
\`\`\`javascript
(data) => {
    // Your code here
    return {};
}
\`\`\`

## Return Values by flowType

### HTTP_REQUEST
\`\`\`json
{
  "lam.httpRequest": {
    "method": "GET|POST|PUT|DELETE|PATCH",
    "url": "String",
    "headers": "Object (optional)",
    "pathParams": "Object (optional)",
    "queryParams": "Object (optional)",
    "body": "Object (optional)",
    "authentication": {
      "type": "basic|bearer|oauth2|apikey",
      "token": "{{config.token}}"
    },
    "retry": { "maxAttempts": "Number" },
    "pagination": {
      "next": { "queryParams": {}, "headers": {}, "body": {} },
      "stopCondition": "JS function receiving ctx",
      "maxPages": 10
    },
    "loopUntil": {
      "condition": "(ctx) => ctx.response.status === 'completed'",
      "maxAttempts": 20,
      "strategy": "exponential",
      "initialDelay": "2s",
      "maxDelay": "60s",
      "multiplier": 2
    }
  }
}
\`\`\`

Multiple requests: use \`"lam.httpRequests"\` (plural) with an array.

### SHELL_SCRIPT
\`\`\`json
{
  "lam.shell": {
    "script": "Bash script as string",
    "environment": {},
    "timeout": 300,
    "binaryDataIds": []
  }
}
\`\`\`

### RPA (Desktop Automation)
**IMPORTANT: Use the \`create_rpa_flow\` tool to save RPA steps.** It accepts your validated Python script and automatically wraps it in the correct JS format. You do NOT need to construct the wrapper yourself.

RPA flows internally use \`language: "js"\` with the Python embedded in a JS arrow function. Two dispatch patterns exist:
- **\`lam.httpRequest\`** (Cloudflare Tunnel — default) — sends the script to the VM via HTTP
- **\`lam.rpa\`** (channelId) — sends via pub/sub channel

The \`create_rpa_flow\` tool handles both patterns via the \`dispatchPattern\` parameter (default: \`cloudflare_tunnel\`).

**NEVER** save raw Python as the program for an RPA flow. **NEVER** manually construct the JS wrapper — use \`create_rpa_flow\`.

### Configuration Updates
\`\`\`json
{
  "lam.updateConfig": {
    "configurationId": "my-config",
    "properties": [{ "key": "k", "value": "v" }],
    "createIfNotExists": true,
    "configurationName": "Auto-generated Config"
  }
}
\`\`\`

### Redis Key-Value Store
\`\`\`json
{
  "lam.kvStore": {
    "operation": "set|get|delete|exists|list|increment|decrement|transaction",
    "key": "user:session:token",
    "value": {},
    "ttl": 3600,
    "redisUrl": "{{config.redisUrl}}"
  }
}
\`\`\`

### Cron Job Management
\`\`\`json
{
  "lam.cron": {
    "operation": "create|update|delete",
    "name": "Daily Report",
    "schedule": "0 0 9 * * *",
    "url": "https://api.laminar.run/workflow/execute/external/{id}?api_key=key",
    "body": {}
  }
}
\`\`\`

### Custom Response (lam.response)
\`\`\`json
{
  "lam.response": {
    "statusCode": 200,
    "message": "Success",
    "data": {},
    "error": { "code": "ERROR_CODE", "message": "Error description" }
  }
}
\`\`\`
Note: Workflow exits immediately when lam.response is encountered.

## Data Access Patterns
- \`data.input\`: Original workflow input
- \`data.step_N.response\`: HTTP request output from step N
- \`data.step_N.data\`: General function output from step N
- \`data.step_N.stdout\`: Shell output from step N
- \`data.step_N.stderr\`: Shell error from step N
- \`data.step_N.cronJobId\`: Cron job ID from step N
- \`data.step_N.response["lam.kvStore.value"]\`: KV store value
- \`data.step_N.response["lam.binaryDataId"]\`: File download reference

## Available Libraries
- **Python:** json, datetime, math, statistics, collections, itertools, functools, re, copy, decimal, csv, io, dataclasses, typing, enum
- **JavaScript:** lodash (as _), date-fns (format, parseISO)

## Security
Use \`{{config.variableName}}\` for sensitive values (API keys, tokens, passwords). These reference configuration store properties.

## Best Practices
1. **Minimize steps** — combine operations when logical, fewer steps = faster execution
2. **Don't JSON.stringify request bodies** — pass objects directly
3. **File downloads** auto-create \`lam.binaryDataId\` — don't process as text
4. **Use {{config.variables}}** for sensitive data, not hardcoded values
5. **Access errors** via \`data.step_N.response.error\` and \`data.step_N.response.statusCode\``,
          },
        },
      ],
    }),
  );
}
