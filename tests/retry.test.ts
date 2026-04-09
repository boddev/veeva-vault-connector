/**
 * Tests for retry utility
 */

import { retryWithBackoff } from "../src/utils/retry";

describe("retryWithBackoff", () => {
  test("succeeds on first attempt", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, 3, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries and succeeds on second attempt", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(fn, 3, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("throws after all retries exhausted", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("persistent failure"));
    await expect(retryWithBackoff(fn, 2, "test")).rejects.toThrow("persistent failure");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
