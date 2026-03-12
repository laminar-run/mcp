/**
 * Optional service configuration for Minicor MCP.
 *
 * Priority: env vars > config file (~/.minicor/config.json, falls back to ~/.laminar/config.json)
 */

import fs from "node:fs";
import path from "node:path";
import { getConfigPath, getWriteConfigPath } from "./paths.js";

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
    const cfgPath = getConfigPath();
    if (fs.existsSync(cfgPath)) {
      const file: ServiceConfig = JSON.parse(
        fs.readFileSync(cfgPath, "utf-8"),
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
  const writePath = getWriteConfigPath();
  const dir = path.dirname(writePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing: ServiceConfig = {};
  try {
    const readPath = getConfigPath();
    if (fs.existsSync(readPath)) {
      existing = JSON.parse(fs.readFileSync(readPath, "utf-8"));
    }
  } catch {}

  const merged = { ...existing, ...update };
  fs.writeFileSync(writePath, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
}
