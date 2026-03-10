/**
 * Stateless HTTP client for the Laminar Desktop Service (LDS).
 *
 * Every method receives the base URL (Cloudflare Tunnel) and optional auth
 * credentials so the caller (tool handler) can pull them from session state.
 */

export interface LdsAuth {
  apiKey: string;
  serviceId: string;
}

export interface LdsHealthResponse {
  status: string;
  version: string;
  uptime: number;
}

export interface LdsScreenshotResponse {
  success: boolean;
  image: string;
  metadata: {
    width: number;
    height: number;
    format: string;
    mime_type: string;
    size_bytes: number;
    timestamp: string;
    capture_duration_ms: number;
  };
}

export interface LdsExecuteOptions {
  executionId?: string | number;
  flowId?: string;
  messageId?: string;
}

export interface LdsExecuteResponse {
  success: boolean;
  skipped: boolean;
  stopped: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  executionId?: string;
  jobId?: string;
  resultData?: Record<string, unknown>;
}

export interface LdsExecutionStatusResponse {
  success: boolean;
  active: boolean;
  state: string;
  pauseNext: boolean;
  currentExecutionId?: string;
  stoppedExecutionIds?: string[];
  currentIndex: number;
  totalStatements: number;
  statementsExecuted: number;
  statementsSkipped: number;
  current?: Record<string, unknown>;
  next?: Record<string, unknown>;
}

export interface LdsExecutionProgressResponse {
  success: boolean;
  active: boolean;
  state: string;
  currentIndex: number;
  totalStatements: number;
  statementsExecuted: number;
  statementsSkipped: number;
  current?: Record<string, unknown>;
  next?: Record<string, unknown>;
}

export interface LdsControlResponse {
  success: boolean;
  command: string;
  state: string;
  progress?: Record<string, unknown>;
  pauseNext?: boolean;
  countdown?: boolean;
  error?: string;
}

export interface LdsRecentExecution {
  ts_ms: number;
  source: string;
  executionId: number;
  flowId: string;
  jobId: string;
  success: boolean;
  exitCode: number;
  statusCode: number;
  durationMs: number;
  error?: string;
  messageId?: string;
  client?: string;
}

function authHeaders(auth?: LdsAuth): Record<string, string> {
  if (!auth) return {};
  return {
    "X-API-Key": auth.apiKey,
    "X-Service-ID": auth.serviceId,
  };
}

function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

async function request<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `LDS ${init?.method ?? "GET"} ${url} returned ${res.status}: ${body}`
    );
  }
  return res.json() as Promise<T>;
}

export async function health(baseUrl: string): Promise<LdsHealthResponse> {
  const url = `${normalizeUrl(baseUrl)}/health`;
  return request<LdsHealthResponse>(url);
}

export async function screenshot(
  baseUrl: string,
  auth?: LdsAuth
): Promise<LdsScreenshotResponse> {
  const url = `${normalizeUrl(baseUrl)}/screenshot`;
  return request<LdsScreenshotResponse>(url, {
    headers: { "Content-Type": "application/json", ...authHeaders(auth) },
  });
}

export async function execute(
  baseUrl: string,
  script: string,
  opts?: LdsExecuteOptions,
  auth?: LdsAuth
): Promise<LdsExecuteResponse> {
  const url = `${normalizeUrl(baseUrl)}/execute`;
  return request<LdsExecuteResponse>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({
      script,
      executionId: opts?.executionId ?? Date.now(),
      flowId: opts?.flowId ?? `mcp-${crypto.randomUUID()}`,
      messageId: opts?.messageId,
    }),
  });
}

export async function executionStatus(
  baseUrl: string
): Promise<LdsExecutionStatusResponse> {
  const url = `${normalizeUrl(baseUrl)}/execute/status`;
  return request<LdsExecutionStatusResponse>(url);
}

export async function executionProgress(
  baseUrl: string
): Promise<LdsExecutionProgressResponse> {
  const url = `${normalizeUrl(baseUrl)}/execute/progress`;
  return request<LdsExecutionProgressResponse>(url);
}

export async function executionControl(
  baseUrl: string,
  command: "pause" | "resume" | "stop" | "skip"
): Promise<LdsControlResponse> {
  const url = `${normalizeUrl(baseUrl)}/execute/control`;
  return request<LdsControlResponse>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
}

export async function recentExecutions(
  baseUrl: string,
  opts?: { limit?: number; source?: "execute" | "pubsub" },
  auth?: LdsAuth
): Promise<{ success: boolean; executions: LdsRecentExecution[] }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.source) params.set("source", opts.source);
  const qs = params.toString();
  const url = `${normalizeUrl(baseUrl)}/executions/recent${qs ? `?${qs}` : ""}`;
  return request(url, {
    headers: { "Content-Type": "application/json", ...authHeaders(auth) },
  });
}
