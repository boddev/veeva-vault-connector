/**
 * Full Crawl Engine — Performs a complete sync from Veeva Vault via Direct Data API.
 *
 * Designed for Azure Functions with execution time limits:
 * - Time-budgeted: checks elapsed time every batch, pauses gracefully before timeout
 * - Phase-level resume: tracks which phase and item index to resume from
 * - Automatic continuation via crawlResumeTimer (every 5 minutes)
 * - Progress heartbeat every PROGRESS_BATCH_SIZE items
 * - Rate tracking: items/minute and estimated completion time
 *
 * Supports all Vault applications (PromoMats, QualityDocs, RIM) through
 * application profiles and auto-discovery of object types.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConnectorConfig } from "../config/settings";
import { getAppProfile } from "../config/appProfiles";
import { DirectDataClient } from "../veeva/directDataClient";
import { VaultRestClient } from "../veeva/vaultRestClient";
import { GraphConnectorClient } from "../graph/graphClient";
import { AclMapper } from "../graph/aclMapper";
import { CrawlStateManager } from "./crawlState";
import { ContentProcessor } from "./contentProcessor";
import { discoverObjectTypes } from "./objectDiscovery";
import { logger } from "../utils/logger";

// Phase constants for resume tracking
const PHASE_DOCS = 0;
const PHASE_RELATIONSHIPS = 1;
const PHASE_OBJECTS = 2;
const PHASE_WORKFLOWS = 3;
const PHASE_PICKLISTS = 4;
const PHASE_SUMMARIES = 5;
const PHASE_COMPLETE = 6;

export class FullCrawlEngine {
  private readonly directData: DirectDataClient;
  private readonly vaultRest: VaultRestClient;
  private readonly graphClient: GraphConnectorClient;
  private readonly aclMapper: AclMapper;
  private readonly stateManager: CrawlStateManager;
  private readonly contentProcessor: ContentProcessor;
  private readonly config: ConnectorConfig;
  private chunkStartTime = 0;
  private readonly timeBudgetMs: number;

  constructor(
    config: ConnectorConfig,
    directData: DirectDataClient,
    vaultRest: VaultRestClient,
    graphClient: GraphConnectorClient,
    aclMapper: AclMapper,
    stateManager: CrawlStateManager
  ) {
    this.config = config;
    this.directData = directData;
    this.vaultRest = vaultRest;
    this.graphClient = graphClient;
    this.aclMapper = aclMapper;
    this.stateManager = stateManager;
    this.contentProcessor = new ContentProcessor(config, vaultRest);
    this.timeBudgetMs = config.crawlTimeBudgetMs;
  }

  /**
   * Check if the time budget for this chunk has been exceeded.
   */
  private isTimeBudgetExceeded(): boolean {
    return (Date.now() - this.chunkStartTime) >= this.timeBudgetMs;
  }

  async execute(): Promise<{
    itemsProcessed: number;
    itemsDeleted: number;
    errors: number;
    stopTime: string;
    paused: boolean;
  }> {
    const app = this.config.vaultApplication;
    this.chunkStartTime = Date.now();

    // Load existing state to check for resume
    const existingState = await this.stateManager.getState();
    const isResume = existingState.crawlStatus === "paused" &&
      existingState.currentCrawlType === "full";

    if (isResume) {
      logger.info(`=== FULL CRAWL RESUMING [${app.toUpperCase()}] from phase ${existingState.fullCrawlPhase}, ${existingState.itemsProcessed} items already done ===`);
    } else {
      logger.info(`=== FULL CRAWL STARTING [${app.toUpperCase()}] ===`);
    }

    await this.stateManager.markFullCrawlStart();

    let itemsProcessed = isResume ? (existingState.itemsProcessed || 0) : 0;
    const itemsDeleted = 0;
    let errors = isResume ? (existingState.fullCrawlErrors || 0) : 0;
    let stopTime = "";
    let startPhase = isResume ? (existingState.fullCrawlPhase || PHASE_DOCS) : PHASE_DOCS;
    let startIndex = isResume ? (existingState.fullCrawlResumeIndex || 0) : 0;
    const tempDir = this.createWorkingDirectory(`veeva-fullcrawl-${app}`);
    const batchSize = this.config.progressBatchSize;

    try {
      // 1. Refresh ACL cache
      await this.reportPhase("Initializing ACL cache", itemsProcessed, 0);
      logger.info("Refreshing ACL cache...");
      await this.aclMapper.refresh();

      // 2. Find the correct Direct Data file
      await this.reportPhase("Listing Direct Data files", itemsProcessed, 0);
      const files = await this.directData.listAvailableFiles({
        extractType: "full_directdata",
        startTime: "2000-01-01T00:00Z",
      });

      if (files.length === 0) {
        throw new Error("No Full Direct Data files available");
      }

      // Pin to the same file if resuming
      let latestFile;
      if (isResume && existingState.fullCrawlDataFile) {
        latestFile = files.find(f => f.filename === existingState.fullCrawlDataFile);
        if (!latestFile) {
          logger.warn(`Resume file '${existingState.fullCrawlDataFile}' no longer available, starting fresh`);
          startPhase = PHASE_DOCS;
          startIndex = 0;
          itemsProcessed = 0;
          errors = 0;
        }
      }
      if (!latestFile) {
        latestFile = [...files].sort((a, b) => a.stop_time.localeCompare(b.stop_time)).at(-1)!;
      }

      stopTime = latestFile.stop_time;
      logger.info(`Using file: ${latestFile.filename} (${latestFile.record_count} records)`);

      // 3. Download and extract
      await this.reportPhase("Downloading Direct Data archive", itemsProcessed, latestFile.record_count);
      const filePath = await this.directData.downloadFile(latestFile, tempDir);
      if (!filePath) {
        logger.info("Empty file — no records to process");
        await this.stateManager.markFullCrawlComplete(stopTime, 0, 0);
        return { itemsProcessed: 0, itemsDeleted: 0, errors: 0, stopTime, paused: false };
      }

      await this.reportPhase("Extracting archive", itemsProcessed, latestFile.record_count);
      const extractedData = await this.directData.extractFile(filePath);

      // Parse manifest and discover objects
      const manifest = this.directData.parseManifest(extractedData);
      const profile = getAppProfile(app);
      const objectTypes = this.config.autoDiscoverObjects
        ? discoverObjectTypes(manifest, profile.knownObjectTypes)
        : profile.knownObjectTypes;

      // Load all record sets
      const docRecords = this.directData.getDocumentRecords(extractedData);
      const relRecords = this.directData.getRelationshipRecords(extractedData);
      const workflowRecords = this.directData.getWorkflowRecords(extractedData);
      const picklistRecords = this.directData.getPicklistRecords(extractedData);
      const objectRecordMap = new Map<string, Array<Record<string, string>>>();
      let objectRecordCount = 0;
      for (const objectType of objectTypes) {
        const records = this.directData.getObjectRecords(extractedData, objectType);
        if (records.length > 0) {
          objectRecordMap.set(objectType, records);
          objectRecordCount += records.length;
        }
      }
      const totalItems = docRecords.length + relRecords.length + objectRecordCount +
        workflowRecords.length + picklistRecords.length;

      logger.info(`Total: ${totalItems.toLocaleString()} items (${docRecords.length} docs, ${relRecords.length} rels, ${objectRecordCount} objects, ${workflowRecords.length} workflows, ${picklistRecords.length} picklists)`);

      // Save the data file name for resume pinning
      await this.stateManager.updateState({ fullCrawlDataFile: latestFile.filename });

      // === PHASE: Documents ===
      if (startPhase <= PHASE_DOCS) {
        const resumeIdx = startPhase === PHASE_DOCS ? startIndex : 0;
        await this.reportPhase("Processing documents", itemsProcessed, totalItems);
        const fetchContent = this.config.fullCrawlFetchContent;
        logger.info(`Processing ${docRecords.length} documents (resume from index ${resumeIdx}, concurrency=${this.config.crawlConcurrency}, fetchContent=${fetchContent})...`);

        const concurrency = this.config.crawlConcurrency;
        let nextIndex = resumeIdx;

        while (nextIndex < docRecords.length) {
          if (this.isTimeBudgetExceeded()) {
            await this.pauseCrawl(itemsProcessed, PHASE_DOCS, nextIndex, errors);
            return { itemsProcessed, itemsDeleted, errors, stopTime, paused: true };
          }

          // Take the next batch
          const batchEnd = Math.min(nextIndex + concurrency, docRecords.length);
          const batch = docRecords.slice(nextIndex, batchEnd);

          // Process batch concurrently — all items in this batch must finish before checkpoint
          const results = await Promise.allSettled(
            batch.map(async (record) => {
              const items = await this.contentProcessor.processDocument(record, { fetchContent });
              const lifecycle = record.lifecycle__v || "";
              const acl = await this.aclMapper.mapDocumentAcl(
                record.doc_id || record.id?.split("_")[0] || "",
                false,
                lifecycle || undefined
              );
              for (const item of items) {
                await this.graphClient.upsertItem(item.itemId, item.properties, item.content, acl);
              }
              return items.length;
            })
          );

          // Tally results — only advance past the full batch
          for (const result of results) {
            if (result.status === "fulfilled") {
              itemsProcessed += result.value;
            } else {
              errors++;
              logger.warn(`Failed doc in batch at index ${nextIndex}: ${result.reason instanceof Error ? result.reason.message : "unknown"}`);
            }
          }

          nextIndex = batchEnd;
          if (nextIndex % batchSize === 0 || nextIndex >= docRecords.length) {
            await this.reportPhase("Processing documents", itemsProcessed, totalItems, nextIndex);
          }
        }
      }

      // === PHASE: Relationships ===
      if (startPhase <= PHASE_RELATIONSHIPS) {
        const resumeIdx = startPhase === PHASE_RELATIONSHIPS ? startIndex : 0;
        await this.reportPhase("Processing relationships", itemsProcessed, totalItems);
        logger.info(`Processing ${relRecords.length} relationships (resume from ${resumeIdx})...`);

        let relIndex = 0;
        for (const record of relRecords) {
          if (relIndex < resumeIdx) { relIndex++; continue; }
          if (this.isTimeBudgetExceeded()) {
            await this.pauseCrawl(itemsProcessed, PHASE_RELATIONSHIPS, relIndex, errors);
            return { itemsProcessed, itemsDeleted, errors, stopTime, paused: true };
          }

          try {
            const item = this.contentProcessor.processRelationship(record);
            await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
            itemsProcessed++;
          } catch (error: unknown) {
            errors++;
            logger.warn(`Failed rel ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
          }
          relIndex++;
          if (relIndex % batchSize === 0) {
            await this.reportPhase("Processing relationships", itemsProcessed, totalItems);
          }
        }
      }

      // === PHASE: Objects ===
      if (startPhase <= PHASE_OBJECTS) {
        const resumeIdx = startPhase === PHASE_OBJECTS ? startIndex : 0;
        await this.reportPhase("Processing objects", itemsProcessed, totalItems);
        logger.info(`Processing ${objectTypes.length} object types (resume from ${resumeIdx})...`);

        // Flatten all object records with their types for batch processing
        const allObjRecords: Array<{ record: Record<string, string>; objectType: string }> = [];
        for (const [objectType, objRecords] of objectRecordMap) {
          for (const record of objRecords) {
            allObjRecords.push({ record, objectType });
          }
        }

        const concurrency = this.config.crawlConcurrency;
        let nextObjIndex = resumeIdx;

        while (nextObjIndex < allObjRecords.length) {
          if (this.isTimeBudgetExceeded()) {
            await this.pauseCrawl(itemsProcessed, PHASE_OBJECTS, nextObjIndex, errors);
            return { itemsProcessed, itemsDeleted, errors, stopTime, paused: true };
          }

          const batchEnd = Math.min(nextObjIndex + concurrency, allObjRecords.length);
          const batch = allObjRecords.slice(nextObjIndex, batchEnd);

          const results = await Promise.allSettled(
            batch.map(async ({ record, objectType }) => {
              const item = this.contentProcessor.processVaultObject(record, objectType);
              const acl = await this.aclMapper.mapObjectAcl(objectType, record.id || "");
              await this.graphClient.upsertItem(item.itemId, item.properties, item.content, acl);
            })
          );

          for (const result of results) {
            if (result.status === "fulfilled") {
              itemsProcessed++;
            } else {
              errors++;
              if (errors <= 10 || errors % 100 === 0) {
                logger.warn(`Failed object in batch: ${result.reason instanceof Error ? result.reason.message : "unknown"}`);
              }
            }
          }

          nextObjIndex = batchEnd;
          if (nextObjIndex % batchSize === 0 || nextObjIndex >= allObjRecords.length) {
            await this.reportPhase("Processing objects", itemsProcessed, totalItems);
          }
        }
      }

      // === PHASE: Workflows ===
      if (startPhase <= PHASE_WORKFLOWS) {
        const resumeIdx = startPhase === PHASE_WORKFLOWS ? startIndex : 0;
        await this.reportPhase("Processing workflows", itemsProcessed, totalItems);
        logger.info(`Processing ${workflowRecords.length} workflows (resume from ${resumeIdx})...`);

        let wfIndex = 0;
        for (const record of workflowRecords) {
          if (wfIndex < resumeIdx) { wfIndex++; continue; }
          if (this.isTimeBudgetExceeded()) {
            await this.pauseCrawl(itemsProcessed, PHASE_WORKFLOWS, wfIndex, errors);
            return { itemsProcessed, itemsDeleted, errors, stopTime, paused: true };
          }

          try {
            const item = this.contentProcessor.processWorkflow(record);
            await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
            itemsProcessed++;
          } catch (error: unknown) {
            errors++;
            if (errors <= 10 || errors % 100 === 0) {
              logger.warn(`Failed workflow ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
            }
          }
          wfIndex++;
          if (wfIndex % batchSize === 0) {
            await this.reportPhase("Processing workflows", itemsProcessed, totalItems);
          }
        }
      }

      // === PHASE: Picklists ===
      if (startPhase <= PHASE_PICKLISTS) {
        const resumeIdx = startPhase === PHASE_PICKLISTS ? startIndex : 0;
        await this.reportPhase("Processing picklists", itemsProcessed, totalItems);
        logger.info(`Processing ${picklistRecords.length} picklists (resume from ${resumeIdx})...`);

        let plIndex = 0;
        for (const record of picklistRecords) {
          if (plIndex < resumeIdx) { plIndex++; continue; }
          if (this.isTimeBudgetExceeded()) {
            await this.pauseCrawl(itemsProcessed, PHASE_PICKLISTS, plIndex, errors);
            return { itemsProcessed, itemsDeleted, errors, stopTime, paused: true };
          }

          try {
            const item = this.contentProcessor.processPicklist(record);
            await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
            itemsProcessed++;
          } catch (error: unknown) {
            errors++;
            if (errors <= 10 || errors % 100 === 0) {
              logger.warn(`Failed picklist ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
            }
          }
          plIndex++;
          if (plIndex % batchSize === 0) {
            await this.reportPhase("Processing picklists", itemsProcessed, totalItems);
          }
        }
      }

      // === PHASE: Summaries ===
      if (startPhase <= PHASE_SUMMARIES) {
        await this.reportPhase("Building summaries", itemsProcessed, totalItems);
        logger.info("Building summary items...");
        try {
          const summaryItems = this.contentProcessor.buildSummaryItems(docRecords, objectRecordMap);
          for (const item of summaryItems) {
            await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
            itemsProcessed++;
          }
          logger.info(`Ingested ${summaryItems.length} summary item(s)`);
        } catch (error: unknown) {
          logger.warn(`Summary generation failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }

      // === COMPLETE ===
      await this.stateManager.markFullCrawlComplete(stopTime, itemsProcessed, itemsDeleted);
      const elapsedMin = Math.round((Date.now() - this.chunkStartTime) / 60000);
      logger.info(`=== FULL CRAWL COMPLETE [${app.toUpperCase()}] === ${itemsProcessed.toLocaleString()} items, ${errors} errors, ${elapsedMin}min this chunk`);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Full crawl failed: ${message}`);
      await this.stateManager.markCrawlFailed(message);
      throw error;
    } finally {
      this.cleanupTempDir(tempDir);
    }

    return { itemsProcessed, itemsDeleted, errors, stopTime, paused: false };
  }

  /**
   * Save checkpoint and mark crawl as paused for timer-based resume.
   */
  private async pauseCrawl(
    itemsProcessed: number,
    phase: number,
    phaseIndex: number,
    errors: number
  ): Promise<void> {
    const elapsedMin = Math.round((Date.now() - this.chunkStartTime) / 60000);
    logger.info(`Time budget reached (${elapsedMin}min). Pausing at phase ${phase}, index ${phaseIndex}. ${itemsProcessed} items processed, ${errors} errors. Will resume on next timer tick.`);
    await this.stateManager.markCrawlPaused({
      itemsProcessed,
      fullCrawlPhase: phase,
      fullCrawlResumeIndex: phaseIndex,
      fullCrawlErrors: errors,
    });
  }

  private async reportPhase(
    phase: string,
    processed: number,
    total: number,
    resumeIndex?: number
  ): Promise<void> {
    const elapsedMs = Date.now() - this.chunkStartTime;
    const elapsedMin = elapsedMs / 60000;
    const rate = elapsedMin > 0 ? Math.round(processed / elapsedMin) : 0;
    const remaining = total - processed;
    const etaMs = rate > 0 ? (remaining / rate) * 60000 : 0;
    const etaDate = etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : undefined;

    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    logger.info(`[${pct}%] ${phase} — ${processed.toLocaleString()}/${total.toLocaleString()} items (${rate}/min)`);

    await this.stateManager.updateProgress({
      itemsProcessed: processed,
      totalItems: total,
      currentPhase: phase,
      itemsPerMinute: rate,
      estimatedCompletionAt: etaDate,
      fullCrawlResumeIndex: resumeIndex,
    });
  }

  private cleanupTempDir(dir: string): void {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch { logger.warn(`Failed to clean up temp directory: ${dir}`); }
  }

  private createWorkingDirectory(prefix: string): string {
    const dir = path.join(os.tmpdir(), ".connector-work", `${prefix}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
