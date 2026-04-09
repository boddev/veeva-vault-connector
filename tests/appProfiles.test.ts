/**
 * Tests for Application Profiles
 */

import { getAppProfile, getAllProfiles, isValidApplication, VaultApplication } from "../src/config/appProfiles";

describe("Application Profiles", () => {
  test("getAppProfile returns correct profile for promomats", () => {
    const profile = getAppProfile("promomats");
    expect(profile.application).toBe("promomats");
    expect(profile.connectorId).toBe("veevaPromoMats");
    expect(profile.connectorName).toContain("PromoMats");
    expect(profile.knownObjectTypes).toContain("product__v");
    expect(profile.knownObjectTypes).toContain("key_message__v");
    expect(profile.knownObjectTypes).toContain("campaign__v");
  });

  test("getAppProfile returns correct profile for qualitydocs", () => {
    const profile = getAppProfile("qualitydocs");
    expect(profile.application).toBe("qualitydocs");
    expect(profile.connectorId).toBe("veevaQualityDocs");
    expect(profile.connectorName).toContain("QualityDocs");
    expect(profile.knownObjectTypes).toContain("quality_event__v");
    expect(profile.knownObjectTypes).toContain("deviation__v");
    expect(profile.knownObjectTypes).toContain("capa__v");
    expect(profile.knownObjectTypes).toContain("complaint__v");
    expect(profile.knownObjectTypes).toContain("change_control__v");
    expect(profile.knownObjectTypes).toContain("audit__v");
    expect(profile.knownObjectTypes).toContain("training_requirement__v");
    expect(profile.knownObjectTypes).toContain("facility__v");
  });

  test("getAppProfile returns correct profile for rim", () => {
    const profile = getAppProfile("rim");
    expect(profile.application).toBe("rim");
    expect(profile.connectorId).toBe("veevaRIM");
    expect(profile.connectorName).toContain("RIM");
    expect(profile.knownObjectTypes).toContain("application__v");
    expect(profile.knownObjectTypes).toContain("submission__v");
    expect(profile.knownObjectTypes).toContain("regulatory_objective__v");
    expect(profile.knownObjectTypes).toContain("registration__v");
    expect(profile.knownObjectTypes).toContain("health_authority__v");
    expect(profile.knownObjectTypes).toContain("content_plan__v");
  });

  test("getAppProfile throws for unknown application", () => {
    expect(() => getAppProfile("unknown" as VaultApplication)).toThrow("Unknown Vault application");
  });

  test("getAllProfiles returns all three profiles", () => {
    const profiles = getAllProfiles();
    expect(profiles).toHaveLength(3);
    expect(profiles.map((p) => p.application).sort()).toEqual(["promomats", "qualitydocs", "rim"]);
  });

  test("isValidApplication validates correctly", () => {
    expect(isValidApplication("promomats")).toBe(true);
    expect(isValidApplication("qualitydocs")).toBe(true);
    expect(isValidApplication("rim")).toBe(true);
    expect(isValidApplication("invalid")).toBe(false);
    expect(isValidApplication("")).toBe(false);
  });

  test("all profiles have schema extensions", () => {
    for (const profile of getAllProfiles()) {
      expect(profile.schemaExtensions.length).toBeGreaterThan(0);
      for (const ext of profile.schemaExtensions) {
        expect(ext.name).toBeTruthy();
        expect(ext.name.length).toBeLessThanOrEqual(32);
        expect(ext.type).toBeTruthy();
        expect(ext.description).toBeTruthy();
      }
    }
  });

  test("all profiles have unique connector IDs", () => {
    const profiles = getAllProfiles();
    const ids = profiles.map((p) => p.connectorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all profile object types end with __v or __c", () => {
    for (const profile of getAllProfiles()) {
      for (const obj of profile.knownObjectTypes) {
        expect(obj).toMatch(/__[vc]$/);
      }
    }
  });
});
