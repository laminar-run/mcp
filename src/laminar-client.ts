/**
 * Laminar API Client
 * Wraps the Laminar REST API for use by the MCP server.
 */

const DEFAULT_BASE_URL = "https://api.laminar.run";

export interface LaminarAuth {
  type: "bearer" | "apiKey";
  token: string;
}

export class LaminarClient {
  private auth: LaminarAuth;
  private baseUrl: string;

  constructor(auth: LaminarAuth, baseUrl?: string) {
    this.auth = auth;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.auth.type === "bearer") {
      h["Authorization"] = `Bearer ${this.auth.token}`;
    } else {
      h["X-API-KEY"] = this.auth.token;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (queryParams) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null) {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Laminar API ${method} ${path} failed (${res.status}): ${text}`
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (res.status === 204) return undefined as T;
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return (await res.text()) as T;
  }

  // ── Auth ──────────────────────────────────────────────────
  async signIn(username: string, password: string) {
    return this.request<{
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token?: string;
    }>("POST", "/auth/signin", { username, password });
  }

  async getMe() {
    return this.request<{
      id: number;
      firstName: string;
      lastName: string;
      email: string;
      isEmailDomainActive: boolean;
    }>("GET", "/auth/me");
  }

  // ── Workspaces ────────────────────────────────────────────
  async listWorkspaces() {
    return this.request<any>("GET", "/workspaces");
  }

  async getWorkspace(id: number) {
    return this.request<{ id: number; name: string }>("GET", `/workspaces/${id}`);
  }

  async getWorkspaceUsers(workspaceId: number) {
    return this.request<any>("GET", `/workspaces/${workspaceId}/users`);
  }

  // ── Workflows ─────────────────────────────────────────────
  async listWorkflows(workspaceId: number) {
    return this.request<any>(
      "GET",
      `/workspaces/${workspaceId}/workflows`
    );
  }

  async listArchivedWorkflows(workspaceId: number) {
    return this.request<any>(
      "GET",
      `/workspaces/${workspaceId}/workflows/archived`
    );
  }

  async getWorkflow(id: number) {
    return this.request<{
      id: number;
      name: string;
      description: string;
      createdAt: string;
      archivedAt?: string;
    }>("GET", `/workflow/${id}`);
  }

  async createWorkflow(data: {
    name: string;
    description: string;
    workspaceId: number;
  }) {
    return this.request<any>("POST", "/workflow", data);
  }

  async updateWorkflow(data: {
    workflowId: number;
    name?: string;
    description?: string;
  }) {
    return this.request<any>("PUT", "/workflow", data);
  }

  async deleteWorkflow(id: number) {
    return this.request<void>("DELETE", `/workflow/${id}`);
  }

  async restoreWorkflow(id: number) {
    return this.request<any>("POST", `/workflow/${id}/restore`);
  }

  async cloneWorkflow(id: number, data: { name: string; workspaceId?: number }) {
    return this.request<any>("POST", `/workflow/${id}/clone`, data);
  }

  // ── Flows (Steps) ────────────────────────────────────────
  async listFlows(workspaceId: number) {
    return this.request<any>("GET", `/workspaces/${workspaceId}/flows`);
  }

  async getWorkflowFlows(workflowId: number) {
    return this.request<any>("GET", `/workflow/${workflowId}/flows`);
  }

  async getFlow(id: number) {
    return this.request<any>("GET", `/flows/${id}`);
  }

  async readFlow(id: number) {
    return this.request<any>("GET", `/flows/read/${id}`);
  }

  async createFlow(data: {
    workflowId: number;
    name: string;
    description: string;
    program: string;
    executionOrder: number;
    language: string;
    flowType: string;
  }) {
    return this.request<any>("POST", "/flows", data);
  }

  async createOrUpdateFlows(
    workflowId: number,
    flows: Array<{
      workflowId: number;
      name: string;
      description: string;
      program: string;
      executionOrder: number;
      language: string;
      flowType: string;
    }>
  ) {
    return this.request<any>(
      "POST",
      `/workflow/${workflowId}/flows`,
      flows
    );
  }

  async updateFlow(data: {
    flowId: number;
    name?: string;
    description?: string;
    program?: string;
    language?: string;
  }) {
    return this.request<any>("PUT", "/flows", data);
  }

  async deleteFlow(id: number) {
    return this.request<void>("DELETE", `/flows/${id}`);
  }

  async getFlowVersions(flowId: number) {
    return this.request<any>("GET", `/flows/${flowId}/versions`);
  }

  async readFlowVersion(flowId: number, versionId: number) {
    return this.request<any>(
      "GET",
      `/flows/${flowId}/versions/${versionId}`
    );
  }

  // ── Executions ────────────────────────────────────────────
  async listExecutions(
    workflowId: number,
    params?: {
      page?: number;
      size?: number;
      startDate?: string;
      endDate?: string;
      search?: string;
      configurationId?: number | string;
      status?: string;
      sortDirection?: string;
    }
  ) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions`,
      undefined,
      params as Record<string, string | number | boolean | undefined>
    );
  }

  async getExecution(workflowId: number, executionId: number) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}`
    );
  }

  async getExecutionStatus(workflowId: number, executionId: number) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/status`
    );
  }

  async getExecutionResult(workflowId: number, executionId: number) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/result`
    );
  }

  async getFullExecution(workflowId: number, executionId: number) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/full`
    );
  }

  async getGlobalWorkflowObject(workflowId: number, executionId: number) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/global-workflow-object`
    );
  }

  async getFlowRunTransformation(
    workflowId: number,
    executionId: number,
    flowRunId: number
  ) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/flows/${flowRunId}/transformation`
    );
  }

  async getFlowRunResponse(
    workflowId: number,
    executionId: number,
    flowRunId: number
  ) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/flows/${flowRunId}/response`
    );
  }

  async getFlowRunProgram(
    workflowId: number,
    executionId: number,
    flowRunId: number
  ) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/executions/${executionId}/flows/${flowRunId}/program`
    );
  }

  async executeWorkflow(
    workflowId: number,
    body?: unknown,
    params?: {
      configuration_id?: number | string;
      start_from_step?: number;
      end_at_step?: number;
    }
  ) {
    return this.request<any>(
      "POST",
      `/workflow/execute/${workflowId}`,
      body,
      params as Record<string, string | number | boolean | undefined>
    );
  }

  async executeWorkflowAsync(
    workflowId: number,
    body?: unknown,
    params?: {
      configuration_id?: number | string;
      start_from_step?: number;
      end_at_step?: number;
    }
  ) {
    return this.request<any>(
      "POST",
      `/workflow/execute/${workflowId}/async`,
      body,
      params as Record<string, string | number | boolean | undefined>
    );
  }

  // ── Conversations ─────────────────────────────────────────
  async listConversations(workflowId: number) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/conversations`
    );
  }

  async getConversationMessages(
    workflowId: number,
    conversationId: number
  ) {
    return this.request<any>(
      "GET",
      `/workflow/${workflowId}/conversations/${conversationId}/messages`
    );
  }

  // ── Configuration Stores ──────────────────────────────────
  async listConfigStores(workspaceId: number) {
    return this.request<any>(
      "GET",
      `/configurations/workspace/${workspaceId}`
    );
  }

  async listArchivedConfigStores(workspaceId: number) {
    return this.request<any>(
      "GET",
      `/configurations/workspace/${workspaceId}/archived`
    );
  }

  async getConfigStore(externalId: string, workspaceId: number) {
    return this.request<any>("GET", `/configurations/${externalId}`, undefined, {
      workspaceId,
    });
  }

  async getConfigProperties(externalId: string, workspaceId: number) {
    return this.request<any>(
      "GET",
      `/configurations/${externalId}/properties`,
      undefined,
      { workspaceId }
    );
  }

  async getConfigProperty(
    externalId: string,
    key: string,
    workspaceId: number
  ) {
    return this.request<any>(
      "GET",
      `/configurations/${externalId}/properties/${key}`,
      undefined,
      { workspaceId }
    );
  }

  async updateConfigProperty(
    externalId: string,
    workspaceId: number,
    property: { key: string; value: string }
  ) {
    return this.request<any>(
      "PUT",
      `/configurations/${externalId}/properties`,
      property,
      { workspaceId }
    );
  }

  async removeConfigProperty(
    externalId: string,
    key: string,
    workspaceId: number
  ) {
    return this.request<void>(
      "DELETE",
      `/configurations/${externalId}/properties/${key}`,
      undefined,
      { workspaceId }
    );
  }

  async createConfigStore(data: {
    workspaceId: number;
    name: string;
    externalId: string;
    properties: Array<{ key: string; value: string }>;
  }) {
    return this.request<any>("POST", "/configurations", data);
  }

  async deleteConfigStore(externalId: string, workspaceId: number) {
    return this.request<void>(
      "DELETE",
      `/configurations/${externalId}`,
      undefined,
      { workspaceId }
    );
  }

  async restoreConfigStore(externalId: string, workspaceId: number) {
    return this.request<any>(
      "PUT",
      `/configurations/${externalId}/restore`,
      undefined,
      { workspaceId }
    );
  }

  // ── Issues ────────────────────────────────────────────────
  async listIssues(workspaceId: number) {
    return this.request<any>(
      "GET",
      `/workspaces/${workspaceId}/issues`
    );
  }

  async getIssue(workspaceId: number, issueId: number) {
    return this.request<any>(
      "GET",
      `/workspaces/${workspaceId}/issues/${issueId}`
    );
  }

  async createIssue(
    workspaceId: number,
    data: { title: string; description: string; assignedUserId?: number }
  ) {
    return this.request<any>(
      "POST",
      `/workspaces/${workspaceId}/issues`,
      data
    );
  }

  async updateIssue(
    workspaceId: number,
    issueId: number,
    data: {
      title?: string;
      description?: string;
      status?: string;
      assignedUserId?: number;
    }
  ) {
    return this.request<any>(
      "PUT",
      `/workspaces/${workspaceId}/issues/${issueId}`,
      data
    );
  }

  async deleteIssue(workspaceId: number, issueId: number) {
    return this.request<void>(
      "DELETE",
      `/workspaces/${workspaceId}/issues/${issueId}`
    );
  }

  // ── API Keys ──────────────────────────────────────────────
  async listApiKeys(workspaceId: number) {
    return this.request<any>(
      "GET",
      `/workspaces/${workspaceId}/api-keys`
    );
  }

  // ── Flow Stats ────────────────────────────────────────────
  async getFlowStats(workspaceId: number, days?: number) {
    return this.request<any>("GET", "/flows/stats", undefined, {
      workspaceId,
      days,
    });
  }

  async getRecentFlowRuns(workspaceId: number, limit?: number) {
    return this.request<any>("GET", "/flows/recent-runs", undefined, {
      workspaceId,
      limit,
    });
  }
}
