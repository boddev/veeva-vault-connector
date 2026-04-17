/**
 * Connector configuration — environment-driven settings for the Veeva Vault Unified Connector.
 *
 * Supports all three Vault applications: PromoMats, QualityDocs, RIM.
 * The VAULT_APPLICATION env var selects which application profile to use.
 */

import { VaultApplication, isValidApplication, getAppProfile } from "./appProfiles";

export type GraphApiVersion = "v1.0" | "beta";

export interface ConnectorConfig {
  // Vault application
  vaultApplication: VaultApplication;

  // Veeva Vault
  vaultDns: string;
  apiVersion: string;
  username: string;
  password: string;

  // Connector (derived from app profile, overridable via env)
  connectorId: string;
  connectorName: string;
  connectorDescription: string;

  // Microsoft Graph API version (v1.0 or beta)
  graphApiVersion: GraphApiVersion;

  // Crawl
  fullCrawlSchedule: string;
  incrementalCrawlSchedule: string;
  crawlBatchSize: number;
  autoDiscoverObjects: boolean;
  fullCrawlDays: number[];        // 0=Sun, 6=Sat. Empty = every day
  progressBatchSize: number;      // How often to checkpoint progress (items per batch)
  crawlTimeBudgetMs: number;      // Max ms per crawl chunk before pausing for timer resume
  crawlConcurrency: number;       // Number of documents to process concurrently (default: 10)
  fullCrawlFetchContent: boolean; // Whether to download document text during full crawl (default: false)

  // Azure
  storageConnectionString: string;
  crawlStateTable: string;
  azureClientId: string;
  azureClientSecret: string;
  azureTenantId: string;
}

export function loadConfig(): ConnectorConfig {
  const appValue = (process.env.VAULT_APPLICATION || "promomats").toLowerCase();
  if (!isValidApplication(appValue)) {
    throw new Error(
      `Invalid VAULT_APPLICATION: '${appValue}'. Must be one of: promomats, qualitydocs, rim`
    );
  }

  const graphApiVersion = parseGraphApiVersion(process.env.GRAPH_API_VERSION);
  const profile = getAppProfile(appValue);
  const crawlBatchSize = parsePositiveIntegerEnv("CRAWL_BATCH_SIZE", 25);

  return {
    vaultApplication: appValue,

    vaultDns: requireEnv("VEEVA_VAULT_DNS").replace(/\/+$/, ""),
    apiVersion: process.env.VEEVA_API_VERSION || "v25.3",
    username: requireEnv("VEEVA_USERNAME"),
    password: requireEnv("SECRET_VEEVA_PASSWORD"),

    connectorId: process.env.CONNECTOR_ID || profile.connectorId,
    connectorName: process.env.CONNECTOR_NAME || profile.connectorName,
    connectorDescription: process.env.CONNECTOR_DESCRIPTION || profile.connectorDescription,

    graphApiVersion,

    fullCrawlSchedule: process.env.FULL_CRAWL_SCHEDULE || "0 0 2 * * *",
    incrementalCrawlSchedule: process.env.INCREMENTAL_CRAWL_SCHEDULE || "0 */15 * * * *",
    crawlBatchSize,
    autoDiscoverObjects: process.env.AUTO_DISCOVER_OBJECTS !== "false",
    fullCrawlDays: parseFullCrawlDays(process.env.FULL_CRAWL_DAYS || "0,6"),
    progressBatchSize: parsePositiveIntegerEnv("PROGRESS_BATCH_SIZE", 50),
    // 20 minutes processing budget per chunk — leaves 10 min for download/extract + buffer
    crawlTimeBudgetMs: parsePositiveIntegerEnv("CRAWL_TIME_BUDGET_MS", 20 * 60 * 1000),
    crawlConcurrency: parsePositiveIntegerEnv("CRAWL_CONCURRENCY", 10),
    fullCrawlFetchContent: process.env.FULL_CRAWL_FETCH_CONTENT === "true",

    storageConnectionString: process.env.AzureWebJobsStorage || "UseDevelopmentStorage=true",
    crawlStateTable: process.env.CRAWL_STATE_TABLE || `VeevaConnectorCrawlState${capitalize(appValue)}`,
    azureClientId: requireEnv("AZURE_CLIENT_ID"),
    azureClientSecret: requireEnv("SECRET_AZURE_CLIENT_SECRET"),
    azureTenantId: requireEnv("MICROSOFT_TENANT_ID"),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return parsed;
}

/**
 * Parse FULL_CRAWL_DAYS env var.
 * "0,6" = Sunday + Saturday (default). "" or "all" = every day. "6" = Saturday only.
 */
function parseFullCrawlDays(value: string): number[] {
  if (!value || value.toLowerCase() === "all") return [];
  return value.split(",").map((d) => parseInt(d.trim(), 10)).filter((d) => d >= 0 && d <= 6);
}

function parseGraphApiVersion(value: string | undefined): GraphApiVersion {
  if (!value || value === "v1.0") return "v1.0";
  if (value === "beta") return "beta";
  throw new Error(
    `Invalid GRAPH_API_VERSION: '${value}'. Must be 'v1.0' or 'beta'`
  );
}
