/**
 * Tests for environment-driven connector settings.
 */

import { loadConfig } from "../src/config/settings";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VEEVA_VAULT_DNS: "example.veevavault.com",
      VEEVA_USERNAME: "user@example.com",
      SECRET_VEEVA_PASSWORD: "password",
      AZURE_CLIENT_ID: "client-id",
      SECRET_AZURE_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "tenant-id",
    };
    delete process.env.CRAWL_BATCH_SIZE;
    delete process.env.GRAPH_API_VERSION;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("requires MICROSOFT_TENANT_ID", () => {
    delete process.env.MICROSOFT_TENANT_ID;
    expect(() => loadConfig()).toThrow("MICROSOFT_TENANT_ID");
  });

  test("validates CRAWL_BATCH_SIZE", () => {
    process.env.CRAWL_BATCH_SIZE = "0";
    expect(() => loadConfig()).toThrow("CRAWL_BATCH_SIZE");
  });

  test("loads positive CRAWL_BATCH_SIZE", () => {
    process.env.CRAWL_BATCH_SIZE = "50";
    expect(loadConfig().crawlBatchSize).toBe(50);
  });

  test("defaults graphApiVersion to v1.0", () => {
    expect(loadConfig().graphApiVersion).toBe("v1.0");
  });

  test("loads GRAPH_API_VERSION=beta", () => {
    process.env.GRAPH_API_VERSION = "beta";
    expect(loadConfig().graphApiVersion).toBe("beta");
  });

  test("loads GRAPH_API_VERSION=v1.0 explicitly", () => {
    process.env.GRAPH_API_VERSION = "v1.0";
    expect(loadConfig().graphApiVersion).toBe("v1.0");
  });

  test("rejects invalid GRAPH_API_VERSION", () => {
    process.env.GRAPH_API_VERSION = "v2.0";
    expect(() => loadConfig()).toThrow("GRAPH_API_VERSION");
  });
});
