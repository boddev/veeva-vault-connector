/**
 * Tests for DirectDataClient record selection helpers.
 */

import { DirectDataClient } from "../src/veeva/directDataClient";

describe("DirectDataClient", () => {
  const client = new DirectDataClient({} as never);

  test("matches exact object extract names only", () => {
    const extractedData = new Map<string, Record<string, string>[]>([
      ["exports/application__v.csv", [{ id: "1" }]],
      ["exports/application_submission__v.csv", [{ id: "2" }]],
    ]);

    expect(client.getObjectRecords(extractedData, "application__v")).toEqual([{ id: "1" }]);
  });

  test("aggregates numbered extract files", () => {
    const extractedData = new Map<string, Record<string, string>[]>([
      ["exports/document_version__sys_1.csv", [{ id: "1" }]],
      ["exports/document_version__sys_2.csv", [{ id: "2" }]],
    ]);

    expect(client.getDocumentRecords(extractedData)).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("matches numbered delete extracts", () => {
    const extractedData = new Map<string, Record<string, string>[]>([
      ["exports/product__v_deletes_1.csv", [{ id: "10" }]],
    ]);

    expect(client.getDeletedObjectRecords(extractedData, "product__v")).toEqual([{ id: "10" }]);
  });
});
