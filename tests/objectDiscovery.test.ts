/**
 * Tests for Object Discovery
 */

import { discoverObjectTypes } from "../src/crawl/objectDiscovery";
import { ManifestEntry } from "../src/models/types";

describe("Object Discovery", () => {
  const knownObjects = ["product__v", "country__v"];

  test("returns known objects when manifest is empty", () => {
    const result = discoverObjectTypes([], knownObjects);
    expect(result).toEqual(expect.arrayContaining(knownObjects));
    expect(result).toHaveLength(2);
  });

  test("discovers new __v objects from manifest", () => {
    const manifest: ManifestEntry[] = [
      { extract: "campaign__v", extract_label: "Campaign", type: "updates", records: 50, file: "campaign__v.csv" },
      { extract: "product__v", extract_label: "Product", type: "updates", records: 10, file: "product__v.csv" },
    ];
    const result = discoverObjectTypes(manifest, knownObjects);
    expect(result).toContain("campaign__v");
    expect(result).toContain("product__v");
    expect(result).toContain("country__v");
  });

  test("discovers custom __c objects from manifest", () => {
    const manifest: ManifestEntry[] = [
      { extract: "custom_report__c", extract_label: "Custom Report", type: "updates", records: 5, file: "custom_report__c.csv" },
    ];
    const result = discoverObjectTypes(manifest, knownObjects);
    expect(result).toContain("custom_report__c");
  });

  test("ignores system extracts", () => {
    const manifest: ManifestEntry[] = [
      { extract: "document_version__sys", extract_label: "Document Version", type: "updates", records: 100, file: "document_version__sys.csv" },
      { extract: "workflow__sys", extract_label: "Workflow", type: "updates", records: 10, file: "workflow__sys.csv" },
      { extract: "user__sys", extract_label: "User", type: "updates", records: 50, file: "user__sys.csv" },
    ];
    const result = discoverObjectTypes(manifest, knownObjects);
    expect(result).not.toContain("document_version__sys");
    expect(result).not.toContain("workflow__sys");
    expect(result).not.toContain("user__sys");
  });

  test("ignores delete-type entries", () => {
    const manifest: ManifestEntry[] = [
      { extract: "campaign__v", extract_label: "Campaign", type: "deletes", records: 5, file: "campaign__v_deletes.csv" },
    ];
    const result = discoverObjectTypes(manifest, knownObjects);
    expect(result).not.toContain("campaign__v");
  });

  test("ignores entries with zero records", () => {
    const manifest: ManifestEntry[] = [
      { extract: "empty_obj__v", extract_label: "Empty", type: "updates", records: 0, file: "empty_obj__v.csv" },
    ];
    const result = discoverObjectTypes(manifest, knownObjects);
    expect(result).not.toContain("empty_obj__v");
  });

  test("no duplicates in output", () => {
    const manifest: ManifestEntry[] = [
      { extract: "product__v", extract_label: "Product", type: "updates", records: 10, file: "product__v.csv" },
      { extract: "product__v", extract_label: "Product", type: "updates", records: 10, file: "product__v.csv" },
    ];
    const result = discoverObjectTypes(manifest, knownObjects);
    const productCount = result.filter((o) => o === "product__v").length;
    expect(productCount).toBe(1);
  });
});
