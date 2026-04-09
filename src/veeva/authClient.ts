/**
 * Veeva Vault Authentication Client
 *
 * Manages session-based authentication with Veeva Vault.
 * Supports username/password auth with automatic session refresh.
 */

import axios, { AxiosInstance } from "axios";
import { ConnectorConfig } from "../config/settings";
import { VaultAuthResponse } from "../models/types";
import { logger } from "../utils/logger";
import {
  RetryOptions,
  retryWithBackoff,
  shouldInvalidateSession,
} from "../utils/retry";

const SESSION_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const SESSION_LIFETIME_MS = 20 * 60 * 1000; // Veeva sessions last ~20 minutes

export class VeevaAuthClient {
  private sessionId: string | null = null;
  private sessionTimestamp: number = 0;
  private vaultId: number | null = null;
  private authPromise: Promise<string> | null = null;
  private readonly baseUrl: string;
  private readonly httpClient: AxiosInstance;

  constructor(private readonly config: ConnectorConfig) {
    this.baseUrl = `https://${config.vaultDns}/api/${config.apiVersion}`;
    this.httpClient = axios.create({
      timeout: 30000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  /**
   * Get a valid session ID, authenticating or refreshing as needed.
   */
  async getSessionId(): Promise<string> {
    if (this.isSessionValid()) {
      return this.sessionId!;
    }
    return this.authenticate();
  }

  /**
   * Get the base URL for API calls.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get the vault ID from the last auth response.
   */
  getVaultId(): number | null {
    return this.vaultId;
  }

  /**
   * Authenticate with Veeva Vault using username/password.
   */
  async authenticate(): Promise<string> {
    if (this.authPromise) {
      return this.authPromise;
    }

    this.authPromise = this.performAuthentication();

    try {
      return await this.authPromise;
    } finally {
      this.authPromise = null;
    }
  }

  private async performAuthentication(): Promise<string> {
    logger.info("Authenticating with Veeva Vault...");

    try {
      const response = await this.httpClient.post<VaultAuthResponse>(
        `${this.baseUrl}/auth`,
        new URLSearchParams({
          username: this.config.username,
          password: this.config.password,
          vaultDNS: this.config.vaultDns,
        }).toString()
      );

      if (response.data.responseStatus !== "SUCCESS") {
        throw new Error(
          `Vault authentication failed: ${response.data.responseStatus}`
        );
      }

      this.sessionId = response.data.sessionId;
      this.sessionTimestamp = Date.now();
      this.vaultId = response.data.vaultId;
      this.validateAuthenticatedVault(response.data);

      logger.info(
        `Authenticated successfully. Vault ID: ${this.vaultId}`
      );

      return this.sessionId;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown authentication error";
      logger.error(`Vault authentication error: ${message}`);
      throw new Error(`Vault authentication failed: ${message}`);
    }
  }

  /**
   * Invalidate the current session.
   */
  invalidateSession(): void {
    this.sessionId = null;
    this.sessionTimestamp = 0;
    logger.info("Session invalidated");
  }

  /**
   * Create an authenticated axios instance for making Vault API calls.
   * Includes an interceptor to auto-invalidate session on 401 responses.
   */
  async createAuthenticatedClient(): Promise<AxiosInstance> {
    const sessionId = await this.getSessionId();
    const client = axios.create({
      baseURL: this.baseUrl,
      timeout: 120000,
      headers: {
        Authorization: sessionId,
        Accept: "application/json",
      },
    });

    // Auto-invalidate session on 401/INVALID_SESSION_ID
    client.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error?.response?.status;
        const body = error?.response?.data;
        if (
          status === 401 ||
          (typeof body === "string" && body.includes("INVALID_SESSION_ID"))
        ) {
          logger.warn("Received 401/INVALID_SESSION — invalidating session");
          this.invalidateSession();
        }
        return Promise.reject(error);
      }
    );

    return client;
  }

  async executeWithRetry<T>(
    operationName: string,
    fn: (client: AxiosInstance) => Promise<T>,
    options?: RetryOptions & { maxAttempts?: number }
  ): Promise<T> {
    return retryWithBackoff(
      async () => {
        const client = await this.createAuthenticatedClient();
        return fn(client);
      },
      options?.maxAttempts ?? 3,
      operationName,
      {
        ...options,
        onRetry: async (attempt, error) => {
          if (shouldInvalidateSession(error)) {
            this.invalidateSession();
          }

          if (options?.onRetry) {
            await options.onRetry(attempt, error);
          }
        },
      }
    );
  }

  private isSessionValid(): boolean {
    if (!this.sessionId) return false;
    const elapsed = Date.now() - this.sessionTimestamp;
    return elapsed < SESSION_LIFETIME_MS - SESSION_EXPIRY_BUFFER_MS;
  }

  private validateAuthenticatedVault(response: VaultAuthResponse): void {
    const authenticatedVault = response.vaultIds?.find(
      (vault) => vault.id === response.vaultId
    );

    if (!authenticatedVault) {
      return;
    }

    const actualHost = new URL(authenticatedVault.url).hostname.toLowerCase();
    const expectedHost = this.config.vaultDns.toLowerCase();

    if (actualHost !== expectedHost) {
      this.invalidateSession();
      throw new Error(
        `Authenticated against unexpected Vault DNS '${actualHost}' instead of '${expectedHost}'`
      );
    }
  }
}
