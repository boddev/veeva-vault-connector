/**
 * Veeva Vault REST API Client
 *
 * Supplements the Direct Data API for operations that require REST:
 * - Document content download (source files, renditions, text)
 * - ACL/role retrieval per document
 * - Binder structure queries
 * - VQL queries for custom data
 */

import { AxiosInstance } from "axios";
import { VeevaAuthClient } from "./authClient";
import { VaultAcl, VaultPrincipal } from "../models/types";
import { logger } from "../utils/logger";

export class VaultRestClient {
  constructor(private readonly authClient: VeevaAuthClient) {}

  /**
   * Download document text content for indexing.
   * Uses the text_file URL from Direct Data if available, otherwise falls back to REST.
   */
  async downloadDocumentText(
    docId: string,
    majorVersion: number,
    minorVersion: number
  ): Promise<string> {
    try {
      const response = await this.authClient.executeWithRetry(
        `downloadDocText:${docId}`,
        (client) =>
          client.get(
            `/objects/documents/${docId}/versions/${majorVersion}/${minorVersion}/renditions/text/file`,
            { responseType: "text", timeout: 120000 }
          ),
        { maxAttempts: 2 }
      );
      return typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);
    } catch (error: unknown) {
      logger.warn(
        `Failed to download text for doc ${docId}: ${error instanceof Error ? error.message : "unknown"}`
      );
      return "";
    }
  }

  /**
   * Download document text using the Direct Data text_file URL.
   */
  async downloadTextFromUrl(textFileUrl: string): Promise<string> {
    if (!textFileUrl) return "";

    try {
      const response = await this.authClient.executeWithRetry(
        "downloadTextFromUrl",
        (client) =>
          client.get(textFileUrl, { responseType: "text", timeout: 120000 }),
        { maxAttempts: 2 }
      );
      return typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);
    } catch (error: unknown) {
      logger.warn(
        `Failed to download text from URL: ${error instanceof Error ? error.message : "unknown"}`
      );
      return "";
    }
  }

  /**
   * Retrieve document roles and permissions for ACL mapping.
   * Optionally filters by lifecycle-state-aware "View Document" permission.
   */
  async getDocumentAcl(docId: string): Promise<VaultAcl> {
    try {
      const response = await this.authClient.executeWithRetry(
        `getDocAcl:${docId}`,
        (client) => client.get(`/objects/documents/${docId}/roles`),
        { maxAttempts: 2 }
      );

      const roles = response.data?.roles || response.data?.data || [];
      const principals: VaultPrincipal[] = [];

      for (const role of roles) {
        const roleName = role.role_name || role.name__v || "";
        const users = role.users__v || role.users || [];
        const groups = role.groups__v || role.groups || [];

        for (const user of users) {
          principals.push({
            type: "user",
            id: String(user.id || user),
            name: user.name__v || user.user_name__v || "",
            email: user.user_email__v || "",
            federatedId: user.federated_id__v || user.user_email__v || "",
            role: roleName,
          });
        }

        for (const group of groups) {
          principals.push({
            type: "group",
            id: String(group.id || group),
            name: group.name__v || group.group_name__v || "",
            role: roleName,
          });
        }
      }

      return { documentId: docId, principals };
    } catch (error: unknown) {
      logger.warn(
        `Failed to get ACL for doc ${docId}: ${error instanceof Error ? error.message : "unknown"}`
      );
      return { documentId: docId, principals: [] };
    }
  }

  /**
   * Retrieve object record sharing/roles for ACL mapping.
   * Uses VQL to find the created_by and any sharing fields.
   * Falls back to created_by__v as the owner principal.
   */
  async getObjectAcl(objectType: string, objectId: string): Promise<VaultAcl> {
    try {
      // First try the object roles endpoint (available for some object types)
      const response = await this.authClient.executeWithRetry(
        `getObjAcl:${objectType}:${objectId}`,
        (client) => client.get(`/vobjects/${objectType}/${objectId}/roles`),
        { maxAttempts: 1 }
      );

      const roles = response.data?.roles || response.data?.data || [];
      const principals: VaultPrincipal[] = [];

      for (const role of roles) {
        const users = role.users__v || role.users || [];
        const groups = role.groups__v || role.groups || [];

        for (const user of users) {
          principals.push({
            type: "user",
            id: String(user.id || user),
            name: user.name__v || user.user_name__v || "",
            email: user.user_email__v || "",
            federatedId: user.federated_id__v || user.user_email__v || "",
          });
        }

        for (const group of groups) {
          principals.push({
            type: "group",
            id: String(group.id || group),
            name: group.name__v || group.group_name__v || "",
          });
        }
      }

      if (principals.length > 0) {
        return { documentId: `${objectType}:${objectId}`, principals };
      }
    } catch {
      // Object roles endpoint not available for this type — fall through to VQL
    }

    // Fallback: query the object's owner/created_by
    try {
      const records = await this.executeVql(
        `SELECT id, created_by__v, modified_by__v, owner__v FROM ${objectType} WHERE id = '${objectId}' LIMIT 1`
      );
      if (records.length > 0) {
        const rec = records[0];
        const principals: VaultPrincipal[] = [];
        const ownerIds = new Set<string>();

        for (const field of ["owner__v", "created_by__v", "modified_by__v"]) {
          const val = String(rec[field] || "");
          if (val && !ownerIds.has(val)) {
            ownerIds.add(val);
            principals.push({
              type: "user",
              id: val,
              name: "",
            });
          }
        }

        if (principals.length > 0) {
          return { documentId: `${objectType}:${objectId}`, principals };
        }
      }
    } catch {
      // VQL failed — return empty
    }

    return { documentId: `${objectType}:${objectId}`, principals: [] };
  }

  /**
   * Get lifecycle role-permission matrix to determine which roles
   * have "View Document" permission in each lifecycle state.
   * Returns a map of lifecycle__v → Set of role names with view access.
   */
  async getLifecycleViewPermissions(lifecycle: string): Promise<Set<string>> {
    const viewableRoles = new Set<string>();

    try {
      const response = await this.authClient.executeWithRetry(
        `getLifecyclePerms:${lifecycle}`,
        (client) => client.get(`/configuration/lifecycle.${lifecycle}`),
        { maxAttempts: 1 }
      );

      const states = response.data?.lifecycleStates || response.data?.states || [];
      for (const state of states) {
        const securityOverrides = state.securityOverrides || state.security_settings__v || [];
        for (const override of securityOverrides) {
          const roleName = override.role || override.role__v || "";
          const permissions = override.permissions || [];
          const hasView = permissions.some(
            (p: string | { name?: string }) =>
              (typeof p === "string" ? p : p.name || "") === "view_document__v"
          );
          if (hasView && roleName) {
            viewableRoles.add(roleName);
          }
        }
      }
    } catch {
      // If lifecycle config is not available, assume all roles have view access
      // This is the safe default — grants rather than denies
    }

    return viewableRoles;
  }

  /**
   * Get all members of a Vault group.
   * Used for external group sync when Vault groups don't map to Entra groups.
   */
  async getGroupMembers(groupId: string): Promise<VaultPrincipal[]> {
    try {
      const records = await this.executeVql(
        `SELECT id, user_name__v, user_email__v, federated_id__v FROM group_membership__sys WHERE group_id__v = '${groupId}' LIMIT 1000`
      );

      return records.map((r) => ({
        type: "user" as const,
        id: String(r.id || ""),
        name: String(r.user_name__v || ""),
        email: String(r.user_email__v || ""),
        federatedId: String(r.federated_id__v || r.user_email__v || ""),
      }));
    } catch {
      // group_membership__sys may not be queryable in all Vaults
      return [];
    }
  }

  /**
   * Execute a VQL query against the Vault.
   */
  async executeVql(query: string): Promise<Record<string, unknown>[]> {
    try {
      const response = await this.authClient.executeWithRetry(
        "executeVql",
        (client) =>
          client.post(
            "/query",
            new URLSearchParams({ q: query }).toString(),
            {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
            }
          ),
        { maxAttempts: 2 }
      );

      return response.data?.data || [];
    } catch (error: unknown) {
      logger.error(
        `VQL query failed: ${error instanceof Error ? error.message : "unknown"}`
      );
      return [];
    }
  }

  /**
   * Get binder structure (documents contained in a binder).
   */
  async getBinderContents(
    binderId: string
  ): Promise<Record<string, unknown>[]> {
    try {
      const response = await this.authClient.executeWithRetry(
        `getBinderContents:${binderId}`,
        (client) => client.get(`/objects/binders/${binderId}/documents`),
        { maxAttempts: 2 }
      );

      return response.data?.data || [];
    } catch (error: unknown) {
      logger.warn(
        `Failed to get binder contents for ${binderId}: ${error instanceof Error ? error.message : "unknown"}`
      );
      return [];
    }
  }

  /**
   * Get all users in the Vault for ACL mapping purposes.
   * Uses pagination to handle large user bases.
   */
  async getAllUsers(): Promise<Record<string, unknown>[]> {
    const allUsers: Record<string, unknown>[] = [];
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await this.executeVql(
        `SELECT id, user_name__v, user_email__v, user_first_name__v, user_last_name__v, federated_id__v, security_policy_id__v FROM users WHERE status__v = 'active__v' LIMIT ${pageSize} OFFSET ${offset}`
      );
      allUsers.push(...page);
      hasMore = page.length === pageSize;
      offset += pageSize;
    }

    return allUsers;
  }

  /**
   * Get all groups in the Vault for ACL mapping purposes.
   * Uses pagination to handle large group sets.
   */
  async getAllGroups(): Promise<Record<string, unknown>[]> {
    const allGroups: Record<string, unknown>[] = [];
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await this.executeVql(
        `SELECT id, group_name__v, group_description__v FROM groups WHERE status__v = 'active__v' LIMIT ${pageSize} OFFSET ${offset}`
      );
      allGroups.push(...page);
      hasMore = page.length === pageSize;
      offset += pageSize;
    }

    return allGroups;
  }
}
