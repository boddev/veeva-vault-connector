/**
 * Tests for Content Processor — multi-app support
 */

import { ContentProcessor } from "../src/crawl/contentProcessor";

// Mock VaultRestClient
const mockVaultClient = {
  downloadTextFromUrl: jest.fn().mockResolvedValue(""),
  downloadDocumentText: jest.fn().mockResolvedValue("Sample text content"),
  getDocumentAcl: jest.fn().mockResolvedValue({ documentId: "1", principals: [] }),
  getAllUsers: jest.fn().mockResolvedValue([]),
  getAllGroups: jest.fn().mockResolvedValue([]),
} as any;

describe("ContentProcessor — Multi-App", () => {
  const baseRecord: Record<string, string> = {
    id: "123_0_1",
    doc_id: "123",
    version_id: "123_0_1",
    major_version_number: "2",
    minor_version_number: "0",
    title__v: "Test Document",
    name__v: "Test",
    description__v: "A test document",
    document_number__v: "DOC-001",
    global_id__sys: "00G001",
    filename__v: "test.pdf",
    status__v: "Approved",
    type__v: "SOP",
    subtype__v: "Standard",
    product__v: "ProductA",
    country__v: "US",
    created_by__v: "user1",
    modified_by__v: "user2",
    created_date__v: "2024-01-15T10:00:00Z",
    modified_date__v: "2024-06-01T14:30:00Z",
  };

  describe("PromoMats", () => {
    const processor = new ContentProcessor(
      { vaultApplication: "promomats", vaultDns: "promo.veevavault.com" } as any,
      mockVaultClient
    );

    test("processDocument includes promomats-specific properties", async () => {
      const record = {
        ...baseRecord,
        key_message__v: "Efficacy data shows improvement",
        claim__v: "Reduces symptoms by 50%",
        audience__v: "HCP",
        channel__v: "Digital",
        mlr_status__v: "Approved",
      };
      const items = await processor.processDocument(record, { fetchContent: false });
      const item = items[0];
      expect(item.properties.vaultApplication).toBe("promomats");
      expect(item.properties.keyMessages).toBe("Efficacy data shows improvement");
      expect(item.properties.claim).toBe("Reduces symptoms by 50%");
      expect(item.properties.audience).toBe("HCP");
      expect(item.properties.channel).toBe("Digital");
      expect(item.properties.mlrStatus).toBe("Approved");
    });
  });

  describe("QualityDocs", () => {
    const processor = new ContentProcessor(
      { vaultApplication: "qualitydocs", vaultDns: "quality.veevavault.com" } as any,
      mockVaultClient
    );

    test("processDocument includes qualitydocs-specific properties", async () => {
      const record = {
        ...baseRecord,
        effective_date__v: "2024-03-01T00:00:00Z",
        periodic_review_date__v: "2025-03-01T00:00:00Z",
        training_required__v: "true",
        facility__v: "Plant A",
        department__v: "Manufacturing",
        capa_number__v: "CAPA-2024-001",
      };
      const items = await processor.processDocument(record, { fetchContent: false });
      const item = items[0];
      expect(item.properties.vaultApplication).toBe("qualitydocs");
      expect(item.properties.effectiveDate).toBe("2024-03-01T00:00:00.000Z");
      expect(item.properties.periodicReviewDate).toBe("2025-03-01T00:00:00.000Z");
      expect(item.properties.trainingRequired).toBe(true);
      expect(item.properties.facility).toBe("Plant A");
      expect(item.properties.department).toBe("Manufacturing");
      expect(item.properties.capaNumber).toBe("CAPA-2024-001");
    });

    test("processDocument parses trainingRequired across truthy variants", async () => {
      const record = {
        ...baseRecord,
        training_required__v: "YES",
      };
      const items = await processor.processDocument(record, { fetchContent: false });
      const item = items[0];
      expect(item.properties.trainingRequired).toBe(true);
    });

    test("processVaultObject adds qualitydocs-specific object properties", () => {
      const capaRecord = { id: "100", name__v: "CAPA-2024-001", status__v: "Open", capa_number__v: "CAPA-2024-001" };
      const item = processor.processVaultObject(capaRecord, "capa__v");
      expect(item.properties.capaNumber).toBe("CAPA-2024-001");
      expect(item.properties.objectType).toBe("capa__v");
    });

    test("processVaultObject adds deviation properties", () => {
      const devRecord = { id: "200", name__v: "DEV-2024-005", status__v: "Under Investigation", deviation_number__v: "DEV-2024-005" };
      const item = processor.processVaultObject(devRecord, "deviation__v");
      expect(item.properties.deviationNumber).toBe("DEV-2024-005");
    });
  });

  describe("RIM", () => {
    const processor = new ContentProcessor(
      { vaultApplication: "rim", vaultDns: "rim.veevavault.com" } as any,
      mockVaultClient
    );

    test("processDocument includes rim-specific properties", async () => {
      const record = {
        ...baseRecord,
        application_number__v: "NDA-123456",
        submission_type__v: "Original",
        regulatory_objective__v: "New Drug Application",
        health_authority__v: "FDA",
        dossier_section__v: "m2.3",
        market__v: "US",
        submission_date__v: "2024-06-15T00:00:00Z",
        approval_date__v: "2024-12-01T00:00:00Z",
      };
      const items = await processor.processDocument(record, { fetchContent: false });
      const item = items[0];
      expect(item.properties.vaultApplication).toBe("rim");
      expect(item.properties.applicationNumber).toBe("NDA-123456");
      expect(item.properties.submissionType).toBe("Original");
      expect(item.properties.regulatoryObjective).toBe("New Drug Application");
      expect(item.properties.healthAuthority).toBe("FDA");
      expect(item.properties.dossierSection).toBe("m2.3");
      expect(item.properties.marketCountry).toBe("US");
      expect(item.properties.submissionDate).toBe("2024-06-15T00:00:00.000Z");
      expect(item.properties.approvalDate).toBe("2024-12-01T00:00:00.000Z");
    });

    test("processVaultObject adds rim-specific object properties", () => {
      const submissionRecord = { id: "300", name__v: "NDA-123456-0001", status__v: "Submitted", submission_type__v: "Amendment" };
      const item = processor.processVaultObject(submissionRecord, "submission__v");
      expect(item.properties.submissionType).toBe("Amendment");
    });

    test("processVaultObject adds health authority properties", () => {
      const haRecord = { id: "400", name__v: "FDA", status__v: "Active" };
      const item = processor.processVaultObject(haRecord, "health_authority__v");
      expect(item.properties.healthAuthority).toBe("FDA");
    });
  });

  describe("Shared behavior", () => {
    const processor = new ContentProcessor(
      { vaultApplication: "promomats", vaultDns: "test.veevavault.com" } as any,
      mockVaultClient
    );

    test("processRelationship includes vaultApplication", () => {
      const relRecord = {
        id: "rel-1",
        source_doc_id__v: "10",
        target_doc_id__v: "20",
        relationship_type__v: "crosslink",
      };
      const item = processor.processRelationship(relRecord);
      expect(item.properties.vaultApplication).toBe("promomats");
      expect(item.entityType).toBe("relationship");
    });

    test("processWorkflow includes vaultApplication", () => {
      const wfRecord = {
        id: "wf-1",
        workflow_label__sys: "Review Workflow",
        workflow_status__sys: "Active",
        workflow_type__sys: "Document Review",
      };
      const item = processor.processWorkflow(wfRecord);
      expect(item.properties.vaultApplication).toBe("promomats");
      expect(item.entityType).toBe("workflow");
    });

    test("processPicklist includes vaultApplication", () => {
      const plRecord = {
        object: "document__sys",
        object_field: "status__v",
        picklist_value_name: "approved__v",
        picklist_value_label: "Approved",
        status__v: "active",
      };
      const item = processor.processPicklist(plRecord);
      expect(item.properties.vaultApplication).toBe("promomats");
      expect(item.entityType).toBe("picklist");
    });

    test("content is truncated to 4MB", async () => {
      const longContent = "x".repeat(5 * 1024 * 1024);
      mockVaultClient.downloadDocumentText.mockResolvedValueOnce(longContent);
      const items = await processor.processDocument(baseRecord);
      const item = items[0];
      expect(item.content.value.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    });

    test("extracts docId from id when doc_id is missing", async () => {
      const record = {
        ...baseRecord,
        doc_id: "",
        id: "999_0_1",
        version_id: "",
      };
      const items = await processor.processDocument(record, { fetchContent: false });
      const item = items[0];
      expect(item.properties.docId).toBe("999");
      expect(item.properties.versionId).toBe("999_0_1");
    });

    test("processDocument throws when document identifiers are missing", async () => {
      await expect(
        processor.processDocument(
          {
            title__v: "Missing identifiers",
            major_version_number: "1",
            minor_version_number: "0",
          },
          { fetchContent: false }
        )
      ).rejects.toThrow("missing doc_id");
    });

    test("processDocument accepts additional truthy boolean values", async () => {
      const qualityProcessor = new ContentProcessor(
        { vaultApplication: "qualitydocs", vaultDns: "quality.veevavault.com" } as any,
        mockVaultClient
      );

      const items = await qualityProcessor.processDocument(
        {
          ...baseRecord,
          training_required__v: "TRUE__V",
        },
        { fetchContent: false }
      );
      const item = items[0];
      expect(item.properties.trainingRequired).toBe(true);
    });

    test("processDocument returns chunked items for large content", async () => {
      const largeContent = "x".repeat(5 * 1024 * 1024); // 5MB
      mockVaultClient.downloadDocumentText.mockResolvedValueOnce(largeContent);
      const items = await processor.processDocument(baseRecord);
      expect(items.length).toBeGreaterThan(1);
      expect(items[0].properties.chunkIndex).toBe(0);
      expect(items[0].properties.totalChunks).toBe(items.length);
      expect(items[0].properties.parentDocumentId).toBe("doc-123_0_1");
      // Each chunk should have a contextual header
      expect(items[0].content.value).toContain("Chunk 1 of");
    });

    test("processDocument sets iconUrl based on file extension", async () => {
      const items = await processor.processDocument(baseRecord, { fetchContent: false });
      const item = items[0];
      expect(item.properties.iconUrl).toBeDefined();
      expect(typeof item.properties.iconUrl).toBe("string");
      expect((item.properties.iconUrl as string).includes("pdf")).toBe(true);
    });

    test("processDocument sets chunking properties for single-chunk docs", async () => {
      const items = await processor.processDocument(baseRecord, { fetchContent: false });
      expect(items.length).toBe(1);
      expect(items[0].properties.chunkIndex).toBe(0);
      expect(items[0].properties.totalChunks).toBe(1);
    });
  });
});
