/**
 * Type definitions for Veeva Vault data structures used throughout the connector.
 */

// --- Direct Data API types ---

export interface DirectDataFileInfo {
  name: string;
  filename: string;
  extract_type: "full_directdata" | "incremental_directdata" | "log_directdata";
  start_time: string;
  stop_time: string;
  record_count: number;
  fileparts: number;
  filepart_details: DirectDataFilePart[];
}

export interface DirectDataFilePart {
  filename: string;
  url: string;
  size: number;
}

export interface DirectDataListResponse {
  responseStatus: string;
  responseMessage?: string;
  data: DirectDataFileInfo[];
  errors?: Array<{ type: string; message: string }>;
}

export interface ManifestEntry {
  extract: string;
  extract_label: string;
  type: "updates" | "deletes";
  records: number;
  file: string;
}

export interface MetadataEntry {
  modified_date: string | null;
  extract: string;
  extract_label: string;
  column_name: string;
  column_label: string;
  type: string;
  length: number | null;
  related_extract: string | null;
}

// --- Vault Document types ---

export interface VaultDocument {
  id: string;
  doc_id: string;
  version_id: string;
  major_version_number: number;
  minor_version_number: number;
  title__v?: string;
  name__v?: string;
  description__v?: string;
  document_number__v?: string;
  global_id__sys?: string;
  filename__v?: string;
  status__v?: string;
  type__v?: string;
  subtype__v?: string;
  classification__v?: string;
  lifecycle__v?: string;
  product__v?: string;
  country__v?: string;
  branding__v?: string;
  secondary_brands__v?: string;
  key_message__v?: string;
  tags__v?: string;
  format__v?: string;
  size__v?: number;
  created_by__v?: string;
  created_date__v?: string;
  modified_by__v?: string;
  modified_date__v?: string;
  source_file?: string;
  rendition_file?: string;
  text_file?: string;
  [key: string]: unknown;
}

export interface VaultDocumentRelationship {
  id: string;
  source_doc_id__v: string;
  source_version_id: string;
  target_doc_id__v: string;
  target_version_id: string;
  relationship_type__v: string;
  source_vault_id__v?: string;
  created_date__v?: string;
  created_by__v?: string;
  modified_date__v?: string;
  modified_by__v?: string;
}

// --- Vault Object types ---

export interface VaultObject {
  id: string;
  name__v: string;
  status__v?: string;
  global_id__sys?: string;
  created_by__v?: string;
  created_date__v?: string;
  modified_by__v?: string;
  modified_date__v?: string;
  [key: string]: unknown;
}

// --- Vault Workflow types ---

export interface VaultWorkflow {
  id: string;
  workflow_label__sys?: string;
  workflow_owner__sys?: string;
  workflow_type__sys?: string;
  workflow_status__sys?: string;
  start_date__sys?: string;
  due_date__sys?: string;
  completion_date__sys?: string;
  [key: string]: unknown;
}

// --- Vault Picklist types ---

export interface VaultPicklist {
  object: string;
  object_field: string;
  picklist_value_name: string;
  picklist_value_label: string;
  status__v: string;
  modified_date__v?: string;
}

// --- Vault Auth types ---

export interface VaultAuthResponse {
  responseStatus: string;
  sessionId: string;
  userId: number;
  vaultId: number;
  vaultIds?: Array<{ id: number; name: string; url: string }>;
}

// --- Crawl State types ---

export interface CrawlState {
  partitionKey: string;
  rowKey: string;
  etag?: string;
  lastFullCrawlTime?: string;
  lastIncrementalCrawlTime?: string;
  lastFullCrawlStopTime?: string;
  lastIncrementalStopTime?: string;
  crawlStatus: "idle" | "running" | "failed";
  currentCrawlType?: "full" | "incremental";
  crawlStartedAt?: string;
  errorMessage?: string;
  itemsProcessed?: number;
  itemsDeleted?: number;

  // Progress tracking (for long-running crawls)
  totalItems?: number;
  currentPhase?: string;
  lastHeartbeat?: string;
  itemsPerMinute?: number;
  estimatedCompletionAt?: string;
  fullCrawlResumeIndex?: number;
  fullCrawlDataFile?: string;
}

// --- ACL types ---

export interface VaultAcl {
  documentId: string;
  principals: VaultPrincipal[];
}

export interface VaultPrincipal {
  type: "user" | "group";
  id: string;
  name: string;
  email?: string;
  federatedId?: string;
  role?: string;
}

// --- Content extraction ---

export interface ExtractedContent {
  text: string;
  contentType: "text" | "html";
  truncated: boolean;
}
