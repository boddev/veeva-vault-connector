/**
 * Retry utility with exponential backoff.
 * Handles transient failures, rate limiting, and session expiration.
 */

import { logger } from "./logger";

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;
const JITTER_FACTOR = 0.3;

export interface RetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatusCodes?: number[];
  onRetry?: (attempt: number, error: unknown) => Promise<void>;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  operationName: string,
  options?: RetryOptions
): Promise<T> {
  if (maxAttempts < 1) {
    throw new Error("maxAttempts must be at least 1");
  }

  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryableCodes = options?.retryableStatusCodes ?? [
    408, 429, 500, 502, 503, 504,
  ];

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      const statusCode = extractStatusCode(error);
      const isRetryable =
        !statusCode || retryableCodes.includes(statusCode);
      const isSessionExpired = isSessionError(error);

      if (!isRetryable && !isSessionExpired) {
        logger.error(
          `${operationName}: Non-retryable error (status ${statusCode}), failing immediately`
        );
        throw error;
      }

      if (attempt === maxAttempts) {
        logger.error(
          `${operationName}: All ${maxAttempts} attempts failed`
        );
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelay, maxDelay);

      // Check for Retry-After header
      const retryAfter = extractRetryAfter(error);
      const actualDelay = retryAfter
        ? Math.max(retryAfter * 1000, delay)
        : delay;

      logger.warn(
        `${operationName}: Attempt ${attempt}/${maxAttempts} failed (status ${statusCode}). Retrying in ${actualDelay}ms...`
      );

      if (options?.onRetry) {
        await options.onRetry(attempt, error);
      }

      await sleep(actualDelay);
    }
  }

  throw lastError;
}

function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = exponentialDelay * JITTER_FACTOR * Math.random();
  return Math.min(exponentialDelay + jitter, maxDelay);
}

export function extractStatusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    if (typeof err.statusCode === "number") return err.statusCode;
    if (typeof err.status === "number") return err.status;
    const response = err.response as Record<string, unknown> | undefined;
    if (response && typeof response.status === "number")
      return response.status;
  }
  return undefined;
}

export function extractRetryAfter(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    const response = err.response as Record<string, unknown> | undefined;
    const headers = response?.headers as Record<string, string> | undefined;
    const retryAfter = headers?.["retry-after"] || headers?.RetryAfter;
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds;

      const retryDate = new Date(retryAfter);
      if (!isNaN(retryDate.getTime())) {
        return Math.max(
          0,
          Math.ceil((retryDate.getTime() - Date.now()) / 1000)
        );
      }
    }
  }
  return undefined;
}

export function isSessionError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error);
  return (
    message.includes("INVALID_SESSION_ID") ||
    message.includes("SESSION_EXPIRED") ||
    message.includes("AUTHENTICATION_FAILED")
  );
}

export function shouldInvalidateSession(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  return statusCode === 401 || statusCode === 403 || isSessionError(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
