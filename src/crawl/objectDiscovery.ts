/**
 * Object Discovery — Uses Direct Data manifest to auto-discover
 * which object types exist in a Vault, supplementing the known
 * objects from the application profile.
 */

import { logger } from "../utils/logger";
import { ManifestEntry } from "../models/types";

// System extracts that are NOT custom objects
const SYSTEM_EXTRACTS = new Set([
  "document_version__sys",
  "document_relationship__sys",
  "workflow__sys",
  "workflow_item__sys",
  "workflow_task__sys",
  "picklist__sys",
  "user__sys",
  "group__sys",
  "role__sys",
  "security_policy__sys",
  "audit_trail__sys",
]);

/**
 * Discover indexable object types from a Direct Data manifest.
 * Combines known application objects with any objects found in the manifest.
 */
export function discoverObjectTypes(
  manifest: ManifestEntry[],
  knownObjectTypes: string[]
): string[] {
  const discovered = new Set<string>(knownObjectTypes);

  for (const entry of manifest) {
    if (entry.type !== "updates") continue;
    if (entry.records === 0) continue;

    const extract = entry.extract;
    if (!extract) continue;

    // Skip system extracts that we handle separately
    if (SYSTEM_EXTRACTS.has(extract)) continue;

    // Skip delete files
    if (extract.endsWith("_deletes")) continue;

    // Add any object that looks like a Vault object (has __v or __c suffix)
    if (extract.endsWith("__v") || extract.endsWith("__c")) {
      if (!discovered.has(extract)) {
        logger.info(`Auto-discovered object type: ${extract} (${entry.records} records)`);
        discovered.add(extract);
      }
    }
  }

  const result = [...discovered];
  logger.info(`Object types to index: ${result.length} (${knownObjectTypes.length} known + ${result.length - knownObjectTypes.length} discovered)`);
  return result;
}

/**
 * Check if a manifest extract name represents a document-related extract
 * (handled separately from objects).
 */
export function isDocumentExtract(extractName: string): boolean {
  return extractName.startsWith("document_version") || extractName.startsWith("document_relationship");
}

/**
 * Check if a manifest extract name represents a workflow extract.
 */
export function isWorkflowExtract(extractName: string): boolean {
  return extractName.startsWith("workflow__sys") || extractName.startsWith("workflow_item") || extractName.startsWith("workflow_task");
}
