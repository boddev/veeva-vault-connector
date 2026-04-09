/**
 * Incremental Crawl Engine — Processes only changes since the last crawl.
 *
 * Uses Direct Data API incremental files (generated every 15 minutes) to:
 * - Add/update modified documents
 * - Remove deleted documents
 * - Update relationships, objects, and workflow states
 *
 * Supports all Vault applications (PromoMats, QualityDocs, RIM).
 */

import * as fs from "fs";
import * as path from "path";
import { ConnectorConfig } from "../config/settings";
import { getAppProfile } from "../config/appProfiles";
import { DirectDataClient } from "../veeva/directDataClient";
import { DirectDataFileInfo } from "../models/types";
import { VaultRestClient } from "../veeva/vaultRestClient";
import { GraphConnectorClient } from "../graph/graphClient";
import { AclMapper } from "../graph/aclMapper";
import { CrawlStateManager } from "./crawlState";
import { ContentProcessor } from "./contentProcessor";
import { discoverObjectTypes } from "./objectDiscovery";
import { logger } from "../utils/logger";

export class IncrementalCrawlEngine {
  private readonly directData: DirectDataClient;
  private readonly vaultRest: VaultRestClient;
  private readonly graphClient: GraphConnectorClient;
  private readonly aclMapper: AclMapper;
  private readonly stateManager: CrawlStateManager;
  private readonly contentProcessor: ContentProcessor;
  private readonly config: ConnectorConfig;
  private objectTypes: string[] = [];

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
    logger.info(`=== INCREMENTAL CRAWL STARTING [${app.toUpperCase()}] ===`);
    await this.stateManager.markIncrementalCrawlStart();

    let totalProcessed = 0;
    let totalDeleted = 0;
    let totalErrors = 0;
    let latestStopTime = "";
    const tempDir = this.createWorkingDirectory(`veeva-incrcrawl-${app}`);

    // Load app profile object types
    const profile = getAppProfile(app);
    this.objectTypes = profile.knownObjectTypes;

    try {
      // Refresh ACL cache on each incremental run (15-min freshness)
      logger.info("Refreshing ACL cache for incremental crawl...");
      await this.aclMapper.refresh();

      const state = await this.stateManager.getState();
      const lastStopTime = state.lastIncrementalStopTime || state.lastFullCrawlStopTime;

      if (!lastStopTime) {
        logger.warn("No previous crawl checkpoint found. Run a full crawl first.");
        await this.stateManager.markCrawlFailed("No previous crawl checkpoint — full crawl required first");
        return { itemsProcessed: 0, itemsDeleted: 0, errors: 0, stopTime: "" };
      }

      logger.info(`Fetching incremental files since: ${lastStopTime}`);

      const files = await this.directData.listAvailableFiles({
        extractType: "incremental_directdata",
        startTime: lastStopTime,
      });

      if (files.length === 0) {
        logger.info("No incremental files available since last crawl");
        await this.stateManager.markIncrementalCrawlComplete(lastStopTime, 0, 0);
        return { itemsProcessed: 0, itemsDeleted: 0, errors: 0, stopTime: lastStopTime };
      }

      // Process in chronological order
      const orderedFiles = [...files].sort((a, b) => a.stop_time.localeCompare(b.stop_time));
      logger.info(`Found ${files.length} incremental file(s), ${orderedFiles.filter((f) => f.record_count > 0).length} with changes`);

      for (const fileInfo of orderedFiles) {
        if (fileInfo.record_count === 0) {
          latestStopTime = fileInfo.stop_time;
          await this.stateManager.updateIncrementalCheckpoint(latestStopTime, totalProcessed, totalDeleted);
          continue;
        }

        logger.info(`Processing incremental file: ${fileInfo.filename} (${fileInfo.record_count} records)`);

        try {
          const result = await this.processIncrementalFile(fileInfo, tempDir);
          totalProcessed += result.processed;
          totalDeleted += result.deleted;
          totalErrors += result.errors;
          // Only advance checkpoint AFTER successful processing
          latestStopTime = fileInfo.stop_time;
          await this.stateManager.updateIncrementalCheckpoint(latestStopTime, totalProcessed, totalDeleted);
        } catch (error: unknown) {
          await this.stateManager.updateIncrementalCheckpoint(latestStopTime || lastStopTime, totalProcessed, totalDeleted);
          throw new Error(
            `Failed to process incremental file ${fileInfo.filename}: ${error instanceof Error ? error.message : "unknown"}`
          );
        }
      }

      const finalStopTime = latestStopTime || lastStopTime;
      await this.stateManager.markIncrementalCrawlComplete(finalStopTime, totalProcessed, totalDeleted);
      logger.info(`=== INCREMENTAL CRAWL COMPLETE [${app.toUpperCase()}] === Processed: ${totalProcessed}, Deleted: ${totalDeleted}, Errors: ${totalErrors}`);

      return { itemsProcessed: totalProcessed, itemsDeleted: totalDeleted, errors: totalErrors, stopTime: finalStopTime };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Incremental crawl failed: ${message}`);
      await this.stateManager.markCrawlFailed(message);
      throw error;
    } finally {
      this.cleanupTempDir(tempDir);
    }
  }

  private async processIncrementalFile(
    fileInfo: DirectDataFileInfo,
    tempDir: string
  ): Promise<{ processed: number; deleted: number; errors: number }> {
    let processed = 0;
    let deleted = 0;
    let errors = 0;

    const filePath = await this.directData.downloadFile(fileInfo, tempDir);
    if (!filePath) return { processed, deleted, errors };

    const extractedData = await this.directData.extractFile(filePath);

    // Auto-discover additional object types from this file's manifest
    if (this.config.autoDiscoverObjects) {
      const manifest = this.directData.parseManifest(extractedData);
      this.objectTypes = discoverObjectTypes(manifest, this.objectTypes);
    }

    // Process updated documents (with lifecycle-aware ACLs)
    const docRecords = this.directData.getDocumentRecords(extractedData);
    for (const record of docRecords) {
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
        processed += items.length;
      } catch (error: unknown) {
        errors++;
        logger.warn(`Incremental: Failed to process document ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }

    // Process deleted documents
    const deletedDocs = this.directData.getDeletedDocumentRecords(extractedData);
    for (const record of deletedDocs) {
      try {
        const versionId = record.version_id || record.id || "";
        await this.graphClient.deleteItem(`doc-${versionId}`);
        deleted++;
      } catch (error: unknown) {
        errors++;
        logger.warn(`Incremental: Failed to delete document ${record.id}: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }

    // Process updated relationships
    const relRecords = this.directData.getRelationshipRecords(extractedData);
    for (const record of relRecords) {
      try {
        const item = this.contentProcessor.processRelationship(record);
        await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
        processed++;
      } catch { errors++; }
    }

    // Process deleted relationships
    const deletedRels = this.directData.getDeletedRelationshipRecords(extractedData);
    for (const record of deletedRels) {
      try {
        const relId = record.id || "";
        if (!relId) continue;
        await this.graphClient.deleteItem(`rel-${relId}`);
        deleted++;
      } catch { errors++; }
    }

    // Process updated objects (with per-object ACLs)
    for (const objectType of this.objectTypes) {
      const objRecords = this.directData.getObjectRecords(extractedData, objectType);
      for (const record of objRecords) {
        try {
          const item = this.contentProcessor.processVaultObject(record, objectType);
          const acl = await this.aclMapper.mapObjectAcl(objectType, record.id || "");
          await this.graphClient.upsertItem(item.itemId, item.properties, item.content, acl);
          processed++;
        } catch { errors++; }
      }

      const deletedObjs = this.directData.getDeletedObjectRecords(extractedData, objectType);
      for (const record of deletedObjs) {
        try {
          const objectId = record.id || record.object_id || "";
          if (!objectId) {
            errors++;
            logger.warn(`Incremental: Skipping deleted ${objectType} record with missing id`);
            continue;
          }
          await this.graphClient.deleteItem(`obj-${objectType}-${objectId}`);
          deleted++;
        } catch (error: unknown) {
          errors++;
          logger.warn(`Incremental: Failed to delete ${objectType} ${record.id || "unknown"}: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }
    }

    // Process workflows
    const workflowRecords = this.directData.getWorkflowRecords(extractedData);
    for (const record of workflowRecords) {
      try {
        const item = this.contentProcessor.processWorkflow(record);
        await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
        processed++;
      } catch { errors++; }
    }

    // Process picklists
    const picklistRecords = this.directData.getPicklistRecords(extractedData);
    for (const record of picklistRecords) {
      try {
        const item = this.contentProcessor.processPicklist(record);
        await this.graphClient.upsertItem(item.itemId, item.properties, item.content);
        processed++;
      } catch { errors++; }
    }

    // Permission-only sync: detect documents with role changes via audit log
    await this.syncPermissionChanges(fileInfo.start_time, fileInfo.stop_time, processed, errors);

    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }

    logger.info(`Incremental file processed: +${processed} updated, -${deleted} deleted, ${errors} errors`);
    return { processed, deleted, errors };
  }

  /**
   * Detect permission-only changes using Vault audit logs or VQL.
   * The Direct Data incremental extract only includes items with content/metadata changes.
   * If only permissions change (role added/removed), the item is NOT in the extract.
   * This method uses VQL to find documents with recent role modifications and re-applies ACLs.
   */
  private async syncPermissionChanges(
    startTime: string,
    stopTime: string,
    _processed: number,
    _errors: number
  ): Promise<void> {
    try {
      logger.info("Checking for permission-only changes...");

      // Query Vault audit trail for document role changes in the time window.
      // document_role__sys tracks when roles are assigned/unassigned on documents.
      const roleChanges = await this.vaultRest.executeVql(
        `SELECT DISTINCT document_id__v FROM document_role__sysr ` +
        `WHERE modified_date__v >= '${startTime}' AND modified_date__v <= '${stopTime}' ` +
        `LIMIT 500`
      ).catch(() => [] as Record<string, unknown>[]);

      if (roleChanges.length === 0) {
        // Fallback: query the audit log for permission-related events
        const auditChanges = await this.vaultRest.executeVql(
          `SELECT DISTINCT document_id__v FROM audit_trail__v ` +
          `WHERE timestamp__v >= '${startTime}' AND timestamp__v <= '${stopTime}' ` +
          `AND type__v IN ('Role Assign', 'Role Unassign', 'Role Change', 'Sharing') ` +
          `LIMIT 500`
        ).catch(() => [] as Record<string, unknown>[]);

        if (auditChanges.length === 0) {
          logger.info("No permission-only changes detected");
          return;
        }

        await this.reApplyDocumentAcls(auditChanges);
        return;
      }

      await this.reApplyDocumentAcls(roleChanges);
    } catch (error: unknown) {
      // Permission sync is best-effort — don't fail the crawl
      logger.warn(
        `Permission sync warning: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
  }

  /**
   * Re-fetch and re-apply ACLs for documents with detected permission changes.
   */
  private async reApplyDocumentAcls(
    records: Record<string, unknown>[]
  ): Promise<void> {
    const docIds = new Set<string>();
    for (const record of records) {
      const docId = String(record.document_id__v || record.id || "");
      if (docId) docIds.add(docId);
    }

    logger.info(`Re-applying ACLs for ${docIds.size} documents with permission changes`);

    let updated = 0;
    for (const docId of docIds) {
      try {
        const acl = await this.aclMapper.mapDocumentAcl(docId);
        // Re-upsert with only ACL change (no content update needed)
        const itemId = `doc_${docId}`;
        await this.graphClient.upsertItem(itemId, {}, undefined, acl);
        updated++;
      } catch (error: unknown) {
        logger.debug(
          `Failed to re-apply ACL for doc ${docId}: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }

    logger.info(`Permission sync complete: ${updated}/${docIds.size} document ACLs updated`);
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
