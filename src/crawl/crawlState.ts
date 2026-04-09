/**
 * Crawl State Manager — Persists crawl progress to Azure Table Storage.
 *
 * Tracks:
 * - Last full crawl timestamp and stop_time
 * - Last incremental crawl timestamp and stop_time
 * - Items processed/deleted counts
 * - Error state
 */

import { TableClient } from "@azure/data-tables";
import { ConnectorConfig } from "../config/settings";
import { CrawlState } from "../models/types";
import { logger } from "../utils/logger";

const PARTITION_KEY = "CrawlState";
const ROW_KEY = "current";

export class CrawlStateManager {
  private tableClient: TableClient;

  constructor(private readonly config: ConnectorConfig) {
    this.tableClient = TableClient.fromConnectionString(
      config.storageConnectionString,
      config.crawlStateTable
    );
  }

  /**
   * Ensure the state table exists.
   */
  async initialize(): Promise<void> {
    try {
      await this.tableClient.createTable();
      logger.info(`Crawl state table '${this.config.crawlStateTable}' ready`);
    } catch (error: unknown) {
      const code = (error as { statusCode?: number })?.statusCode;
      if (code !== 409) {
        logger.warn(
          `Table creation warning: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }
  }

  /**
   * Get the current crawl state.
   */
  async getState(): Promise<CrawlState> {
    try {
      return (await this.readStateEntity()) ?? this.getDefaultState();
    } catch (error: unknown) {
      logger.warn(
        `Failed to read crawl state: ${error instanceof Error ? error.message : "unknown"}`
      );
      return this.getDefaultState();
    }
  }

  /**
   * Update the crawl state.
   */
  async updateState(updates: Partial<CrawlState>): Promise<void> {
    await this.writeState((current) => ({
      ...current,
      ...updates,
      partitionKey: PARTITION_KEY,
      rowKey: ROW_KEY,
    }));
  }

  /**
   * Update progress with heartbeat — called periodically during long crawls.
   * This serves as a "still alive" signal and gives admins real-time progress.
   */
  async updateProgress(progress: {
    itemsProcessed: number;
    totalItems?: number;
    currentPhase?: string;
    itemsPerMinute?: number;
    estimatedCompletionAt?: string;
    fullCrawlResumeIndex?: number;
  }): Promise<void> {
    await this.updateState({
      itemsProcessed: progress.itemsProcessed,
      totalItems: progress.totalItems,
      currentPhase: progress.currentPhase,
      lastHeartbeat: new Date().toISOString(),
      itemsPerMinute: progress.itemsPerMinute,
      estimatedCompletionAt: progress.estimatedCompletionAt,
      fullCrawlResumeIndex: progress.fullCrawlResumeIndex,
    });
  }

  /**
   * Mark full crawl start.
   */
  async markFullCrawlStart(): Promise<void> {
    await this.markCrawlStart("full", {
      lastFullCrawlTime: new Date().toISOString(),
    });
  }

  /**
   * Mark full crawl complete.
   */
  async markFullCrawlComplete(
    stopTime: string,
    itemsProcessed: number,
    itemsDeleted: number
  ): Promise<void> {
    await this.updateState({
      crawlStatus: "idle",
      currentCrawlType: undefined,
      lastFullCrawlStopTime: stopTime,
      itemsProcessed,
      itemsDeleted,
      errorMessage: undefined,
    });
  }

  /**
   * Mark incremental crawl start.
   */
  async markIncrementalCrawlStart(): Promise<void> {
    await this.markCrawlStart("incremental", {
      lastIncrementalCrawlTime: new Date().toISOString(),
    });
  }

  /**
   * Persist incremental checkpoint progress while crawl is still running.
   */
  async updateIncrementalCheckpoint(
    stopTime: string,
    itemsProcessed: number,
    itemsDeleted: number
  ): Promise<void> {
    await this.updateState({
      crawlStatus: "running",
      currentCrawlType: "incremental",
      lastIncrementalStopTime: stopTime,
      itemsProcessed,
      itemsDeleted,
    });
  }

  /**
   * Mark incremental crawl complete.
   */
  async markIncrementalCrawlComplete(
    stopTime: string,
    itemsProcessed: number,
    itemsDeleted: number
  ): Promise<void> {
    await this.updateState({
      crawlStatus: "idle",
      currentCrawlType: undefined,
      lastIncrementalStopTime: stopTime,
      itemsProcessed,
      itemsDeleted,
      errorMessage: undefined,
    });
  }

  /**
   * Mark crawl failure.
   */
  async markCrawlFailed(errorMessage: string): Promise<void> {
    await this.updateState({
      crawlStatus: "failed",
      currentCrawlType: undefined,
      errorMessage,
    });
  }

  private async markCrawlStart(
    crawlType: "full" | "incremental",
    updates: Partial<CrawlState>
  ): Promise<void> {
    await this.writeState((current) => {
      if (current.crawlStatus === "running") {
        // Stale-lock detection: if a crawl has been "running" for > 6 hours,
        // it was likely killed by Azure timeout or a crash without cleanup.
        // Break the lock so new crawls can proceed.
        const STALE_LOCK_MS = 6 * 60 * 60 * 1000; // 6 hours
        const startedAt = current.crawlStartedAt ? new Date(current.crawlStartedAt).getTime() : 0;
        const elapsed = Date.now() - startedAt;

        if (startedAt > 0 && elapsed < STALE_LOCK_MS) {
          throw new Error(`A ${current.currentCrawlType || "crawl"} is already running (started ${Math.round(elapsed / 60000)} min ago)`);
        }

        logger.warn(
          `Breaking stale crawl lock: ${current.currentCrawlType} crawl started at ${current.crawlStartedAt} (${Math.round(elapsed / 3600000)}h ago)`
        );
      }

      return {
        ...current,
        ...updates,
        crawlStatus: "running",
        currentCrawlType: crawlType,
        crawlStartedAt: new Date().toISOString(),
        errorMessage: undefined,
      };
    });
  }

  private async writeState(
    updater: (current: CrawlState) => CrawlState,
    maxAttempts = 5
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const current = (await this.readStateEntity()) ?? this.getDefaultState();
      const next = sanitizeState(updater(current));

      try {
        if (current.etag) {
          await this.tableClient.updateEntity(next, "Replace", { etag: current.etag });
        } else {
          await this.tableClient.createEntity(next);
        }
        return;
      } catch (error: unknown) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        const isRetryableConflict = statusCode === 404 || statusCode === 409 || statusCode === 412;
        if (!isRetryableConflict || attempt === maxAttempts) {
          logger.error(
            `Failed to update crawl state: ${error instanceof Error ? error.message : "unknown"}`
          );
          throw error;
        }
      }
    }
  }

  private async readStateEntity(): Promise<CrawlState | null> {
    try {
      const entity = await this.tableClient.getEntity<Record<string, unknown>>(PARTITION_KEY, ROW_KEY);
      return {
        partitionKey: PARTITION_KEY,
        rowKey: ROW_KEY,
        etag: entity.etag,
        lastFullCrawlTime: entity.lastFullCrawlTime as string | undefined,
        lastIncrementalCrawlTime: entity.lastIncrementalCrawlTime as string | undefined,
        lastFullCrawlStopTime: entity.lastFullCrawlStopTime as string | undefined,
        lastIncrementalStopTime: entity.lastIncrementalStopTime as string | undefined,
        crawlStatus: (entity.crawlStatus as CrawlState["crawlStatus"]) || "idle",
        currentCrawlType: entity.currentCrawlType as CrawlState["currentCrawlType"] | undefined,
        crawlStartedAt: entity.crawlStartedAt as string | undefined,
        errorMessage: entity.errorMessage as string | undefined,
        itemsProcessed: entity.itemsProcessed as number | undefined,
        itemsDeleted: entity.itemsDeleted as number | undefined,
        totalItems: entity.totalItems as number | undefined,
        currentPhase: entity.currentPhase as string | undefined,
        lastHeartbeat: entity.lastHeartbeat as string | undefined,
        itemsPerMinute: entity.itemsPerMinute as number | undefined,
        estimatedCompletionAt: entity.estimatedCompletionAt as string | undefined,
        fullCrawlResumeIndex: entity.fullCrawlResumeIndex as number | undefined,
        fullCrawlDataFile: entity.fullCrawlDataFile as string | undefined,
      };
    } catch (error: unknown) {
      if ((error as { statusCode?: number })?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private getDefaultState(): CrawlState {
    return {
      partitionKey: PARTITION_KEY,
      rowKey: ROW_KEY,
      crawlStatus: "idle",
      itemsProcessed: 0,
      itemsDeleted: 0,
    };
  }
}

function sanitizeState(state: CrawlState): Omit<CrawlState, "etag"> {
  return Object.fromEntries(
    Object.entries({
      partitionKey: state.partitionKey,
      rowKey: state.rowKey,
      lastFullCrawlTime: state.lastFullCrawlTime,
      lastIncrementalCrawlTime: state.lastIncrementalCrawlTime,
      lastFullCrawlStopTime: state.lastFullCrawlStopTime,
      lastIncrementalStopTime: state.lastIncrementalStopTime,
      crawlStatus: state.crawlStatus,
      currentCrawlType: state.currentCrawlType,
      crawlStartedAt: state.crawlStartedAt,
      errorMessage: state.errorMessage,
      itemsProcessed: state.itemsProcessed,
      itemsDeleted: state.itemsDeleted,
      totalItems: state.totalItems,
      currentPhase: state.currentPhase,
      lastHeartbeat: state.lastHeartbeat,
      itemsPerMinute: state.itemsPerMinute,
      estimatedCompletionAt: state.estimatedCompletionAt,
      fullCrawlResumeIndex: state.fullCrawlResumeIndex,
      fullCrawlDataFile: state.fullCrawlDataFile,
    }).filter(([, value]) => value !== undefined)
  ) as Omit<CrawlState, "etag">;
}
