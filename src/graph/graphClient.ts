/**
 * Microsoft Graph Client for External Connections
 *
 * Manages the Graph connection, schema registration, and item ingestion/deletion
 * for the Veeva Vault unified connector. Implements best practices:
 * - urlToItemResolver for URL-based boosting
 * - contentCategory for content classification
 * - Concurrency limiter (max 25 per connection)
 * - User activity tracking (created/modified)
 */

import {
  Client,
  ResponseType,
} from "@microsoft/microsoft-graph-client";
import {
  ClientSecretCredential,
  DefaultAzureCredential,
} from "@azure/identity";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import { createHash } from "crypto";
import { ConnectorConfig, GraphApiVersion } from "../config/settings";
import { logger } from "../utils/logger";
import { retryWithBackoff } from "../utils/retry";
import "isomorphic-fetch";

const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];
const MAX_CONCURRENT_OPERATIONS = 20; // Graph allows 25 per connection; leave headroom
const DEFAULT_RATE_LIMIT_PER_SEC = 22; // Stay ~12% below the 25 items/sec Graph limit

/**
 * Simple concurrency limiter to throttle simultaneous Graph API calls.
 */
class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Token-bucket rate limiter with queued waiters.
 * Ensures Graph API calls stay at or below maxPerSec, with a small burst allowance.
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly waitQueue: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly maxPerSec: number,
    private readonly burstSize: number = 4
  ) {
    this.tokens = burstSize;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      this.scheduleRefill();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burstSize, this.tokens + elapsed * this.maxPerSec);
    this.lastRefill = now;
  }

  private scheduleRefill(): void {
    if (this.timer) return;
    const intervalMs = Math.ceil(1000 / this.maxPerSec);
    this.timer = setInterval(() => {
      this.refill();
      while (this.tokens >= 1 && this.waitQueue.length > 0) {
        this.tokens--;
        const next = this.waitQueue.shift()!;
        next();
      }
      if (this.waitQueue.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, intervalMs);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export class GraphConnectorClient {
  private client: Client;
  private limiter = new ConcurrencyLimiter(MAX_CONCURRENT_OPERATIONS);
  private rateLimiter = new RateLimiter(DEFAULT_RATE_LIMIT_PER_SEC);
  private readonly apiVersion: GraphApiVersion;

  constructor(private readonly config: ConnectorConfig) {
    const credential = config.azureClientId && config.azureClientSecret && config.azureTenantId
      ? new ClientSecretCredential(
          config.azureTenantId,
          config.azureClientId,
          config.azureClientSecret
        )
      : new DefaultAzureCredential();

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: GRAPH_SCOPES,
    });

    this.apiVersion = config.graphApiVersion || "v1.0";
    this.client = Client.initWithMiddleware({
      authProvider,
      defaultVersion: this.apiVersion,
    });
  }

  /**
   * Create or verify the external connection exists.
   * Sets contentCategory and detailed description per best practices.
   * In Beta mode, also configures enabledContentExperiences.
   * If the connection already exists, patches it with updated settings.
   */
  async ensureConnection(): Promise<void> {
    const connectionId = this.config.connectorId;

    try {
      await this.client
        .api(`/external/connections/${connectionId}`)
        .get();
      logger.info(`Connection '${connectionId}' already exists, updating settings...`);
      await this.patchConnectionSettings(connectionId);
    } catch (error: unknown) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode !== 404) {
        throw error;
      }

      logger.info(`Creating connection '${connectionId}' (Graph API ${this.apiVersion})...`);
      const connectionBody: Record<string, unknown> = {
        id: connectionId,
        name: this.config.connectorName,
        description: this.config.connectorDescription,
        contentCategory: "knowledgeBase",
        configuration: {
          authorizedAppIds: [],
        },
      };

      if (this.apiVersion === "beta") {
        connectionBody.enabledContentExperiences = ["search"];
      }

      await this.client.api("/external/connections").post(connectionBody);
      logger.info(`Connection '${connectionId}' created`);
    }
  }

  /**
   * Patch an existing connection with contentCategory and (in Beta) enabledContentExperiences.
   */
  private async patchConnectionSettings(connectionId: string): Promise<void> {
    try {
      const patchBody: Record<string, unknown> = {
        description: this.config.connectorDescription,
        contentCategory: "knowledgeBase",
      };

      if (this.apiVersion === "beta") {
        patchBody.enabledContentExperiences = ["search"];
      }

      await this.client
        .api(`/external/connections/${connectionId}`)
        .patch(patchBody);
      logger.info(`Connection '${connectionId}' settings updated (API ${this.apiVersion})`);
    } catch (error: unknown) {
      logger.warn(
        `Failed to update connection settings: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
  }

  /**
   * Configure urlToItemResolver for URL-based boosting.
   * Enables Copilot to recognize Vault URLs shared in conversations.
   */
  async configureUrlResolver(): Promise<void> {
    const connectionId = this.config.connectorId;
    const vaultDns = this.config.vaultDns;

    try {
      await this.client
        .api(`/external/connections/${connectionId}`)
        .patch({
          activitySettings: {
            urlToItemResolvers: [
              {
                "@odata.type": "#microsoft.graph.externalConnectors.itemIdResolver",
                urlMatchInfo: {
                  baseUrls: [`https://${vaultDns}`],
                  urlPattern: "/ui/#doc_info/(?<itemId>[0-9]+)",
                },
              },
              {
                "@odata.type": "#microsoft.graph.externalConnectors.itemIdResolver",
                urlMatchInfo: {
                  baseUrls: [`https://${vaultDns}`],
                  urlPattern: "/ui/#object/[a-z_]+/(?<itemId>[0-9]+)",
                },
              },
            ],
          },
        });
      logger.info("URL resolver configured for Vault URLs");
    } catch (error: unknown) {
      logger.warn(
        `Failed to configure URL resolver: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
  }

  /**
   * Send user activities for item relevance boosting.
   * Supported types: created, modified, commented, viewed.
   */
  async sendActivity(
    itemId: string,
    activityType: "created" | "modified" | "commented" | "viewed",
    userId: string,
    startDateTime?: string
  ): Promise<void> {
    const connectionId = this.config.connectorId;
    const sanitizedId = this.sanitizeItemId(itemId);

    try {
      await this.limiter.run(() =>
        this.client
          .api(`/external/connections/${connectionId}/items/${sanitizedId}/addActivities`)
          .post({
            activities: [
              {
                "@odata.type": "#microsoft.graph.externalConnectors.externalActivity",
                type: activityType,
                startDateTime: startDateTime || new Date().toISOString(),
                performedBy: {
                  "@odata.type": "#microsoft.graph.externalConnectors.identity",
                  id: userId,
                  type: "user",
                },
              },
            ],
          })
      );
    } catch (error: unknown) {
      logger.debug(
        `Activity send failed for ${sanitizedId}: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
  }

  /**
   * Register the schema for the external connection.
   * This is an async operation — polls until registration completes.
   */
  async registerSchema(schema: object): Promise<void> {
    const connectionId = this.config.connectorId;
    logger.info(`Registering schema for connection '${connectionId}'...`);

    try {
      const response = await this.client
        .api(`/external/connections/${connectionId}/schema`)
        .responseType(ResponseType.RAW)
        .header("Prefer", "respond-async")
        .header("Content-Type", "application/json")
        .patch(schema);

      const operationUrl = response.headers.get("location");
      if (operationUrl) {
        await this.pollSchemaOperation(operationUrl);
        return;
      }
    } catch (error: unknown) {
      // If schema already exists/in progress, keep going to readiness polling
      const graphError = error as {
        statusCode?: number;
        body?: { error?: { code?: string; message?: string } };
        message?: string;
      };
      const statusCode = graphError?.statusCode;
      const errorCode = (graphError?.body?.error?.code || "").toLowerCase();
      const errorText = `${graphError?.body?.error?.message || ""} ${graphError?.message || ""}`.toLowerCase();
      const isAlreadyProvisioning =
        statusCode === 409 ||
        errorCode === "schemaalreadyexists" ||
        errorCode === "schemaoperationinprogress" ||
        errorCode === "operationinprogress" ||
        (statusCode === 400 &&
          errorText.includes("schema") &&
          (errorText.includes("in progress") || errorText.includes("pending")));

      if (!isAlreadyProvisioning) {
        throw error;
      }
      logger.info("Schema already exists or is being provisioned, polling readiness");
    }

    // Graph SDK patch() response body does not expose response headers reliably.
    // Poll schema endpoint for actual readiness.
    await this.waitForSchemaReady(connectionId);
  }

  /**
   * Upsert an external item into the connection.
   * Respects concurrency limits per best practices.
   */
  async upsertItem(
    itemId: string,
    properties: Record<string, unknown>,
    content?: { value: string; type: "text" | "html" } | null,
    acl?: Array<{
      type: "user" | "group" | "everyone" | "everyoneExceptGuests" | "externalGroup";
      value: string;
      accessType: "grant" | "deny";
      identitySource?: string;
    }>
  ): Promise<void> {
    const connectionId = this.config.connectorId;
    const sanitizedId = this.sanitizeItemId(itemId);

    // Check serialized payload size before sending (4MB limit)
    const contentValue = content ? this.truncateContent(content.value) : undefined;

    // Add OData type annotations for StringCollection (array) properties
    const annotatedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      annotatedProps[key] = value;
      if (Array.isArray(value)) {
        annotatedProps[`${key}@odata.type`] = "Collection(String)";
      }
    }

    const body: Record<string, unknown> = {
      properties: annotatedProps,
      acl: (acl && acl.length > 0 ? acl : [this.getDefaultAcl()]).map(
        (entry) => ({
          type: entry.type === "externalGroup" ? "externalGroup" : entry.type,
          value: entry.value,
          accessType: entry.accessType,
          identitySource:
            entry.type === "everyone" || entry.type === "everyoneExceptGuests"
              ? undefined
              : entry.type === "externalGroup"
                ? "external"
                : "azureActiveDirectory",
        })
      ),
    };

    // Only include content if provided (ACL-only updates skip content)
    if (content && contentValue !== undefined) {
      body.content = { value: contentValue, type: content.type };
    }

    const payloadSize = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (payloadSize > 4 * 1024 * 1024) {
      logger.warn(`Item ${sanitizedId} payload ${payloadSize} bytes exceeds 4MB — truncating content`);
      body.content = {
        value: this.truncateContent(contentValue || "", 3_500_000),
        type: content?.type || "text",
      };
    }

    await retryWithBackoff(
      async () => {
        await this.rateLimiter.acquire();
        return this.limiter.run(() =>
          this.client
            .api(
              `/external/connections/${connectionId}/items/${sanitizedId}`
            )
            .header("Content-Type", "application/json")
            .put(body)
        );
      },
      3,
      `upsertItem:${sanitizedId}`
    );
  }

  /**
   * Delete an external item from the connection.
   * Respects concurrency limits per best practices.
   */
  async deleteItem(itemId: string): Promise<void> {
    const connectionId = this.config.connectorId;
    const sanitizedId = this.sanitizeItemId(itemId);

    try {
      await retryWithBackoff(
        async () => {
          await this.rateLimiter.acquire();
          return this.limiter.run(() =>
            this.client
              .api(
                `/external/connections/${connectionId}/items/${sanitizedId}`
              )
              .delete()
          );
        },
        3,
        `deleteItem:${sanitizedId}`
      );
    } catch (error: unknown) {
      // 404 is acceptable — item already deleted
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode !== 404) throw error;
    }
  }

  /**
   * Get the current connection status.
   */
  async getConnectionStatus(): Promise<Record<string, unknown>> {
    const connectionId = this.config.connectorId;
    return this.client
      .api(`/external/connections/${connectionId}`)
      .get();
  }

  // --- Private helpers ---

  private sanitizeItemId(id: string): string {
    // Graph external item IDs must be alphanumeric, hyphens, underscores (max 128 chars)
    const raw = id || "item";
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (sanitized.length <= 128 && sanitized === raw) {
      return sanitized;
    }

    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    const prefix = sanitized.substring(0, 115) || "item";
    return `${prefix}_${hash}`;
  }

  private getDefaultAcl(): {
    type: "everyoneExceptGuests";
    value: string;
    accessType: "grant";
  } {
    if (!this.config.azureTenantId) {
      throw new Error(
        "MICROSOFT_TENANT_ID is required to generate a default Graph ACL"
      );
    }

    return {
      type: "everyoneExceptGuests",
      value: this.config.azureTenantId,
      accessType: "grant",
    };
  }

  private truncateContent(content: string, maxBytes = 3_800_000): string {
    if (Buffer.byteLength(content, "utf8") <= maxBytes) {
      return content;
    }

    let low = 0;
    let high = content.length;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = content.substring(0, mid);
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return content.substring(0, low);
  }

  private async pollSchemaOperation(
    operationUrl: string,
    maxAttempts = 60,
    intervalMs = 10000
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const status = await this.client.api(operationUrl).get();
      const state = (status?.status || "").toString().toLowerCase();

      if (state === "completed" || state === "succeeded") {
        logger.info("Schema registration completed");
        return;
      }

      if (state === "failed") {
        throw new Error(
          `Schema registration failed: ${JSON.stringify(status.error || status)}`
        );
      }

      logger.info(`Schema registration in progress... (${state || "unknown"})`);
    }

    throw new Error("Schema registration timed out");
  }

  private async waitForSchemaReady(
    connectionId: string,
    maxAttempts = 60,
    intervalMs = 10000
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));

      try {
        const schema = await this.client
          .api(`/external/connections/${connectionId}/schema`)
          .get();
        const state = (schema?.status || schema?.state || "").toString().toLowerCase();
        if (state === "failed") {
          throw new Error(`Schema registration failed: ${JSON.stringify(schema)}`);
        }
        if (schema && schema.properties && (state === "" || state === "ready" || state === "completed")) {
          logger.info("Schema is ready");
          return;
        }
        logger.info(`Schema registration in progress... (${state || "unknown"})`);
      } catch (error: unknown) {
        if (i === maxAttempts - 1) {
          throw error;
        }
        // Schema not ready yet
      }
    }
    throw new Error("Schema readiness check timed out");
  }
}
