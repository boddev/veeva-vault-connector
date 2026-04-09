/**
 * Full Crawl Engine — Performs a complete sync from Veeva Vault via Direct Data API.
 *
 * Designed for long-running crawls (24+ hours for 10M+ document Vaults):
 * - Progress heartbeat every PROGRESS_BATCH_SIZE items (default 500)
 * - Resume capability: if interrupted, resumes from last checkpoint index
 * - Rate tracking: items/minute and estimated completion time
 * - Phase reporting: admins can see which stage the crawl is in
 *
 * Supports all Vault applications (PromoMats, QualityDocs, RIM) through
 * application profiles and auto-discovery of object types.
 */

import * as fs from "fs";
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

export class FullCrawlEngine {
  private readonly directData: DirectDataClient;
  private readonly vaultRest: VaultRestClient;
  private readonly graphClient: GraphConnectorClient;
  private readonly aclMapper: AclMapper;
  private readonly stateManager: CrawlStateManager;
  private readonly contentProcessor: ContentProcessor;
  private readonly config: ConnectorConfig;
  private crawlStartTime = 0;

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
  }

  async execute(): Promise<{
    itemsProcessed: number;
    itemsDeleted: number;
    errors: number;
    stopTime: string;
  }> {
    const app = this.config.vaultApplication;
    logger.info(`=== FULL CRAWL STARTING [${app.toUpperCase()}] ===`);
    await this.stateManager.markFullCrawlStart();
    this.crawlStartTime = Date.now();

    let itemsProcessed = 0;
    let itemsDeleted = 0;
    let errors = 0;
    let stopTime = "";
    const tempDir = this.createWorkingDirectory(`veeva-fullcrawl-${app}`);
    const batchSize = this.config.progressBatchSize;

    try {
      // 1. Refresh ACL cache
      await this.reportPhase("Initializing ACL cache", 0, 0);
      logger.info("Step 1: Refreshing ACL cache...");
      await this.aclMapper.refresh();

      // 2. Find the latest Full Direct Data file
      await this.reportPhase("Listing Direct Data files", 0, 0);
      logger.info("Step 2: Listing available Full Direct Data files...");
      const files = await this.directData.listAvailableFiles({
        extractType: "full_directdata",
        startTime: "2000-01-01T00:00Z",
      });

      if (files.length === 0) {
        throw new Error("No Full Direct Data files available");
      }

      const latestFile = [...files].sort((a, b) => a.stop_time.localeCompare(b.stop_time)).at(-1)!;
      stopTime = latestFile.stop_time;
      logger.info(`Using Full file: ${latestFile.filename} (${latestFile.record_count} records, stop_time: ${stopTime})`);

      // 3. Download the file
      await this.reportPhase("Downloading Direct Data archive", 0, latestFile.record_count);
      logger.info("Step 3: Downloading Full Direct Data file...");
      const filePath = await this.directData.downloadFile(latestFile, tempDir);
      if (!filePath) {
        logger.info("Empty file — no records to process");
        await this.stateManager.markFullCrawlComplete(stopTime, 0, 0);
        return { itemsProcessed: 0, itemsDeleted: 0, errors: 0, stopTime };
      }

      // 4. Extract the archive
      await this.reportPhase("Extracting archive", 0, latestFile.record_count);
      logger.info("Step 4: Extracting Direct Data archive...");
      const extractedData = await this.directData.extractFile(filePath);

      // 5. Parse manifest and discover objects
      const manifest = this.directData.parseManifest(extractedData);
      logger.info(`Manifest: ${manifest.length} extracts`);

      const profile = getAppProfile(app);
      const objectTypes = this.config.autoDiscoverObjects
        ? discoverObjectTypes(manifest, profile.knownObjectTypes)
        : profile.knownObjectTypes;

      // Count total items for progress estimation
      const docRecords = this.directData.getDocumentRecords(extractedData);
      const relRecords = this.directData.getRelationshipRecords(extractedData);
      const workflowRecords = this.directData.getWorkflowRecords(extractedData);
      const picklistRecords = this.directData.getPicklistRecords(extractedData);
      let objectRecordCount = 0;
      const objectRecordMap = new Map<string, Array<Record<string, string>>>();
      for (const objectType of objectTypes) {
        const records = this.directData.getObjectRecords(extractedData, objectType);
        if (records.length > 0) {
          objectRecordMap.set(objectType, records);
          objectRecordCount += records.length;
        }
      }
      const totalItems = docRecords.length + relRecords.length + objectRecordCount +
        workflowRecords.length + picklistRecords.length;

      logger.info(`Total items to process: ${totalItems.toLocaleString()} (${docRecords.length.toLocaleString()} docs, ${relRecords.length.toLocaleString()} rels, ${objectRecordCount.toLocaleString()} objects, ${workflowRecords.length.toLocaleString()} workflows, ${picklistRecords.length.toLocaleString()} picklists)`);

      // Check for resume: if we were interrupted mid-crawl, skip already-processed items
      const state = await this.stateManager.getState();
      let resumeIndex = 0;
      if (state.fullCrawlResumeIndex && state.fullCrawlDataFile === latestFile.filename) {
        resumeIndex = state.fullCrawlResumeIndex;
        itemsProcessed = state.itemsProcessed || 0;
        logger.info(`Resuming full crawl from index ${resumeIndex} (${itemsProcessed} items already processed)`);
      }

      // Save the data file name so resume knows which file we're processing
      await this.stateManager.updateState({ fullCrawlDataFile: latestFile.filename });

      // 6. Process documents
      await this.reportPhase("Processing documents", itemsProcessed, totalItems);
      logger.info(`Step 6: Processing ${docRecords.length.toLocaleString()} documents...`);

      let docIndex = 0;
      for (const record of docRecords) {
        if (docIndex < resumeIndex) {
          docIndex++;
          continue;
        }

        try {
          const items = await this.contentProcessor.processDocument(record);
          const lifecycle = record.lifecycle__v || "";
          const acl = await this.aclMapper.mapDocumentAcl(
            record.doc_id || record.id?.split("_")[0] || "",
            false,
            lifecycle || undefined
          );
          for (const item of items) {
            await this.graphClient.upsertItem(item.itemId, item.properties, item.content, acl);
          }
          itemsProcessed += items.length;
        } catch (error: unknown) {
          errors++;
          logger.warn(`Failed to process document ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
        }

        docIndex++;

        // Heartbeat checkpoint every batchSize items
        if (docIndex % batchSize === 0) {
          await this.reportPhase("Processing documents", itemsProcessed, totalItems, docIndex);
        }
      }

      // 7. Process document relationships
      await this.reportPhase("Processing relationships", itemsProcessed, totalItems);
      logger.info(`Step 7: Processing ${relRecords.length.toLocaleString()} relationships...`);

      for (const record of relRecords) {
        try {
          const item = this.contentProcessor.processRelationship(record);
          await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
          itemsProcessed++;
        } catch (error: unknown) {
          errors++;
          logger.warn(`Failed to process relationship ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }

      // 8. Process Vault objects (profile + auto-discovered) — with per-object ACLs
      await this.reportPhase("Processing objects", itemsProcessed, totalItems);
      logger.info(`Step 8: Processing Vault objects (${objectTypes.length} types)...`);
      for (const [objectType, objRecords] of objectRecordMap) {
        logger.info(`Processing ${objRecords.length} ${objectType} record(s)`);
        for (const record of objRecords) {
          try {
            const item = this.contentProcessor.processVaultObject(record, objectType);
            const acl = await this.aclMapper.mapObjectAcl(objectType, record.id || "");
            await this.graphClient.upsertItem(item.itemId, item.properties, item.content, acl);
            itemsProcessed++;
          } catch {
            errors++;
          }
        }
      }

      // 9. Process workflows
      await this.reportPhase("Processing workflows", itemsProcessed, totalItems);
      logger.info(`Step 9: Processing ${workflowRecords.length.toLocaleString()} workflows...`);
      for (const record of workflowRecords) {
        try {
          const item = this.contentProcessor.processWorkflow(record);
          await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
          itemsProcessed++;
        } catch { errors++; }
      }

      // 10. Process picklists
      await this.reportPhase("Processing picklists", itemsProcessed, totalItems);
      logger.info(`Step 10: Processing ${picklistRecords.length.toLocaleString()} picklists...`);
      for (const record of picklistRecords) {
        try {
          const item = this.contentProcessor.processPicklist(record);
          await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
          itemsProcessed++;
        } catch { errors++; }
      }

      // 11. Ingest pre-computed summary items for aggregate queries
      await this.reportPhase("Building summaries", itemsProcessed, totalItems);
      logger.info("Step 11: Building summary items...");
      try {
        const summaryItems = this.contentProcessor.buildSummaryItems(docRecords, objectRecordMap);
        for (const item of summaryItems) {
          await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
          itemsProcessed++;
        }
        logger.info(`Ingested ${summaryItems.length} summary item(s)`);
      } catch (error: unknown) {
        logger.warn(`Summary item generation failed: ${error instanceof Error ? error.message : "unknown"}`);
      }

      // 12. Mark crawl complete
      await this.stateManager.markFullCrawlComplete(stopTime, itemsProcessed, itemsDeleted);
      const elapsed = ((Date.now() - this.crawlStartTime) / 3600000).toFixed(1);
      logger.info(`=== FULL CRAWL COMPLETE [${app.toUpperCase()}] === ${itemsProcessed.toLocaleString()} items in ${elapsed}h, ${errors} errors`);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Full crawl failed: ${message}`);
      await this.stateManager.markCrawlFailed(message);
      throw error;
    } finally {
      this.cleanupTempDir(tempDir);
    }

    return { itemsProcessed, itemsDeleted, errors, stopTime };
  }

  /**
   * Report current phase and progress to crawl state.
   * Calculates items/minute and ETA based on elapsed time.
   */
  private async reportPhase(
    phase: string,
    processed: number,
    total: number,
    resumeIndex?: number
  ): Promise<void> {
    const elapsedMs = Date.now() - this.crawlStartTime;
    const elapsedMin = elapsedMs / 60000;
    const rate = elapsedMin > 0 ? Math.round(processed / elapsedMin) : 0;
    const remaining = total - processed;
    const etaMs = rate > 0 ? (remaining / rate) * 60000 : 0;
    const etaDate = etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : undefined;

    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    logger.info(`[${pct}%] ${phase} — ${processed.toLocaleString()}/${total.toLocaleString()} items (${rate}/min, ETA: ${etaDate || "calculating..."})`);

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
    const dir = path.join(process.cwd(), ".connector-work", `${prefix}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
