/**
 * Unified Schema Factory — Builds Graph connector schemas per Vault application.
 *
 * Base schema properties are shared across all applications. Each app profile
 * adds application-specific properties (e.g., QualityDocs adds effectiveDate,
 * RIM adds submissionType).
 */

import { VaultApplication, getAppProfile, SchemaExtension } from "../config/appProfiles";
import { GraphApiVersion } from "../config/settings";

type PropertyType = "String" | "Int64" | "Double" | "DateTime" | "Boolean" | "StringCollection";

type ImportanceScore = "low" | "medium" | "high" | "veryHigh";

interface RankingHint {
  importanceScore: ImportanceScore;
}

interface ConnectorProperty {
  name: string;
  type: PropertyType;
  isQueryable: boolean;
  isRetrievable: boolean;
  isSearchable: boolean;
  isRefinable: boolean;
  isExactMatchRequired?: boolean;
  description: string;
  aliases?: string[];
  labels?: string[];
  rankingHint?: RankingHint;
}

interface ConnectorSchema {
  baseType: "microsoft.graph.externalItem";
  properties: ConnectorProperty[];
}

const ALLOWED_LABELS = new Set([
  "title", "url", "createdBy", "lastModifiedBy", "authors",
  "createdDateTime", "lastModifiedDateTime", "fileName", "fileExtension", "iconUrl",
  "containerName", "containerUrl",
  "assignedTo", "dueDate", "closedDate", "closedBy", "reportedBy",
  "sprintName", "severity", "state", "priority", "secondaryId",
  "itemParentId", "parentUrl", "tags", "itemType", "itemPath", "numReactions",
]);

const NAME_PATTERN = /^[A-Za-z0-9]+$/;

// Ranking hints for Beta API — controls search relevance importance per property
const RANKING_HINTS: Record<string, ImportanceScore> = {
  title: "veryHigh",
  description: "veryHigh",
  documentNumber: "veryHigh",
  status: "high",
  documentType: "high",
  product: "high",
  tags: "high",
  authors: "high",
  fileName: "high",
  brand: "medium",
  country: "medium",
  classification: "medium",
  workflowStatus: "medium",
  documentSubtype: "medium",
  lifecycle: "medium",
  owner: "medium",
  vaultApplication: "medium",
  entityType: "medium",
};

/**
 * Get the connector schema for a specific Vault application.
 * Combines base properties + application-specific extensions.
 * When apiVersion is "beta", properties include rankingHint for search relevance.
 */
export function getSchemaForApp(application: VaultApplication, apiVersion: GraphApiVersion = "v1.0"): ConnectorSchema {
  const baseProperties = getBaseProperties(apiVersion);
  const profile = getAppProfile(application);
  const extProperties = profile.schemaExtensions.map((ext) => extToProperty(ext, apiVersion));
  const allProperties = [...baseProperties, ...extProperties];
  const names = allProperties.map((p) => p.name);
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    const dupes = [...new Set(duplicateNames)].join(", ");
    throw new Error(`Duplicate schema property names for app '${application}': ${dupes}`);
  }

  return {
    baseType: "microsoft.graph.externalItem",
    properties: allProperties,
  };
}

/**
 * Base properties shared across all Vault applications.
 */
function getBaseProperties(apiVersion: GraphApiVersion): ConnectorProperty[] {
  return [
    // --- Core Document Properties ---
    { ...prop("docId", "String", true, true, false, false, "Internal document or object ID", apiVersion), isExactMatchRequired: true },
    { ...prop("globalId", "String", true, true, false, false, "Global unique ID across Vaults", apiVersion), isExactMatchRequired: true },
    { ...prop("documentNumber", "String", true, true, true, false, "System-assigned document number", apiVersion), isExactMatchRequired: true },
    prop("title", "String", true, true, true, false, "Document or object title", apiVersion),
    prop("description", "String", false, true, true, false, "Description or summary text", apiVersion),
    prop("fileName", "String", true, true, true, false, "Source file name", apiVersion),
    prop("fileExtension", "String", true, true, true, true, "File type extension", apiVersion),
    prop("status", "String", true, true, true, true, "Lifecycle status", apiVersion),
    prop("lifecycle", "String", true, true, false, true, "Lifecycle name", apiVersion),

    // --- Version Properties ---
    { ...prop("versionId", "String", true, true, false, false, "Document version ID", apiVersion), isExactMatchRequired: true },
    prop("majorVersion", "Int64", true, true, false, false, "Major version number", apiVersion),
    prop("minorVersion", "Int64", true, true, false, false, "Minor version number", apiVersion),
    prop("versionLabel", "String", true, true, true, false, "Version label eg 2.1", apiVersion),

    // --- Classification Properties ---
    prop("documentType", "String", true, true, true, true, "Top-level document type", apiVersion),
    prop("documentSubtype", "String", true, true, true, true, "Document subtype", apiVersion),
    prop("classification", "String", true, true, true, true, "Document classification", apiVersion),
    prop("format", "String", true, true, false, true, "Document format", apiVersion),
    prop("itemPath", "String", true, true, false, false, "Hierarchical type and subtype path", apiVersion),

    // --- Product & Brand Properties ---
    prop("product", "String", true, true, true, true, "Associated product", apiVersion),
    prop("brand", "String", true, true, true, true, "Primary brand", apiVersion),
    prop("secondaryBrands", "String", true, true, true, true, "Secondary brands", apiVersion),

    // --- Geographic & Localization ---
    prop("country", "String", true, true, true, true, "Country or region", apiVersion),
    prop("language", "String", true, true, true, true, "Content language", apiVersion),

    // --- Tags & Metadata ---
    prop("tags", "StringCollection", true, true, true, true, "Tags and keywords", apiVersion),
    prop("authors", "String", true, true, true, true, "Document authors", apiVersion),

    // --- Dates ---
    prop("createdDate", "DateTime", true, true, false, false, "Creation date", apiVersion),
    prop("modifiedDate", "DateTime", true, true, false, false, "Last modified date", apiVersion),
    prop("expirationDate", "DateTime", true, true, false, false, "Expiration date", apiVersion),

    // --- People ---
    prop("createdBy", "String", true, true, true, false, "Creator", apiVersion),
    prop("modifiedBy", "String", true, true, true, false, "Last modifier", apiVersion),
    prop("owner", "String", true, true, true, false, "Owner", apiVersion),

    // --- Size ---
    prop("fileSize", "Int64", true, true, false, false, "File size in bytes", apiVersion),

    // --- Relationships ---
    prop("relatedDocuments", "StringCollection", true, true, true, false, "Related document IDs", apiVersion),
    prop("parentBinder", "String", true, true, true, false, "Parent binder or container name", apiVersion),
    prop("binderPath", "String", true, true, true, false, "Binder hierarchy path", apiVersion),

    // --- Icon URL for Copilot surfacing ---
    prop("iconUrl", "String", true, true, false, false, "Icon URL for Copilot result display", apiVersion),

    // --- Chunking Properties (for large documents) ---
    { ...prop("parentDocumentId", "String", true, true, false, false, "Parent document ID when chunked", apiVersion), isExactMatchRequired: true },
    prop("chunkIndex", "Int64", true, true, false, false, "Chunk index within the parent document", apiVersion),
    prop("totalChunks", "Int64", true, true, false, false, "Total number of chunks for the parent", apiVersion),

    // --- Workflow Properties ---
    prop("workflowStatus", "String", true, true, true, true, "Current workflow status", apiVersion),
    prop("workflowType", "String", true, true, false, true, "Workflow type", apiVersion),
    prop("workflowDueDate", "DateTime", true, true, false, false, "Workflow due date", apiVersion),

    // --- Vault Source Properties ---
    prop("vaultDns", "String", true, true, false, false, "Source Vault DNS", apiVersion),
    prop("vaultUrl", "String", true, true, false, false, "Direct URL in Vault", apiVersion),

    // --- Entity Type (for multi-type indexing) ---
    prop("entityType", "String", true, true, false, true, "Entity type document object relationship workflow picklist", apiVersion),
    prop("objectType", "String", true, true, false, true, "Vault object type name", apiVersion),

    // --- Application identifier ---
    prop("vaultApplication", "String", true, true, false, true, "Vault application promomats qualitydocs rim", apiVersion),
  ];
}

function extToProperty(ext: SchemaExtension, apiVersion: GraphApiVersion): ConnectorProperty {
  const property: ConnectorProperty = {
    name: ext.name,
    type: ext.type,
    isQueryable: ext.isQueryable,
    isRetrievable: ext.isRetrievable,
    isSearchable: ext.isSearchable,
    isRefinable: ext.isRefinable,
    description: ext.description,
  };

  // Enforce Graph constraints
  if (property.isRefinable && property.isSearchable) {
    property.isSearchable = false;
  }

  if (apiVersion === "beta") {
    applyRankingHint(property);
  }

  validateProperty(property);
  return property;
}

function prop(
  name: string,
  type: PropertyType,
  isQueryable: boolean,
  isRetrievable: boolean,
  isSearchable: boolean,
  isRefinable: boolean,
  description: string,
  apiVersion: GraphApiVersion = "v1.0"
): ConnectorProperty {
  const property: ConnectorProperty = {
    name,
    type,
    isQueryable,
    description,
    isRetrievable,
    isSearchable,
    isRefinable,
  };

  if (isRefinable && isSearchable) {
    property.isSearchable = false;
  }

  const aliases: Record<string, string[]> = {
    title: ["name", "documentTitle"],
    documentNumber: ["docNum"],
    product: ["productName"],
    brand: ["brandName"],
    country: ["region"],
    status: ["state", "lifecycleState"],
    tags: ["keywords", "labels"],
  };

  if (aliases[name]) {
    property.aliases = aliases[name];
  }

  const labels: Record<string, string[]> = {
    title: ["title"],
    fileName: ["fileName"],
    fileExtension: ["fileExtension"],
    createdDate: ["createdDateTime"],
    modifiedDate: ["lastModifiedDateTime"],
    createdBy: ["createdBy"],
    modifiedBy: ["lastModifiedBy"],
    vaultUrl: ["url"],
    authors: ["authors"],
    iconUrl: ["iconUrl"],
    parentBinder: ["containerName"],
    binderPath: ["containerUrl"],
    tags: ["tags"],
    status: ["state"],
    entityType: ["itemType"],
    itemPath: ["itemPath"],
    workflowDueDate: ["dueDate"],
  };

  if (labels[name]) {
    property.labels = labels[name];
  }

  if (apiVersion === "beta") {
    applyRankingHint(property);
  }

  validateProperty(property);
  return property;
}

/**
 * Apply rankingHint to a property based on the RANKING_HINTS map (Beta API only).
 */
function applyRankingHint(property: ConnectorProperty): void {
  const score = RANKING_HINTS[property.name];
  if (score) {
    property.rankingHint = { importanceScore: score };
  }
}

function validateProperty(property: ConnectorProperty): void {
  if (property.name.length > 32 || !NAME_PATTERN.test(property.name)) {
    throw new Error(`Invalid schema property name '${property.name}'`);
  }

  if (property.description.length > 200) {
    throw new Error(`Description for property '${property.name}' exceeds 200 characters`);
  }

  if (
    property.isSearchable &&
    property.type !== "String" &&
    property.type !== "StringCollection"
  ) {
    throw new Error(`Only String/StringCollection properties can be searchable: ${property.name}`);
  }

  if (property.aliases) {
    for (const alias of property.aliases) {
      if (alias.length > 32 || !NAME_PATTERN.test(alias)) {
        throw new Error(`Invalid alias '${alias}' for property '${property.name}'`);
      }
    }
  }

  if (property.labels) {
    for (const label of property.labels) {
      if (!ALLOWED_LABELS.has(label)) {
        throw new Error(`Invalid label '${label}' for property '${property.name}'`);
      }
    }
  }
}
