/**
 * Content Processor — Transforms Veeva Direct Data records into
 * Microsoft Graph external items for indexing.
 *
 * Handles all Vault applications (PromoMats, QualityDocs, RIM) with
 * application-aware metadata mapping.
 */

import { VaultRestClient } from "../veeva/vaultRestClient";
import { ConnectorConfig } from "../config/settings";
import { VaultApplication } from "../config/appProfiles";
import { logger } from "../utils/logger";

const MAX_CONTENT_SIZE = 4 * 1024 * 1024; // 4MB limit for Graph external items
const KNOWN_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "txt", "html",
  "htm", "rtf", "csv", "xml", "json", "zip", "png", "jpg", "jpeg",
  "gif", "svg", "mp4", "mp3", "wav", "avi",
]);

export interface ProcessedItem {
  itemId: string;
  properties: Record<string, unknown>;
  content: { value: string; type: "text" | "html" };
  entityType: "document" | "object" | "relationship" | "workflow" | "picklist";
}

const CHUNK_SIZE = 3_500_000; // ~3.5MB per chunk, leaving room for properties/ACL overhead

export class ContentProcessor {
  private readonly application: VaultApplication;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly vaultClient: VaultRestClient
  ) {
    this.application = config.vaultApplication;
  }

  async processDocument(
    record: Record<string, string>,
    options?: { fetchContent?: boolean }
  ): Promise<ProcessedItem[]> {
    const docId = this.extractDocumentId(record);
    const versionId = this.extractVersionId(record);
    if (!docId) {
      throw new Error("Cannot process document with missing doc_id and id");
    }
    if (!versionId) {
      throw new Error("Cannot process document with missing version_id and id");
    }
    const majorVersion = this.parseInteger(record.major_version_number);
    const minorVersion = this.parseInteger(record.minor_version_number);

    const itemId = `doc-${versionId}`;

    let contentText = "";
    if (options?.fetchContent !== false) {
      contentText = await this.getDocumentContent(record);
      if (contentText.length >= MAX_CONTENT_SIZE) {
        logger.warn(
          `Content truncated for doc ${record.doc_id || record.id}: ${contentText.length} bytes exceeds ${MAX_CONTENT_SIZE} limit`
        );
      }
    }

    // Base properties shared across all apps
    const properties: Record<string, unknown> = {
      docId,
      globalId: record.global_id__sys || "",
      documentNumber: record.document_number__v || "",
      title: record.title__v || record.name__v || record.filename__v || "",
      description: record.description__v || "",
      fileName: record.filename__v || "",
      fileExtension: this.extractExtension(record.filename__v || ""),
      status: record.status__v || "",
      lifecycle: record.lifecycle__v || "",
      versionId,
      majorVersion,
      minorVersion,
      versionLabel: `${majorVersion}.${minorVersion}`,
      documentType: record.type__v || record.type || "",
      documentSubtype: record.subtype__v || record.subtype || "",
      classification: record.classification__v || record.classification || "",
      format: record.format__v || "",
      itemPath: `${record.type__v || ""}/${record.subtype__v || ""}`,
      product: record.product__v || "",
      brand: record.branding__v || "",
      secondaryBrands: record.secondary_brands__v || "",
      country: record.country__v || "",
      language: record.language__v || "",
      tags: this.parseMultiValue(record.tags__v),
      authors: record.file_meta_author__v || record.created_by__v || "",
      createdDate: this.parseDate(record.created_date__v || record.document_creation_date__v),
      modifiedDate: this.parseDate(record.modified_date__v || record.version_modified_date__v),
      expirationDate: this.parseDate(record.expiration_date__v),
      createdBy: record.created_by__v || "",
      modifiedBy: record.modified_by__v || "",
      owner: record.owner__v || record.created_by__v || "",
      fileSize: this.parseInteger(record.size__v),
      relatedDocuments: this.parseMultiValue(record.related_documents__v),
      parentBinder: record.parent_binder__v || "",
      binderPath: record.binder_path__v || "",
      workflowStatus: record.workflow_status__v || record.workflow_status__sys || "",
      workflowType: record.workflow_type__v || record.workflow_type__sys || "",
      workflowDueDate: this.parseDate(record.workflow_due_date__v || record.due_date__sys),
      vaultDns: this.config.vaultDns,
      vaultUrl: `https://${this.config.vaultDns}/ui/#doc_info/${docId}`,
      entityType: "document",
      objectType: "",
      vaultApplication: this.application,
    };

    // Add application-specific properties
    this.addAppSpecificDocProperties(properties, record);

    // Set iconUrl based on file extension for Copilot display
    properties.iconUrl = this.getIconUrl(properties.fileExtension as string);

    // Build the full content
    const fullContent = contentText || this.buildMetadataContent(record);

    // Check if chunking is needed (content > CHUNK_SIZE bytes)
    if (Buffer.byteLength(fullContent, "utf8") > CHUNK_SIZE) {
      return this.chunkDocument(itemId, properties, fullContent);
    }

    return [{
      itemId,
      properties: { ...properties, parentDocumentId: "", chunkIndex: 0, totalChunks: 1 },
      content: { value: fullContent.substring(0, MAX_CONTENT_SIZE), type: "text" },
      entityType: "document",
    }];
  }

  processVaultObject(record: Record<string, string>, objectType: string): ProcessedItem {
    const id = record.id || "";
    if (!id) {
      throw new Error(`Cannot process ${objectType} with missing id`);
    }
    const itemId = `obj-${objectType}-${id}`;

    const properties: Record<string, unknown> = {
      docId: id,
      globalId: record.global_id__sys || "",
      title: record.name__v || record.label__v || `${objectType} ${id}`,
      description: record.description__v || "",
      status: record.status__v || "",
      createdDate: this.parseDate(record.created_date__v),
      modifiedDate: this.parseDate(record.modified_date__v),
      createdBy: record.created_by__v || "",
      modifiedBy: record.modified_by__v || "",
      product: record.product__v || "",
      country: record.country__v || "",
      vaultDns: this.config.vaultDns,
      vaultUrl: `https://${this.config.vaultDns}/ui/#object/${objectType}/${id}`,
      entityType: "object",
      objectType,
      vaultApplication: this.application,
    };

    // Add application-specific object properties
    this.addAppSpecificObjectProperties(properties, record, objectType);

    const contentParts = [
      `${objectType}: ${properties.title}`,
      record.description__v || "",
      ...Object.entries(record)
        .filter(([k, v]) => v && !k.startsWith("id") && !k.includes("date"))
        .map(([k, v]) => `${k}: ${v}`),
    ];

    return {
      itemId,
      properties,
      content: { value: contentParts.join("\n").substring(0, MAX_CONTENT_SIZE), type: "text" },
      entityType: "object",
    };
  }

  processRelationship(record: Record<string, string>): ProcessedItem {
    const id =
      record.id ||
      [record.source_doc_id__v, record.target_doc_id__v, record.relationship_type__v]
        .filter(Boolean)
        .join("_");
    if (!id) {
      throw new Error("Cannot process relationship with missing identifiers");
    }
    const itemId = `rel-${id}`;

    const properties: Record<string, unknown> = {
      docId: id,
      title: `${record.relationship_type__v || "Related"}: ${record.source_doc_id__v} → ${record.target_doc_id__v}`,
      relatedDocuments: [record.source_doc_id__v, record.target_doc_id__v].filter(Boolean),
      createdDate: this.parseDate(record.created_date__v),
      modifiedDate: this.parseDate(record.modified_date__v),
      vaultDns: this.config.vaultDns,
      entityType: "relationship",
      objectType: "document_relationship",
      vaultApplication: this.application,
    };

    return {
      itemId,
      properties,
      content: {
        value: `Document relationship: ${record.source_doc_id__v} (${record.relationship_type__v}) ${record.target_doc_id__v}`.substring(0, MAX_CONTENT_SIZE),
        type: "text",
      },
      entityType: "relationship",
    };
  }

  processWorkflow(record: Record<string, string>): ProcessedItem {
    const id = record.id || record.workflow_id__sys || "";
    if (!id) {
      throw new Error("Cannot process workflow with missing id");
    }
    const itemId = `workflow-${id}`;
    const title = record.workflow_label__sys || record.name__v || `Workflow ${id}`;

    const properties: Record<string, unknown> = {
      docId: id,
      title,
      description: record.description__v || "",
      status: record.workflow_status__sys || "",
      workflowStatus: record.workflow_status__sys || "",
      workflowType: record.workflow_type__sys || "",
      workflowDueDate: this.parseDate(record.due_date__sys),
      createdDate: this.parseDate(record.start_date__sys || record.created_date__v),
      modifiedDate: this.parseDate(record.modified_date__v || record.completion_date__sys),
      createdBy: record.created_by__v || "",
      modifiedBy: record.modified_by__v || "",
      owner: record.workflow_owner__sys || "",
      vaultDns: this.config.vaultDns,
      vaultUrl: `https://${this.config.vaultDns}/ui/#workflow/${id}`,
      entityType: "workflow",
      objectType: "workflow__sys",
      vaultApplication: this.application,
    };

    const content = [
      `Workflow: ${title}`,
      `Status: ${record.workflow_status__sys || ""}`,
      `Type: ${record.workflow_type__sys || ""}`,
      `Owner: ${record.workflow_owner__sys || ""}`,
    ].filter(Boolean).join("\n");

    return {
      itemId,
      properties,
      content: { value: content.substring(0, MAX_CONTENT_SIZE), type: "text" },
      entityType: "workflow",
    };
  }

  processPicklist(record: Record<string, string>): ProcessedItem {
    const object = record.object || "";
    const field = record.object_field || "";
    const valueName = record.picklist_value_name || "";
    if (!object || !field || !valueName) {
      throw new Error("Cannot process picklist with missing object, field, or value");
    }
    const itemId = `picklist-${object}-${field}-${valueName}`;
    const title = record.picklist_value_label || valueName || "Picklist Value";

    const properties: Record<string, unknown> = {
      docId: `${object}.${field}.${valueName}`,
      title,
      description: `${object}.${field}`,
      status: record.status__v || "",
      createdDate: null,
      modifiedDate: this.parseDate(record.modified_date__v),
      vaultDns: this.config.vaultDns,
      vaultUrl: `https://${this.config.vaultDns}/ui/#object/${object}`,
      entityType: "picklist",
      objectType: "picklist__sys",
      vaultApplication: this.application,
    };

    return {
      itemId,
      properties,
      content: {
        value: `Picklist value ${title} for ${object}.${field}`.substring(0, MAX_CONTENT_SIZE),
        type: "text",
      },
      entityType: "picklist",
    };
  }

  /**
   * Build pre-computed summary items for aggregate queries.
   * Best practice: LLMs cannot reliably aggregate across many items,
   * so we ingest summary items with pre-calculated counts/totals.
   */
  buildSummaryItems(
    documents: Array<Record<string, string>>,
    objects: Map<string, Array<Record<string, string>>>
  ): ProcessedItem[] {
    const summaries: ProcessedItem[] = [];
    const now = new Date().toISOString().split("T")[0];

    // Document count summary by status
    const statusCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    for (const doc of documents) {
      const status = doc.status__v || "unknown";
      const docType = doc.type__v || "unknown";
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      typeCounts.set(docType, (typeCounts.get(docType) || 0) + 1);
    }

    const statusBreakdown = [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `${s}: ${c}`)
      .join(", ");
    const typeBreakdown = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}: ${c}`)
      .join(", ");

    summaries.push({
      itemId: `summary-docs-${this.application}-${now}`,
      properties: {
        docId: `summary-docs-${now}`,
        title: `${this.application.toUpperCase()} Document Summary — ${now}`,
        description: `Pre-computed summary of all ${documents.length} documents`,
        entityType: "object",
        objectType: "summary_report",
        vaultApplication: this.application,
        vaultDns: this.config.vaultDns,
        vaultUrl: `https://${this.config.vaultDns}/ui/`,
        status: "current",
        createdDate: new Date().toISOString(),
        modifiedDate: new Date().toISOString(),
      },
      content: {
        value: [
          `${this.application.toUpperCase()} Document Summary as of ${now}`,
          `Total documents: ${documents.length}`,
          `By status: ${statusBreakdown}`,
          `By type: ${typeBreakdown}`,
          "",
          ...([...objects.entries()].map(
            ([objType, records]) => `${objType}: ${records.length} records`
          )),
        ].join("\n"),
        type: "text",
      },
      entityType: "object",
    });

    return summaries;
  }

  // --- Chunking for large documents ---

  private chunkDocument(
    baseItemId: string,
    properties: Record<string, unknown>,
    fullContent: string
  ): ProcessedItem[] {
    const chunks: ProcessedItem[] = [];
    const contentBytes = Buffer.from(fullContent, "utf8");
    const totalChunks = Math.ceil(contentBytes.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, contentBytes.length);
      const chunkContent = contentBytes.subarray(start, end).toString("utf8");

      // Contextual header on each chunk per best practices
      const header = `[Chunk ${i + 1} of ${totalChunks}] ${properties.title || ""} (${properties.documentType || ""})`;
      const chunkValue = `${header}\n\n${chunkContent}`;

      chunks.push({
        itemId: totalChunks === 1 ? baseItemId : `${baseItemId}_chunk${i}`,
        properties: {
          ...properties,
          parentDocumentId: baseItemId,
          chunkIndex: i,
          totalChunks,
        },
        content: { value: chunkValue.substring(0, MAX_CONTENT_SIZE), type: "text" },
        entityType: "document",
      });
    }

    return chunks;
  }

  private getIconUrl(fileExtension: string): string {
    const ext = (fileExtension || "").toLowerCase();
    const iconMap: Record<string, string> = {
      pdf: "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/pdf.svg",
      docx: "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/docx.svg",
      doc: "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/docx.svg",
      pptx: "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/pptx.svg",
      xlsx: "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/xlsx.svg",
      html: "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/code.svg",
    };
    return iconMap[ext] || "https://res-1.cdn.office.net/files/fabric-cdn-prod_20240411.001/assets/item-types/48/genericfile.svg";
  }

  // --- Application-specific property mappers ---

  private addAppSpecificDocProperties(
    properties: Record<string, unknown>,
    record: Record<string, string>
  ): void {
    switch (this.application) {
      case "promomats":
        properties.keyMessages = record.key_message__v || "";
        properties.claim = record.claim__v || "";
        properties.audience = record.audience__v || "";
        properties.channel = record.channel__v || "";
        properties.mlrStatus = record.mlr_status__v || "";
        properties.promotionalType = record.promotional_type__v || "";
        break;

      case "qualitydocs":
        properties.effectiveDate = this.parseDate(record.effective_date__v);
        properties.periodicReviewDate = this.parseDate(record.periodic_review_date__v || record.next_review_date__v);
        properties.trainingRequired = this.parseBoolean(record.training_required__v);
        properties.facility = record.facility__v || "";
        properties.department = record.department__v || "";
        properties.qualityEventType = record.quality_event_type__v || "";
        properties.capaNumber = record.capa_number__v || "";
        properties.deviationNumber = record.deviation_number__v || "";
        properties.complaintNumber = record.complaint_number__v || "";
        properties.changeControlNumber = record.change_control_number__v || "";
        properties.auditType = record.audit_type__v || "";
        break;

      case "rim":
        properties.applicationNumber = record.application_number__v || record.application__v || "";
        properties.submissionType = record.submission_type__v || "";
        properties.regulatoryObjective = record.regulatory_objective__v || "";
        properties.registrationStatus = record.registration_status__v || "";
        properties.healthAuthority = record.health_authority__v || "";
        properties.dossierSection = record.dossier_section__v || record.ctd_section__v || "";
        properties.contentPlanItem = record.content_plan_item__v || "";
        properties.marketCountry = record.market__v || record.country__v || "";
        properties.submissionDate = this.parseDate(record.submission_date__v);
        properties.approvalDate = this.parseDate(record.approval_date__v);
        break;
    }
  }

  private addAppSpecificObjectProperties(
    properties: Record<string, unknown>,
    record: Record<string, string>,
    objectType: string
  ): void {
    switch (this.application) {
      case "qualitydocs":
        if (objectType.includes("capa")) {
          properties.capaNumber = record.capa_number__v || record.name__v || "";
        } else if (objectType.includes("deviation")) {
          properties.deviationNumber = record.deviation_number__v || record.name__v || "";
        } else if (objectType.includes("complaint")) {
          properties.complaintNumber = record.complaint_number__v || record.name__v || "";
        } else if (objectType.includes("change_control")) {
          properties.changeControlNumber = record.change_control_number__v || record.name__v || "";
        } else if (objectType.includes("audit")) {
          properties.auditType = record.audit_type__v || "";
        } else if (objectType.includes("facility")) {
          properties.facility = record.name__v || "";
        }
        break;

      case "rim":
        if (objectType.includes("application")) {
          properties.applicationNumber = record.application_number__v || record.name__v || "";
        } else if (objectType.includes("submission")) {
          properties.submissionType = record.submission_type__v || "";
          properties.submissionDate = this.parseDate(record.submission_date__v);
        } else if (objectType.includes("registration")) {
          properties.registrationStatus = record.registration_status__v || record.status__v || "";
        } else if (objectType.includes("health_authority")) {
          properties.healthAuthority = record.name__v || "";
        } else if (objectType.includes("regulatory_objective")) {
          properties.regulatoryObjective = record.name__v || "";
        } else if (objectType.includes("content_plan")) {
          properties.contentPlanItem = record.name__v || "";
        }
        break;

      default:
        break;
    }
  }

  // --- Private helpers ---

  private async getDocumentContent(record: Record<string, string>): Promise<string> {
    if (record.text_file) {
      try {
        const text = await this.vaultClient.downloadTextFromUrl(record.text_file);
        if (text) return text;
      } catch {
        // Fall through to REST API
      }
    }

    const docId = this.extractDocumentId(record);
    const major = parseInt(record.major_version_number || "0", 10);
    const minor = parseInt(record.minor_version_number || "0", 10);

    if (docId) {
      try {
        return await this.vaultClient.downloadDocumentText(docId, major, minor);
      } catch (error: unknown) {
        logger.debug(
          `Content download failed for ${docId}: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }

    return this.buildMetadataContent(record);
  }

  private buildMetadataContent(record: Record<string, string>): string {
    const parts = [
      record.title__v || record.name__v || "",
      record.document_number__v ? `Document Number: ${record.document_number__v}` : "",
      record.description__v || "",
      record.type__v ? `Type: ${record.type__v}` : "",
      record.subtype__v ? `Subtype: ${record.subtype__v}` : "",
      record.status__v ? `Status: ${record.status__v}` : "",
      record.product__v ? `Product: ${record.product__v}` : "",
      record.country__v ? `Country: ${record.country__v}` : "",
      record.language__v ? `Language: ${record.language__v}` : "",
      record.key_message__v || "",
      record.claim__v ? `Claim: ${record.claim__v}` : "",
      record.tags__v ? `Tags: ${record.tags__v}` : "",
      record.owner__v ? `Owner: ${record.owner__v}` : "",
    ].filter(Boolean);
    return parts.join("\n");
  }

  private extractExtension(filename: string): string {
    const parts = filename.split(".");
    if (parts.length < 2) return "";
    const lastPart = parts[parts.length - 1].toLowerCase();
    return KNOWN_EXTENSIONS.has(lastPart) ? lastPart : (parts.length > 1 ? lastPart : "");
  }

  private parseMultiValue(value: string | undefined): string[] {
    if (!value) return [];
    return value.split(/[,;|]/).map((v) => v.trim()).filter(Boolean);
  }

  private parseDate(value: string | undefined): string | null {
    if (!value) return null;
    try {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
      return null;
    }
  }

  private parseBoolean(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return ["true", "true__v", "yes", "yes__v", "1", "y"].includes(normalized);
  }

  private parseInteger(value: string | undefined): number {
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private extractDocumentId(record: Record<string, string>): string {
    if (record.doc_id) return record.doc_id;
    const rawId = record.id || "";
    const delimiterIndex = rawId.indexOf("_");
    return delimiterIndex > 0 ? rawId.substring(0, delimiterIndex) : "";
  }

  private extractVersionId(record: Record<string, string>): string {
    return record.version_id || record.id || "";
  }
}
