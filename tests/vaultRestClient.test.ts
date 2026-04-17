/**
 * Tests for VaultRestClient — focusing on ACL response parsing.
 *
 * These tests verify the connector correctly handles the real Vault API
 * response format for document/object roles, which uses `documentRoles`,
 * `assignedUsers`, and `assignedGroups` fields with plain integer IDs.
 */

import { VaultRestClient } from "../src/veeva/vaultRestClient";
import { VeevaAuthClient } from "../src/veeva/authClient";

// Mock the auth client
const mockAuthClient = {
  executeWithRetry: jest.fn(),
} as unknown as VeevaAuthClient;

describe("VaultRestClient", () => {
  let client: VaultRestClient;

  beforeEach(() => {
    client = new VaultRestClient(mockAuthClient);
    jest.clearAllMocks();
  });

  describe("getDocumentAcl", () => {
    it("parses documentRoles with assignedUsers as plain integers", async () => {
      (mockAuthClient.executeWithRetry as jest.Mock).mockResolvedValue({
        data: {
          responseStatus: "SUCCESS",
          documentRoles: [
            {
              name: "owner__v",
              label: "Owner",
              assignedUsers: [22195315],
              assignedGroups: [],
            },
            {
              name: "viewer__v",
              label: "Viewer",
              assignedUsers: [23763811, 24658579],
              assignedGroups: [1, 1392631751401],
            },
            {
              name: "editor__v",
              label: "Editor",
              assignedUsers: [24613013],
              assignedGroups: [],
            },
          ],
        },
      });

      const acl = await client.getDocumentAcl("1");

      expect(acl.documentId).toBe("1");
      expect(acl.principals).toHaveLength(6); // 4 users + 2 groups

      // Verify user principals
      const users = acl.principals.filter((p) => p.type === "user");
      expect(users).toHaveLength(4);
      expect(users[0].id).toBe("22195315");
      expect(users[0].role).toBe("owner__v");
      expect(users[1].id).toBe("23763811");
      expect(users[1].role).toBe("viewer__v");

      // Verify group principals
      const groups = acl.principals.filter((p) => p.type === "group");
      expect(groups).toHaveLength(2);
      expect(groups[0].id).toBe("1");
      expect(groups[0].role).toBe("viewer__v");
      expect(groups[1].id).toBe("1392631751401");
    });

    it("handles legacy response with roles field and user objects", async () => {
      (mockAuthClient.executeWithRetry as jest.Mock).mockResolvedValue({
        data: {
          roles: [
            {
              name: "owner__v",
              users__v: [
                { id: "100", user_name__v: "admin", user_email__v: "admin@test.com", federated_id__v: "abc-123" },
              ],
              groups__v: [],
            },
          ],
        },
      });

      const acl = await client.getDocumentAcl("2");

      expect(acl.principals).toHaveLength(1);
      expect(acl.principals[0].id).toBe("100");
      expect(acl.principals[0].email).toBe("admin@test.com");
      expect(acl.principals[0].federatedId).toBe("abc-123");
    });

    it("returns empty principals on API failure", async () => {
      (mockAuthClient.executeWithRetry as jest.Mock).mockRejectedValue(
        new Error("Network error")
      );

      const acl = await client.getDocumentAcl("3");

      expect(acl.documentId).toBe("3");
      expect(acl.principals).toHaveLength(0);
    });

    it("returns empty principals when no roles exist", async () => {
      (mockAuthClient.executeWithRetry as jest.Mock).mockResolvedValue({
        data: {
          responseStatus: "SUCCESS",
          documentRoles: [],
        },
      });

      const acl = await client.getDocumentAcl("4");
      expect(acl.principals).toHaveLength(0);
    });

    it("handles roles with only assignedGroups", async () => {
      (mockAuthClient.executeWithRetry as jest.Mock).mockResolvedValue({
        data: {
          documentRoles: [
            {
              name: "viewer__v",
              assignedUsers: [],
              assignedGroups: [5, 6],
            },
          ],
        },
      });

      const acl = await client.getDocumentAcl("5");

      expect(acl.principals).toHaveLength(2);
      expect(acl.principals[0]).toEqual({
        type: "group",
        id: "5",
        name: "",
        role: "viewer__v",
      });
    });

    it("handles string user IDs in assignedUsers", async () => {
      (mockAuthClient.executeWithRetry as jest.Mock).mockResolvedValue({
        data: {
          documentRoles: [
            {
              name: "owner__v",
              assignedUsers: ["22195315"],
              assignedGroups: [],
            },
          ],
        },
      });

      const acl = await client.getDocumentAcl("6");
      expect(acl.principals[0].id).toBe("22195315");
    });
  });
});
