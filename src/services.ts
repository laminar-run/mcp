/**
 * Optional service clients: Elasticsearch + CRON.
 * Only instantiated when configured — otherwise tools degrade gracefully.
 */

import type { ElasticsearchConfig, CronConfig } from "./config.js";

const DEFAULT_ES_INDEX = "search-workflow-executions";
const DEFAULT_CRON_BASE = "https://cron.laminar.run";

// ── Elasticsearch ─────────────────────────────────────────────

export interface ESSearchParams {
  workspaceId: string;
  workflowId?: string;
  workflowIds?: string[];
  query?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  includeGlobalObject?: boolean;
  rawQuery?: string;
  fuzzy?: boolean;
  size?: number;
  from?: number;
}

export class ElasticsearchService {
  private endpoint: string;
  private apiKey: string;
  private indexName: string;

  constructor(config: ElasticsearchConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.indexName = config.indexName || DEFAULT_ES_INDEX;
  }

  private async esRequest(body: unknown): Promise<any> {
    const res = await fetch(
      `${this.endpoint}/${this.indexName}/_search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Elasticsearch (${res.status}): ${err}`);
    }
    return res.json();
  }

  async search(params: ESSearchParams) {
    const {
      workspaceId,
      workflowId,
      workflowIds,
      query,
      startDate,
      endDate,
      status,
      includeGlobalObject = false,
      rawQuery,
      fuzzy = false,
      size = 20,
      from = 0,
    } = params;

    let searchBody: any;

    if (rawQuery) {
      const parsed = JSON.parse(rawQuery);
      if (!parsed.query) parsed.query = { bool: { must: [] } };
      if (!parsed.query.bool)
        parsed.query = { bool: { must: [parsed.query] } };
      if (!parsed.query.bool.must) parsed.query.bool.must = [];
      if (!JSON.stringify(parsed).includes(`"workspaceId":"${workspaceId}"`)) {
        parsed.query.bool.must.push({ term: { workspaceId } });
      }
      searchBody = { ...parsed, size, from };
    } else {
      const esQuery: any = {
        bool: { must: [{ term: { workspaceId } }], filter: [] },
      };

      if (workflowId) {
        esQuery.bool.must.push({ term: { workflowId } });
      } else if (workflowIds?.length) {
        esQuery.bool.must.push({ terms: { workflowId: workflowIds } });
      }

      if (status) esQuery.bool.must.push({ term: { status } });

      if (startDate || endDate) {
        const range: any = {};
        if (startDate) range.gte = startDate;
        if (endDate) range.lte = endDate;
        esQuery.bool.filter.push({ range: { startedAt: range } });
      }

      if (query?.trim()) {
        const q = query.trim();
        const nested = {
          nested: {
            path: "flows",
            query: {
              multi_match: {
                query: q,
                fields: [
                  "flows.log^4",
                  "flows.response^3",
                  "flows.program^2",
                  "flows.transformation^2",
                  "flows.flowName^3",
                ],
                type: "best_fields",
                operator: fuzzy ? "OR" : "AND",
                ...(fuzzy ? { fuzziness: "AUTO" } : {}),
              },
            },
            inner_hits: {
              size: 10,
              highlight: {
                fields: {
                  "flows.log": { fragment_size: 300, number_of_fragments: 3 },
                  "flows.response": {
                    fragment_size: 200,
                    number_of_fragments: 2,
                  },
                  "flows.program": {
                    fragment_size: 150,
                    number_of_fragments: 1,
                  },
                  "flows.transformation": {
                    fragment_size: 150,
                    number_of_fragments: 1,
                  },
                },
                pre_tags: [">>"],
                post_tags: ["<<"],
              },
            },
          },
        };

        if (includeGlobalObject) {
          esQuery.bool.must.push({
            bool: {
              should: [
                nested,
                {
                  match: {
                    globalJson: {
                      query: q,
                      operator: fuzzy ? "OR" : "AND",
                      ...(fuzzy ? { fuzziness: "AUTO" } : {}),
                      boost: 1,
                    },
                  },
                },
              ],
              minimum_should_match: 1,
            },
          });
        } else {
          esQuery.bool.must.push(nested);
        }
      }

      searchBody = {
        query: esQuery,
        sort: ["_score", { startedAt: { order: "desc" } }],
        size,
        from,
      };
    }

    const data = await this.esRequest(searchBody);

    // Retry without highlighting on shard failures
    if (
      data._shards?.failed > 0 &&
      !data.hits?.hits?.length &&
      (data.hits?.total?.value || 0) > 0
    ) {
      try {
        const retry = await this.esRequest({
          ...searchBody,
          highlight: undefined,
        });
        if (retry.hits?.hits?.length) {
          return this.formatResults(retry, true);
        }
      } catch {}
    }

    return this.formatResults(data, false);
  }

  private formatResults(data: any, noHighlight: boolean) {
    return {
      hits: (data.hits?.hits || []).map((hit: any) => ({
        id: hit._id,
        score: hit._score,
        workflowId: hit._source?.workflowId,
        workflowName: hit._source?.workflowName,
        executionId: hit._source?.executionId,
        status: hit._source?.status,
        startedAt: hit._source?.startedAt,
        endedAt: hit._source?.endedAt,
        highlight: hit.highlight || {},
        inner_hits: hit.inner_hits || {},
      })),
      total: data.hits?.total?.value || data.hits?.total || 0,
      took: data.took,
      ...(noHighlight && {
        warning: "Results loaded without highlighting due to large fields",
      }),
      ...(data._shards?.failed > 0 &&
        !noHighlight && {
          warning: "Some results may be missing due to large field values",
        }),
    };
  }
}

// ── CRON ──────────────────────────────────────────────────────

export class CronService {
  private apiBase: string;
  private apiKey: string;

  constructor(config: CronConfig) {
    this.apiBase = (config.apiBase || DEFAULT_CRON_BASE).replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    data?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}/${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let msg: string;
      try {
        msg = JSON.parse(errText).error || errText;
      } catch {
        msg = errText;
      }
      throw new Error(
        msg || `CRON API ${method} ${endpoint} failed (${res.status})`
      );
    }

    if (method === "DELETE") return true as unknown as T;
    return res.json();
  }

  async listJobs(workflowId?: string) {
    if (workflowId) {
      const d = await this.request<{ jobs: any[] }>(
        "GET",
        `api/workflows/${workflowId}/jobs`
      );
      return d.jobs || [];
    }
    const d = await this.request<{ jobs: any[] }>("GET", "api/jobs");
    return d.jobs || [];
  }

  async getJob(jobId: string) {
    const d = await this.request<{ job: any }>("GET", `api/jobs/${jobId}`);
    return d.job;
  }

  async createJob(job: {
    name: string;
    schedule: string;
    url: string;
    body?: Record<string, any>;
    enabled?: boolean;
    max_runs?: number | null;
    is_temporary?: boolean;
  }) {
    const d = await this.request<{ job_id: string }>(
      "POST",
      "api/jobs",
      job
    );
    return this.getJob(d.job_id);
  }

  async updateJob(
    jobId: string,
    updates: {
      name?: string;
      schedule?: string;
      url?: string;
      body?: Record<string, any>;
      enabled?: boolean;
    }
  ) {
    const d = await this.request<{ job: any }>(
      "PUT",
      `api/jobs/${jobId}`,
      updates
    );
    return d.job;
  }

  async toggleJob(jobId: string) {
    const cur = await this.getJob(jobId);
    return this.updateJob(jobId, { enabled: !cur.enabled });
  }

  async deleteJob(jobId: string) {
    await this.request<void>("DELETE", `api/jobs/${jobId}`);
  }

  async triggerJob(jobId: string) {
    await this.request<void>("POST", `api/jobs/${jobId}/trigger`);
  }
}
