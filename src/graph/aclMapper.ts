/**
 * ACL Mapper — Maps Veeva Vault permissions to Microsoft Entra ID principals.
 *
 * Handles:
 * - Document-level ACLs (from Vault roles API)
 * - Object-level ACLs (from Vault object roles or owner fields)
 * - External group creation for Vault groups without Entra equivalents
 * - Lifecycle-aware permission filtering (only roles with View access)
 */

import { Client } from "@microsoft/microsoft-graph-client";
import {
  ClientSecretCredential,
  DefaultAzureCredential,
} from "@azure/identity";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import { ConnectorConfig } from "../config/settings";
import { VaultPrincipal } from "../models/types";
import { VaultRestClient } from "../veeva/vaultRestClient";
import { logger } from "../utils/logger";

const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AclEntry {
  type: "user" | "group" | "everyone" | "everyoneExceptGuests" | "externalGroup";
  value: string;
  accessType: "grant" | "deny";
}

interface UserMapping {
  vaultUserId: string;
  email: string;
  federatedId: string;
  entraObjectId?: string;
}

interface GroupMapping {
  vaultGroupId: string;
  groupName: string;
  entraObjectId?: string;
  externalGroupId?: string;
}

export class AclMapper {
  private userCache = new Map<string, UserMapping>();
  private groupCache = new Map<string, GroupMapping>();
  private externalGroupCache = new Map<string, string>(); // vaultGroupId → externalGroupId
  private lifecycleViewRolesCache = new Map<string, Set<string>>();
  private initialized = false;
  private graphClient: Client;

  constructor(
    private readonly vaultClient: VaultRestClient,
    private readonly config: ConnectorConfig
  ) {
    const credential =
      config.azureClientId &&
      config.azureClientSecret &&
      config.azureTenantId
        ? new ClientSecretCredential(
            config.azureTenantId,
            config.azureClientId,
            config.azureClientSecret
          )
        : new DefaultAzureCredential();

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: GRAPH_SCOPES,
    });

    this.graphClient = Client.initWithMiddleware({ authProvider });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info("Initializing ACL mapper — loading Vault users and groups...");

    const [users, groups] = await Promise.all([
      this.vaultClient.getAllUsers(),
      this.vaultClient.getAllGroups(),
    ]);

    for (const user of users) {
      const mapping: UserMapping = {
        vaultUserId: String(user.id),
        email: String(user.user_email__v || ""),
        federatedId: String(user.federated_id__v || ""),
      };

      if (GUID_PATTERN.test(mapping.federatedId)) {
        mapping.entraObjectId = mapping.federatedId;
      }

      this.userCache.set(mapping.vaultUserId, mapping);
    }

    for (const group of groups) {
      const mapping: GroupMapping = {
        vaultGroupId: String(group.id),
        groupName: String(group.group_name__v || ""),
      };

      if (GUID_PATTERN.test(mapping.groupName)) {
        mapping.entraObjectId = mapping.groupName;
      }

      this.groupCache.set(mapping.vaultGroupId, mapping);
    }

    this.initialized = true;
    logger.info(
      `ACL mapper initialized: ${this.userCache.size} users, ${this.groupCache.size} groups`
    );
  }

  /**
   * Map document ACL — fetches roles from Vault, resolves to Entra principals.
   * Supports lifecycle-aware filtering when lifecycle name is provided.
   */
  async mapDocumentAcl(
    docId: string,
    forceEveryone = false,
    lifecycle?: string
  ): Promise<AclEntry[]> {
    if (forceEveryone) {
      return [this.getTenantAcl("grant")];
    }

    await this.initialize();

    const vaultAcl = await this.vaultClient.getDocumentAcl(docId);

    if (!vaultAcl.principals || vaultAcl.principals.length === 0) {
      logger.warn(
        `No ACL found for doc ${docId}, defaulting to deny-all tenant ACL`
      );
      return [this.getTenantAcl("deny")];
    }

    // Get lifecycle-aware view permissions if lifecycle is provided
    let viewableRoles: Set<string> | undefined;
    if (lifecycle) {
      viewableRoles = await this.getLifecycleViewRoles(lifecycle);
    }

    const aclEntries: AclEntry[] = [];

    for (const principal of vaultAcl.principals) {
      // If we have lifecycle info, skip principals whose role doesn't grant view
      if (viewableRoles && viewableRoles.size > 0 && principal.role) {
        if (!viewableRoles.has(principal.role)) {
          continue;
        }
      }

      if (principal.type === "user") {
        const mapping = this.userCache.get(principal.id);
        const entraId = await this.resolveUserObjectId(mapping, principal);

        if (entraId) {
          aclEntries.push({
            type: "user",
            value: entraId,
            accessType: "grant",
          });
        }
      } else if (principal.type === "group") {
        const mapping = this.groupCache.get(principal.id);
        const groupId = await this.resolveGroupObjectId(mapping, principal);

        if (groupId) {
          aclEntries.push({
            type: "group",
            value: groupId,
            accessType: "grant",
          });
        } else {
          // Entra group not found — use or create an external group
          const externalId = await this.ensureExternalGroup(
            principal.id,
            mapping?.groupName || principal.name || principal.id
          );
          if (externalId) {
            aclEntries.push({
              type: "externalGroup",
              value: externalId,
              accessType: "grant",
            });
          }
        }
      }
    }

    if (aclEntries.length === 0) {
      logger.warn(
        `Unable to map any Entra principals for doc ${docId}; using deny-all tenant ACL`
      );
      aclEntries.push(this.getTenantAcl("deny"));
    }

    return dedupeAclEntries(aclEntries);
  }

  /**
   * Map object-level ACL — fetches roles/owner from Vault for a custom object record.
   * Falls back to everyoneExceptGuests if no principals found.
   */
  async mapObjectAcl(
    objectType: string,
    objectId: string,
    forceEveryone = false
  ): Promise<AclEntry[]> {
    if (forceEveryone) {
      return [this.getTenantAcl("grant")];
    }

    await this.initialize();

    const vaultAcl = await this.vaultClient.getObjectAcl(objectType, objectId);

    if (!vaultAcl.principals || vaultAcl.principals.length === 0) {
      // Objects without explicit ACL default to tenant-wide access
      return [this.getTenantAcl("grant")];
    }

    const aclEntries: AclEntry[] = [];

    for (const principal of vaultAcl.principals) {
      if (principal.type === "user") {
        const mapping = this.userCache.get(principal.id);
        const entraId = await this.resolveUserObjectId(mapping, principal);
        if (entraId) {
          aclEntries.push({ type: "user", value: entraId, accessType: "grant" });
        }
      } else if (principal.type === "group") {
        const mapping = this.groupCache.get(principal.id);
        const groupId = await this.resolveGroupObjectId(mapping, principal);
        if (groupId) {
          aclEntries.push({ type: "group", value: groupId, accessType: "grant" });
        } else {
          const externalId = await this.ensureExternalGroup(
            principal.id,
            mapping?.groupName || principal.name || principal.id
          );
          if (externalId) {
            aclEntries.push({ type: "externalGroup", value: externalId, accessType: "grant" });
          }
        }
      }
    }

    return aclEntries.length > 0 ? dedupeAclEntries(aclEntries) : [this.getTenantAcl("grant")];
  }

  async refresh(): Promise<void> {
    this.initialized = false;
    this.userCache.clear();
    this.groupCache.clear();
    this.lifecycleViewRolesCache.clear();
    // Preserve external group cache — those are already created in Graph
    await this.initialize();
  }

  // --- External Groups ---

  /**
   * Ensure a Graph external group exists for a Vault group.
   * Creates the external group on first encounter, then caches the ID.
   */
  private async ensureExternalGroup(
    vaultGroupId: string,
    groupName: string
  ): Promise<string | undefined> {
    // Check cache first
    const cached = this.externalGroupCache.get(vaultGroupId);
    if (cached) return cached;

    const connectionId = this.config.connectorId;
    const externalGroupId = `vault_group_${vaultGroupId}`;

    try {
      // Create external group in Graph
      await this.graphClient
        .api(`/external/connections/${connectionId}/groups`)
        .post({
          id: externalGroupId,
          displayName: `Vault: ${groupName}`,
          description: `Auto-synced from Veeva Vault group ${vaultGroupId}`,
        });
      logger.info(`Created external group '${externalGroupId}' for Vault group '${groupName}'`);
    } catch (error: unknown) {
      // 409 = already exists — that's fine
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode !== 409) {
        logger.warn(
          `Failed to create external group for Vault group '${groupName}': ${error instanceof Error ? error.message : "unknown"}`
        );
        return undefined;
      }
    }

    // Sync members into the external group
    try {
      const members = await this.vaultClient.getGroupMembers(vaultGroupId);
      for (const member of members) {
        const entraId = await this.resolveUserObjectId(
          this.userCache.get(member.id),
          member
        );
        if (entraId) {
          try {
            await this.graphClient
              .api(`/external/connections/${connectionId}/groups/${externalGroupId}/members`)
              .post({
                id: entraId,
                type: "user",
                identitySource: "azureActiveDirectory",
              });
          } catch {
            // Member may already exist — ignore
          }
        }
      }
    } catch (error: unknown) {
      logger.debug(
        `Failed to sync members for external group '${externalGroupId}': ${error instanceof Error ? error.message : "unknown"}`
      );
    }

    this.externalGroupCache.set(vaultGroupId, externalGroupId);
    return externalGroupId;
  }

  // --- Lifecycle-Aware Permissions ---

  private async getLifecycleViewRoles(lifecycle: string): Promise<Set<string>> {
    const cached = this.lifecycleViewRolesCache.get(lifecycle);
    if (cached) return cached;

    const viewableRoles = await this.vaultClient.getLifecycleViewPermissions(lifecycle);
    this.lifecycleViewRolesCache.set(lifecycle, viewableRoles);
    return viewableRoles;
  }

  private getTenantAcl(accessType: "grant" | "deny"): AclEntry {
    if (!this.config.azureTenantId) {
      throw new Error(
        "MICROSOFT_TENANT_ID is required to construct Microsoft Graph ACLs"
      );
    }

    return {
      type: "everyoneExceptGuests",
      value: this.config.azureTenantId,
      accessType,
    };
  }

  private async resolveUserObjectId(
    mapping: UserMapping | undefined,
    principal: VaultPrincipal
  ): Promise<string | undefined> {
    if (mapping?.entraObjectId) {
      return mapping.entraObjectId;
    }

    const candidates = [
      mapping?.federatedId,
      principal.federatedId,
      mapping?.email,
      principal.email,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      if (GUID_PATTERN.test(candidate)) {
        if (mapping) {
          mapping.entraObjectId = candidate;
        }
        return candidate;
      }

      const resolved = await this.lookupUserObjectId(candidate);
      if (resolved) {
        if (mapping) {
          mapping.entraObjectId = resolved;
        }
        return resolved;
      }
    }

    return undefined;
  }

  private async resolveGroupObjectId(
    mapping: GroupMapping | undefined,
    principal: VaultPrincipal
  ): Promise<string | undefined> {
    if (mapping?.entraObjectId) {
      return mapping.entraObjectId;
    }

    const candidates = [
      mapping?.groupName,
      principal.name,
      principal.id,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      if (GUID_PATTERN.test(candidate)) {
        if (mapping) {
          mapping.entraObjectId = candidate;
        }
        return candidate;
      }

      const resolved = await this.lookupGroupObjectId(candidate);
      if (resolved) {
        if (mapping) {
          mapping.entraObjectId = resolved;
        }
        return resolved;
      }
    }

    return undefined;
  }

  private async lookupUserObjectId(
    candidate: string
  ): Promise<string | undefined> {
    const escapedCandidate = escapeODataString(candidate);

    try {
      const response = await this.graphClient
        .api("/users")
        .query({
          $filter: `userPrincipalName eq '${escapedCandidate}' or mail eq '${escapedCandidate}'`,
          $select: "id,userPrincipalName,mail",
          $top: "2",
        })
        .get();

      const users = (response.value || []) as Array<{ id?: string }>;
      if (users.length === 1 && users[0].id) {
        return users[0].id;
      }
    } catch (error: unknown) {
      logger.warn(
        `Failed to resolve Entra user '${candidate}': ${error instanceof Error ? error.message : "unknown"}`
      );
    }

    return undefined;
  }

  private async lookupGroupObjectId(
    candidate: string
  ): Promise<string | undefined> {
    const escapedCandidate = escapeODataString(candidate);

    try {
      const response = await this.graphClient
        .api("/groups")
        .query({
          $filter: `displayName eq '${escapedCandidate}'`,
          $select: "id,displayName",
          $top: "2",
        })
        .get();

      const groups = (response.value || []) as Array<{ id?: string }>;
      if (groups.length === 1 && groups[0].id) {
        return groups[0].id;
      }
    } catch (error: unknown) {
      logger.warn(
        `Failed to resolve Entra group '${candidate}': ${error instanceof Error ? error.message : "unknown"}`
      );
    }

    return undefined;
  }
}

function dedupeAclEntries(entries: AclEntry[]): AclEntry[] {
  const seen = new Set<string>();
  const results: AclEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.type}:${entry.value}:${entry.accessType}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(entry);
  }

  return results;
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}
