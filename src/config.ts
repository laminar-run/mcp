/**
 * Optional service configuration for Laminar MCP.
 *
 * Priority: env vars > config file (~/.laminar/config.json)
 * Services that aren't configured just return a helpful "not configured" message.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_PATH = path.join(os.homedir(), ".laminar", "config.json");

export interface ElasticsearchConfig {
  endpoint: string;
  apiKey: string;
  indexName?: string;
}

export interface CronConfig {
  apiBase?: string;
  apiKey: string;
}

export interface ServiceConfig {
  elasticsearch?: ElasticsearchConfig;
  cron?: CronConfig;
}

export function loadServiceConfig(): ServiceConfig {
  const config: ServiceConfig = {};

  if (process.env.ELASTICSEARCH_ENDPOINT && process.env.ELASTICSEARCH_API_KEY) {
    config.elasticsearch = {
      endpoint: process.env.ELASTICSEARCH_ENDPOINT,
      apiKey: process.env.ELASTICSEARCH_API_KEY,
      indexName: process.env.ELASTICSEARCH_INDEX_NAME,
    };
  }

  if (process.env.CRON_API_KEY) {
    config.cron = {
      apiBase: process.env.CRON_API_BASE,
      apiKey: process.env.CRON_API_KEY,
    };
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const file: ServiceConfig = JSON.parse(
        fs.readFileSync(CONFIG_PATH, "utf-8")
      );
      if (!config.elasticsearch && file.elasticsearch) {
        config.elasticsearch = file.elasticsearch;
      }
      if (!config.cron && file.cron) {
        config.cron = file.cron;
      }
    }
  } catch {}

  return config;
}

export function saveServiceConfig(update: ServiceConfig) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing: ServiceConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {}

  const merged = { ...existing, ...update };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
}
