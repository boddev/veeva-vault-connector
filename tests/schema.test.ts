/**
 * Tests for Unified Schema Factory
 */

import { getSchemaForApp } from "../src/graph/schema";
import { VaultApplication } from "../src/config/appProfiles";
import { GraphApiVersion } from "../src/config/settings";

describe("Schema Factory", () => {
  const applications: VaultApplication[] = ["promomats", "qualitydocs", "rim"];

  test.each(applications)("getSchemaForApp(%s) returns valid schema", (app) => {
    const schema = getSchemaForApp(app);
    expect(schema.baseType).toBe("microsoft.graph.externalItem");
    expect(schema.properties.length).toBeGreaterThan(0);
  });

  test("all schemas share base properties", () => {
    const schemas = applications.map((app) => getSchemaForApp(app));
    const basePropertyNames = [
      "docId", "globalId", "title", "description", "fileName",
      "status", "versionId", "documentType", "product", "country",
      "entityType", "objectType", "vaultApplication",
    ];

    for (const schema of schemas) {
      const names = schema.properties.map((p) => p.name);
      for (const baseName of basePropertyNames) {
        expect(names).toContain(baseName);
      }
    }
  });

  test("promomats schema has promomats-specific properties", () => {
    const schema = getSchemaForApp("promomats");
    const names = schema.properties.map((p) => p.name);
    expect(names).toContain("keyMessages");
    expect(names).toContain("claim");
    expect(names).toContain("audience");
    expect(names).toContain("channel");
    expect(names).toContain("mlrStatus");
  });

  test("qualitydocs schema has qualitydocs-specific properties", () => {
    const schema = getSchemaForApp("qualitydocs");
    const names = schema.properties.map((p) => p.name);
    expect(names).toContain("effectiveDate");
    expect(names).toContain("periodicReviewDate");
    expect(names).toContain("trainingRequired");
    expect(names).toContain("facility");
    expect(names).toContain("department");
    expect(names).toContain("qualityEventType");
    expect(names).toContain("capaNumber");
    expect(names).toContain("deviationNumber");
  });

  test("rim schema has rim-specific properties", () => {
    const schema = getSchemaForApp("rim");
    const names = schema.properties.map((p) => p.name);
    expect(names).toContain("applicationNumber");
    expect(names).toContain("submissionType");
    expect(names).toContain("regulatoryObjective");
    expect(names).toContain("registrationStatus");
    expect(names).toContain("healthAuthority");
    expect(names).toContain("dossierSection");
  });

  test("schemas have different property counts (base + extensions)", () => {
    const promoSchema = getSchemaForApp("promomats");
    const qualitySchema = getSchemaForApp("qualitydocs");
    const rimSchema = getSchemaForApp("rim");

    // QualityDocs and RIM have more extensions than PromoMats
    expect(qualitySchema.properties.length).toBeGreaterThan(promoSchema.properties.length);
    expect(rimSchema.properties.length).toBeGreaterThan(promoSchema.properties.length);
  });

  test("all property names are valid (alphanumeric, max 32 chars)", () => {
    for (const app of applications) {
      const schema = getSchemaForApp(app);
      for (const prop of schema.properties) {
        expect(prop.name).toMatch(/^[A-Za-z0-9]+$/);
        expect(prop.name.length).toBeLessThanOrEqual(32);
      }
    }
  });

  test("refinable properties are not searchable (Graph constraint)", () => {
    for (const app of applications) {
      const schema = getSchemaForApp(app);
      for (const prop of schema.properties) {
        if (prop.isRefinable) {
          expect(prop.isSearchable).toBe(false);
        }
      }
    }
  });

  test("only String/StringCollection properties are searchable", () => {
    for (const app of applications) {
      const schema = getSchemaForApp(app);
      for (const prop of schema.properties) {
        if (prop.isSearchable) {
          expect(["String", "StringCollection"]).toContain(prop.type);
        }
      }
    }
  });

  test("no duplicate property names within any schema", () => {
    for (const app of applications) {
      const schema = getSchemaForApp(app);
      const names = schema.properties.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  // --- Expanded label tests ---

  test("schemas include semantic labels for key properties", () => {
    const schema = getSchemaForApp("promomats");
    const byName = Object.fromEntries(schema.properties.map((p) => [p.name, p]));

    expect(byName.tags.labels).toContain("tags");
    expect(byName.status.labels).toContain("state");
    expect(byName.entityType.labels).toContain("itemType");
    expect(byName.itemPath.labels).toContain("itemPath");
    expect(byName.workflowDueDate.labels).toContain("dueDate");
  });
});

describe("Schema Factory — Beta API", () => {
  const applications: VaultApplication[] = ["promomats", "qualitydocs", "rim"];
  const betaVersion: GraphApiVersion = "beta";

  test.each(applications)("getSchemaForApp(%s, 'beta') returns valid schema", (app) => {
    const schema = getSchemaForApp(app, betaVersion);
    expect(schema.baseType).toBe("microsoft.graph.externalItem");
    expect(schema.properties.length).toBeGreaterThan(0);
  });

  test("beta schema properties have rankingHint for key properties", () => {
    const schema = getSchemaForApp("promomats", betaVersion);
    const byName = Object.fromEntries(schema.properties.map((p) => [p.name, p]));

    // veryHigh importance
    expect(byName.title.rankingHint).toEqual({ importanceScore: "veryHigh" });
    expect(byName.description.rankingHint).toEqual({ importanceScore: "veryHigh" });
    expect(byName.documentNumber.rankingHint).toEqual({ importanceScore: "veryHigh" });

    // high importance
    expect(byName.status.rankingHint).toEqual({ importanceScore: "high" });
    expect(byName.product.rankingHint).toEqual({ importanceScore: "high" });
    expect(byName.tags.rankingHint).toEqual({ importanceScore: "high" });
    expect(byName.authors.rankingHint).toEqual({ importanceScore: "high" });
    expect(byName.fileName.rankingHint).toEqual({ importanceScore: "high" });

    // medium importance
    expect(byName.brand.rankingHint).toEqual({ importanceScore: "medium" });
    expect(byName.country.rankingHint).toEqual({ importanceScore: "medium" });
    expect(byName.classification.rankingHint).toEqual({ importanceScore: "medium" });
    expect(byName.workflowStatus.rankingHint).toEqual({ importanceScore: "medium" });
  });

  test("v1.0 schema does NOT have rankingHint", () => {
    const schema = getSchemaForApp("promomats", "v1.0");
    for (const prop of schema.properties) {
      expect(prop.rankingHint).toBeUndefined();
    }
  });

  test("beta and v1.0 schemas have same property count per app", () => {
    for (const app of applications) {
      const v1Schema = getSchemaForApp(app, "v1.0");
      const betaSchema = getSchemaForApp(app, betaVersion);
      expect(v1Schema.properties.length).toBe(betaSchema.properties.length);
    }
  });

  test("beta schema properties without explicit ranking have no rankingHint", () => {
    const schema = getSchemaForApp("promomats", betaVersion);
    const byName = Object.fromEntries(schema.properties.map((p) => [p.name, p]));

    // Properties not in the RANKING_HINTS map should not have rankingHint
    expect(byName.majorVersion.rankingHint).toBeUndefined();
    expect(byName.minorVersion.rankingHint).toBeUndefined();
    expect(byName.fileSize.rankingHint).toBeUndefined();
    expect(byName.chunkIndex.rankingHint).toBeUndefined();
  });

  test("no duplicate property names in beta schemas", () => {
    for (const app of applications) {
      const schema = getSchemaForApp(app, betaVersion);
      const names = schema.properties.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("refinable properties are not searchable in beta schemas", () => {
    for (const app of applications) {
      const schema = getSchemaForApp(app, betaVersion);
      for (const prop of schema.properties) {
        if (prop.isRefinable) {
          expect(prop.isSearchable).toBe(false);
        }
      }
    }
  });
});
