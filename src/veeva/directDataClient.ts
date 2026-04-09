/**
 * Veeva Vault Direct Data API Client
 *
 * Handles listing, downloading, and extracting Direct Data files
 * (Full, Incremental, and Log extracts).
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { pipeline } from "stream/promises";
import * as tar from "tar-stream";
import { parse as csvParse } from "csv-parse";
import { VeevaAuthClient } from "./authClient";
import {
  DirectDataFileInfo,
  DirectDataListResponse,
  ManifestEntry,
  MetadataEntry,
} from "../models/types";
import { logger } from "../utils/logger";

export class DirectDataClient {
  constructor(private readonly authClient: VeevaAuthClient) {}

  /**
   * List available Direct Data files, optionally filtered by type and time range.
   */
  async listAvailableFiles(options: {
    extractType?: "full_directdata" | "incremental_directdata" | "log_directdata";
    startTime?: string;
    stopTime?: string;
  }): Promise<DirectDataFileInfo[]> {
    const params = new URLSearchParams();
    if (options.extractType) params.set("extract_type", options.extractType);
    if (options.startTime) params.set("start_time", options.startTime);
    if (options.stopTime) params.set("stop_time", options.stopTime);

    const url = `/services/directdata/files${params.toString() ? "?" + params.toString() : ""}`;
    logger.info(`Listing Direct Data files: ${url}`);

    const response = await this.authClient.executeWithRetry(
      "listAvailableFiles",
      (client) => client.get<DirectDataListResponse>(url)
    );

    if (response.data.responseStatus !== "SUCCESS") {
      throw new Error(
        `Failed to list Direct Data files: ${response.data.responseMessage || response.data.responseStatus}`
      );
    }

    const files = response.data.data || [];
    logger.info(`Found ${files.length} Direct Data file(s)`);
    return files;
  }

  /**
   * Download a Direct Data file to a temporary directory.
   * Handles multi-part files automatically.
   */
  async downloadFile(
    fileInfo: DirectDataFileInfo,
    targetDir: string
  ): Promise<string> {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const outputPath = path.join(targetDir, fileInfo.filename);
    logger.info(
      `Downloading Direct Data file: ${fileInfo.filename} (${fileInfo.fileparts} part(s), ${fileInfo.record_count} records)`
    );

    if (fileInfo.record_count === 0) {
      logger.info("File has zero records, skipping download");
      return "";
    }

    if (!fileInfo.filepart_details?.length) {
      throw new Error(`Direct Data file '${fileInfo.filename}' has no downloadable parts`);
    }

    if (fileInfo.fileparts <= 1) {
      // Single part download
      const partUrl = fileInfo.filepart_details[0].url;
      await this.downloadPart(partUrl, outputPath);
    } else {
      // Multi-part: download all parts and concatenate
      const partPaths: string[] = [];
      const sortedParts = [...fileInfo.filepart_details].sort((a, b) =>
        this.getPartOrder(a.filename) - this.getPartOrder(b.filename)
      );
      if (sortedParts.length !== fileInfo.fileparts) {
        throw new Error(
          `Direct Data file '${fileInfo.filename}' expected ${fileInfo.fileparts} parts but got ${sortedParts.length}`
        );
      }
      for (const part of sortedParts) {
        const partPath = path.join(targetDir, part.filename);
        await this.downloadPart(part.url, partPath);
        partPaths.push(partPath);
      }
      await this.concatenateFiles(partPaths, outputPath);
      // Clean up part files
      for (const p of partPaths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }

    logger.info(`Downloaded: ${outputPath}`);
    return outputPath;
  }

  /**
   * Extract a downloaded .tar.gz Direct Data file.
   * Returns parsed CSV data organized by extract name.
   */
  async extractFile(
    filePath: string
  ): Promise<Map<string, Record<string, string>[]>> {
    logger.info(`Extracting Direct Data file: ${filePath}`);

    const results = new Map<string, Record<string, string>[]>();

    return new Promise((resolve, reject) => {
      const extract = tar.extract();
      const gunzip = zlib.createGunzip();

      extract.on("entry", (header, stream, next) => {
        const entryName = header.name;
        stream.on("error", next);

        if (entryName.endsWith(".csv")) {
          this.parseCsvStream(stream, entryName)
            .then((records) => {
              results.set(entryName, records);
              next();
            })
            .catch((err) => {
              logger.warn(`Failed to parse ${entryName}: ${err.message}`);
              stream.resume();
              next();
            });
        } else {
          stream.resume();
          stream.on("end", next);
        }
      });

      extract.on("finish", () => {
        logger.info(
          `Extracted ${results.size} CSV file(s) from Direct Data archive`
        );
        resolve(results);
      });

      extract.on("error", reject);

      const readStream = fs.createReadStream(filePath);
      readStream.pipe(gunzip).pipe(extract);

      readStream.on("error", reject);
      gunzip.on("error", reject);
    });
  }

  /**
   * Parse the manifest.csv to get an overview of all extracts in the file.
   */
  parseManifest(
    extractedData: Map<string, Record<string, string>[]>
  ): ManifestEntry[] {
    const manifestKey = [...extractedData.keys()].find((k) =>
      k.endsWith("manifest.csv")
    );
    if (!manifestKey) {
      logger.warn("No manifest.csv found in extracted data");
      return [];
    }

    const rows = extractedData.get(manifestKey)!;
    return rows.map((row) => ({
      extract: row.extract || "",
      extract_label: row.extract_label || "",
      type: (row.type || "updates") as "updates" | "deletes",
      records: parseInt(row.records || "0", 10),
      file: row.file || "",
    }));
  }

  /**
   * Parse the metadata.csv for schema information.
   */
  parseMetadata(
    extractedData: Map<string, Record<string, string>[]>
  ): MetadataEntry[] {
    const metadataKey = [...extractedData.keys()].find(
      (k) => k.endsWith("metadata.csv") || k.endsWith("metadata_full.csv")
    );
    if (!metadataKey) {
      logger.warn("No metadata.csv found in extracted data");
      return [];
    }

    const rows = extractedData.get(metadataKey)!;
    return rows.map((row) => ({
      modified_date: row.modified_date || null,
      extract: row.extract || "",
      extract_label: row.extract_label || "",
      column_name: row.column_name || "",
      column_label: row.column_label || "",
      type: row.type || "",
      length: row.length ? parseInt(row.length, 10) : null,
      related_extract: row.related_extract || null,
    }));
  }

  /**
   * Get documents from extracted data.
   */
  getDocumentRecords(
    extractedData: Map<string, Record<string, string>[]>
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      /^document_version__sys(?:_\d+)?\.csv$/i.test(filename)
    );
  }

  /**
   * Get deleted document records from extracted data.
   */
  getDeletedDocumentRecords(
    extractedData: Map<string, Record<string, string>[]>
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      /^document_version__sys_deletes(?:_\d+)?\.csv$/i.test(filename)
    );
  }

  /**
   * Get document relationships from extracted data.
   */
  getRelationshipRecords(
    extractedData: Map<string, Record<string, string>[]>
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      /^document_relationship__sys(?:_\d+)?\.csv$/i.test(filename)
    );
  }

  /**
   * Get deleted document relationships from extracted data.
   */
  getDeletedRelationshipRecords(
    extractedData: Map<string, Record<string, string>[]>
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      /^document_relationship__sys_deletes(?:_\d+)?\.csv$/i.test(filename)
    );
  }

  /**
   * Get Vault object records for a given object name.
   */
  getObjectRecords(
    extractedData: Map<string, Record<string, string>[]>,
    objectName: string
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      new RegExp(`^${escapeRegExp(objectName)}(?:_\\d+)?\\.csv$`, "i").test(filename)
    );
  }

  /**
   * Get deleted object records for a given object name.
   */
  getDeletedObjectRecords(
    extractedData: Map<string, Record<string, string>[]>,
    objectName: string
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      new RegExp(`^${escapeRegExp(objectName)}_deletes(?:_\\d+)?\\.csv$`, "i").test(filename)
    );
  }

  /**
   * Get workflow records from extracted data.
   */
  getWorkflowRecords(
    extractedData: Map<string, Record<string, string>[]>
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      /^workflow__sys(?:_\d+)?\.csv$/i.test(filename)
    );
  }

  /**
   * Get picklist records from extracted data.
   */
  getPicklistRecords(
    extractedData: Map<string, Record<string, string>[]>
  ): Record<string, string>[] {
    return this.getMatchingRecords(extractedData, (filename) =>
      /^picklist__sys(?:_\d+)?\.csv$/i.test(filename)
    );
  }

  // --- Private helpers ---

  private async downloadPart(
    url: string,
    outputPath: string
  ): Promise<void> {
    const response = await this.authClient.executeWithRetry(
      `downloadPart:${path.basename(outputPath)}`,
      (client) =>
        client.get(url, {
          responseType: "stream",
          timeout: 600000, // 10 min timeout for large files
        }),
      { maxAttempts: 3 }
    );

    const writer = fs.createWriteStream(outputPath);
    await pipeline(response.data, writer);
  }

  private async concatenateFiles(
    partPaths: string[],
    outputPath: string
  ): Promise<void> {
    const writer = fs.createWriteStream(outputPath);
    try {
      for (const partPath of partPaths) {
        const reader = fs.createReadStream(partPath);
        await pipeline(reader, writer, { end: false });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
        writer.end();
      });
    }
  }

  private async parseCsvStream(
    csvStream: NodeJS.ReadableStream,
    filename: string
  ): Promise<Record<string, string>[]> {
    return new Promise((resolve, reject) => {
      const records: Record<string, string>[] = [];
      const parser = csvParse({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      });

      csvStream.on("error", reject);
      csvStream.pipe(parser);

      parser.on("readable", () => {
        let record: Record<string, string>;
        while ((record = parser.read()) !== null) {
          if (Object.keys(record).length === 0) {
            logger.warn(`Skipping empty row in ${filename}`);
            continue;
          }
          records.push(record);
        }
      });

      parser.on("end", () => resolve(records));
      parser.on("error", reject);
    });
  }

  private getPartOrder(filename: string): number {
    const matches = filename.match(/(\d+)(?!.*\d)/);
    return matches ? parseInt(matches[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  private getMatchingRecords(
    extractedData: Map<string, Record<string, string>[]>,
    predicate: (filename: string) => boolean
  ): Record<string, string>[] {
    const records: Record<string, string>[] = [];

    for (const [key, value] of extractedData.entries()) {
      const filename = key.split(/[\\/]/).pop() || key;
      if (predicate(filename)) {
        records.push(...value);
      }
    }

    return records;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
