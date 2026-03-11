/**
 * Stateless HTTP client for Browser RPA sessions.
 *
 * Matches the session-based API pattern from Sully QA workspace:
 *   POST /sessions           → create session
 *   POST /sessions/:id/act   → send action
 *   POST /sessions/:id/extract → extract data
 *   GET  /sessions/:id/screenshot → screenshot
 *   DELETE /sessions/:id     → close session
 */

export interface BrowserAuth {
  bearerToken: string;
}

export interface BrowserSessionResponse {
  sessionId: string;
  [key: string]: unknown;
}

export interface BrowserActResponse {
  success?: boolean;
  result?: unknown;
  [key: string]: unknown;
}

export interface BrowserExtractResponse {
  success?: boolean;
  data?: unknown;
  [key: string]: unknown;
}

export interface BrowserScreenshotResponse {
  image?: string;
  screenshot?: string;
  [key: string]: unknown;
}

function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

function authHeaders(auth: BrowserAuth): Record<string, string> {
  return {
    "Authorization": `Bearer ${auth.bearerToken}`,
    "Content-Type": "application/json",
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Browser RPA ${init?.method ?? "GET"} ${url} returned ${res.status}: ${body}`,
    );
  }
  return res.json() as Promise<T>;
}

export async function createSession(
  baseUrl: string,
  auth: BrowserAuth,
  opts?: { slackChannelId?: string },
): Promise<BrowserSessionResponse> {
  const url = `${normalizeUrl(baseUrl)}/sessions`;
  return request<BrowserSessionResponse>(url, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify(opts?.slackChannelId ? { slackChannelId: opts.slackChannelId } : {}),
  });
}

export async function act(
  baseUrl: string,
  sessionId: string,
  message: string,
  auth: BrowserAuth,
): Promise<BrowserActResponse> {
  const url = `${normalizeUrl(baseUrl)}/sessions/${sessionId}/act`;
  return request<BrowserActResponse>(url, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ message }),
  });
}

export async function extract(
  baseUrl: string,
  sessionId: string,
  instructions: string,
  auth: BrowserAuth,
): Promise<BrowserExtractResponse> {
  const url = `${normalizeUrl(baseUrl)}/sessions/${sessionId}/extract`;
  return request<BrowserExtractResponse>(url, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ instructions }),
  });
}

export async function screenshot(
  baseUrl: string,
  sessionId: string,
  auth: BrowserAuth,
): Promise<BrowserScreenshotResponse> {
  const url = `${normalizeUrl(baseUrl)}/sessions/${sessionId}/screenshot`;
  return request<BrowserScreenshotResponse>(url, {
    headers: { "Authorization": `Bearer ${auth.bearerToken}` },
  });
}

export async function closeSession(
  baseUrl: string,
  sessionId: string,
  auth: BrowserAuth,
): Promise<{ closed: boolean }> {
  const url = `${normalizeUrl(baseUrl)}/sessions/${sessionId}`;
  await request(url, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${auth.bearerToken}` },
  });
  return { closed: true };
}
