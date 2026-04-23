/**
 * Azure Functions entry points for the Veeva Vault Unified Connector.
 *
 * Supports all three Vault applications (PromoMats, QualityDocs, RIM)
 * via the VAULT_APPLICATION environment variable.
 *
 * Functions:
 * 1. deployConnection — Timer (daily) or HTTP trigger to ensure connection + schema exist
 * 2. fullCrawl — Timer (weekends) or HTTP trigger for full content sync via Direct Data API
 * 3. incrementalCrawl — Timer (every 15 min) to process incremental changes
 * 4. status — HTTP GET to check connector health and crawl state
 * 5. admin — HTTP GET to serve the admin dashboard UI
 * 6. config — HTTP GET/POST to read/update crawl configuration
 */

import * as fs from "fs";
import * as path from "path";
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from "@azure/functions";
import { loadConfig } from "../config/settings";
import { getAppProfile } from "../config/appProfiles";
import { VeevaAuthClient } from "../veeva/authClient";
import { DirectDataClient } from "../veeva/directDataClient";
import { VaultRestClient } from "../veeva/vaultRestClient";
import { GraphConnectorClient } from "../graph/graphClient";
import { getSchemaForApp } from "../graph/schema";
import { AclMapper } from "../graph/aclMapper";
import { CrawlStateManager } from "../crawl/crawlState";
import { CrawlState } from "../models/types";
import { FullCrawlEngine } from "../crawl/fullCrawl";
import { IncrementalCrawlEngine } from "../crawl/incrementalCrawl";
import { logger } from "../utils/logger";

// --- Shared initialization ---

function isConcurrentCrawlError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("already running");
}

function createServices() {
  const config = loadConfig();
  const profile = getAppProfile(config.vaultApplication);
  const authClient = new VeevaAuthClient(config);
  const directData = new DirectDataClient(authClient);
  const vaultRest = new VaultRestClient(authClient);
  const graphClient = new GraphConnectorClient(config);
  const aclMapper = new AclMapper(vaultRest, config);
  const stateManager = new CrawlStateManager(config);

  return { config, profile, authClient, directData, vaultRest, graphClient, aclMapper, stateManager };
}

/**
 * Check if today is an allowed full-crawl day.
 * fullCrawlDays: array of day numbers (0=Sun, 6=Sat). Empty = every day.
 */
function isFullCrawlDay(fullCrawlDays: number[]): boolean {
  if (fullCrawlDays.length === 0) return true;
  const today = new Date().getUTCDay();
  return fullCrawlDays.includes(today);
}

// --- 1. Deploy Connection ---

async function deployConnectionHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const { config, graphClient } = createServices();
  logger.info(`deployConnection triggered [${config.vaultApplication.toUpperCase()}] (Graph API ${config.graphApiVersion})`);

  try {
    await graphClient.ensureConnection();
    await graphClient.configureUrlResolver();
    const schema = getSchemaForApp(config.vaultApplication, config.graphApiVersion);
    await graphClient.registerSchema(schema);

    return {
      status: 200,
      jsonBody: {
        status: "success",
        application: config.vaultApplication,
        connectorId: config.connectorId,
        graphApiVersion: config.graphApiVersion,
        message: `Connection, URL resolver, and schema deployed successfully (Graph API ${config.graphApiVersion})`,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(`deployConnection failed: ${message}`);
    return { status: 500, jsonBody: { status: "error", message } };
  }
}

async function deployConnectionTimerHandler(timer: Timer, context: InvocationContext): Promise<void> {
  const { config, graphClient } = createServices();
  logger.info(`deployConnection timer triggered [${config.vaultApplication.toUpperCase()}] (Graph API ${config.graphApiVersion})`);
  try {
    await graphClient.ensureConnection();
    await graphClient.configureUrlResolver();
    const schema = getSchemaForApp(config.vaultApplication, config.graphApiVersion);
    await graphClient.registerSchema(schema);
    logger.info("Connection deployment check complete");
  } catch (error: unknown) {
    logger.error(`deployConnection timer failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

// --- 2. Full Crawl ---

async function fullCrawlHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const services = createServices();
  logger.info(`fullCrawl HTTP triggered [${services.config.vaultApplication.toUpperCase()}]`);

  try {
    await services.stateManager.initialize();

    // Check if a crawl is already running
    const state = await services.stateManager.getState();
    if (state.crawlStatus === "running") {
      return { status: 409, jsonBody: { status: "error", message: "A crawl is already running" } };
    }

    // Seed crawl state so the crawlResumeTimer picks it up immediately.
    // This avoids HTTP gateway timeouts — the full crawl runs via timer, not HTTP.
    await services.stateManager.updateState({
      crawlStatus: "paused",
      currentCrawlType: "full",
      fullCrawlPhase: 0,
      fullCrawlResumeIndex: 0,
      fullCrawlErrors: 0,
      itemsProcessed: 0,
      itemsDeleted: 0,
      lastFullCrawlTime: new Date().toISOString(),
      crawlStartedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      fullCrawlDataFile: undefined,
    });

    logger.info("fullCrawl HTTP: seeded paused state — crawlResumeTimer will start the crawl");
    return { status: 202, jsonBody: { status: "started", message: "Full crawl queued. The resume timer will start processing within 5 minutes. Monitor progress via the dashboard.", application: services.config.vaultApplication } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(`fullCrawl HTTP failed: ${message}`);
    return { status: isConcurrentCrawlError(error) ? 409 : 500, jsonBody: { status: "error", message } };
  }
}

async function fullCrawlTimerHandler(timer: Timer, context: InvocationContext): Promise<void> {
  const services = createServices();
  logger.info(`fullCrawl timer triggered [${services.config.vaultApplication.toUpperCase()}]`);

  // Check if today is a full crawl day (default: weekends only)
  if (!isFullCrawlDay(services.config.fullCrawlDays)) {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const today = dayNames[new Date().getUTCDay()];
    const allowed = services.config.fullCrawlDays.map((d) => dayNames[d]).join(", ");
    logger.info(`Full crawl skipped: today is ${today}, full crawls run on: ${allowed}`);
    return;
  }

  try {
    await services.stateManager.initialize();
    const engine = new FullCrawlEngine(
      services.config, services.directData, services.vaultRest,
      services.graphClient, services.aclMapper, services.stateManager
    );
    await engine.execute();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown";
    if (isConcurrentCrawlError(error)) {
      logger.warn(`fullCrawl timer skipped: ${message}`);
      return;
    }
    logger.error(`fullCrawl timer failed: ${message}`);
  }
}

// --- 3. Incremental Crawl ---

async function incrementalCrawlHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const services = createServices();
  logger.info(`incrementalCrawl HTTP triggered [${services.config.vaultApplication.toUpperCase()}]`);

  try {
    await services.stateManager.initialize();
    const engine = new IncrementalCrawlEngine(
      services.config, services.directData, services.vaultRest,
      services.graphClient, services.aclMapper, services.stateManager
    );
    const result = await engine.execute();
    return { status: 200, jsonBody: { status: "success", application: services.config.vaultApplication, ...result } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(`incrementalCrawl HTTP failed: ${message}`);
    return { status: isConcurrentCrawlError(error) ? 409 : 500, jsonBody: { status: "error", message } };
  }
}

async function incrementalCrawlTimerHandler(timer: Timer, context: InvocationContext): Promise<void> {
  const services = createServices();

  try {
    await services.stateManager.initialize();
    const state = await services.stateManager.getState();

    // Skip if a full crawl is running/paused or has never completed
    if (state.crawlStatus === "running" || state.crawlStatus === "paused") {
      logger.info("incrementalCrawl timer skipped: a crawl is active");
      return;
    }
    if (!state.lastFullCrawlStopTime) {
      logger.info("incrementalCrawl timer skipped: no full crawl has completed yet");
      return;
    }

    const engine = new IncrementalCrawlEngine(
      services.config, services.directData, services.vaultRest,
      services.graphClient, services.aclMapper, services.stateManager
    );
    await engine.execute();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown";
    if (isConcurrentCrawlError(error)) {
      logger.warn(`incrementalCrawl timer skipped: ${message}`);
      return;
    }
    logger.error(`incrementalCrawl timer failed: ${message}`);
  }
}

// --- 3b. Crawl Resume Timer ---

async function crawlResumeTimerHandler(timer: Timer, context: InvocationContext): Promise<void> {
  const services = createServices();

  try {
    await services.stateManager.initialize();
    const state = await services.stateManager.getState();

    // Handle stale "running" state — if heartbeat is >30 min old, the function crashed
    if (state.crawlStatus === "running" && state.lastHeartbeat) {
      const heartbeatAge = Date.now() - new Date(state.lastHeartbeat).getTime();
      const STALE_HEARTBEAT_MS = 30 * 60 * 1000; // 30 minutes
      if (heartbeatAge > STALE_HEARTBEAT_MS) {
        logger.warn(`crawlResumeTimer: Detected stale running crawl (heartbeat ${Math.round(heartbeatAge / 60000)}m ago). Recovering...`);
        await services.stateManager.updateState({ crawlStatus: "paused" });
        // Fall through to resume logic below
      } else {
        return; // Crawl is actively running
      }
    } else if (state.crawlStatus !== "paused") {
      return; // Nothing to resume
    }

    if (state.currentCrawlType === "full") {
      logger.info(`crawlResumeTimer: Resuming paused full crawl (phase ${state.fullCrawlPhase}, ${state.itemsProcessed} items done)`);
      const engine = new FullCrawlEngine(
        services.config, services.directData, services.vaultRest,
        services.graphClient, services.aclMapper, services.stateManager
      );
      const result = await engine.execute();
      if (result.paused) {
        logger.info(`crawlResumeTimer: Chunk complete, still paused. ${result.itemsProcessed} items total. Will continue on next tick.`);
      } else {
        logger.info(`crawlResumeTimer: Full crawl finished! ${result.itemsProcessed} items total.`);
      }
    } else {
      logger.warn(`crawlResumeTimer: Unknown paused crawl type '${state.currentCrawlType}', resetting to idle`);
      await services.stateManager.updateState({ crawlStatus: "idle", currentCrawlType: undefined });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown";
    logger.error(`crawlResumeTimer failed: ${message}`);
  }
}

// --- 4. Status endpoint ---

async function statusPatchHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const services = createServices();
    await services.stateManager.initialize();
    const body = await request.json() as Record<string, unknown>;
    const updates: Partial<CrawlState> = {};
    if (typeof body.totalItemsIndexed === "number") {
      updates.totalItemsIndexed = body.totalItemsIndexed;
    }
    if (Object.keys(updates).length === 0) {
      return { status: 400, jsonBody: { status: "error", message: "No valid fields to update" } };
    }
    await services.stateManager.updateState(updates);
    return { status: 200, jsonBody: { status: "ok", updated: updates } };
  } catch (error: unknown) {
    return { status: 500, jsonBody: { status: "error", message: error instanceof Error ? error.message : "Unknown" } };
  }
}

async function statusHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const services = createServices();
    await services.stateManager.initialize();

    const [crawlState, connectionStatus] = await Promise.all([
      services.stateManager.getState(),
      services.graphClient.getConnectionStatus().catch(() => null),
    ]);

    // Calculate progress info when running or paused
    const isActive = crawlState.crawlStatus === "running" || crawlState.crawlStatus === "paused";
    const progress = isActive
      ? {
          phase: crawlState.currentPhase || "unknown",
          itemsProcessed: crawlState.itemsProcessed || 0,
          totalItems: crawlState.totalItems || 0,
          percentComplete: crawlState.totalItems
            ? Math.round(((crawlState.itemsProcessed || 0) / crawlState.totalItems) * 100)
            : 0,
          itemsPerMinute: crawlState.itemsPerMinute || 0,
          estimatedCompletion: crawlState.estimatedCompletionAt || null,
          lastHeartbeat: crawlState.lastHeartbeat || null,
          startedAt: crawlState.crawlStartedAt || null,
          elapsedMinutes: crawlState.crawlStartedAt
            ? Math.round((Date.now() - new Date(crawlState.crawlStartedAt).getTime()) / 60000)
            : 0,
        }
      : null;

    return {
      status: 200,
      jsonBody: {
        connector: {
          id: services.config.connectorId,
          name: services.config.connectorName,
          application: services.config.vaultApplication,
          vaultDns: services.config.vaultDns,
          graphApiVersion: services.config.graphApiVersion,
        },
        crawlState: {
          status: crawlState.crawlStatus,
          crawlType: crawlState.currentCrawlType || null,
          lastFullCrawl: crawlState.lastFullCrawlStopTime || null,
          lastIncrementalCrawl: crawlState.lastIncrementalStopTime || null,
          itemsProcessed: crawlState.itemsProcessed || 0,
          itemsDeleted: crawlState.itemsDeleted || 0,
          itemCount: crawlState.totalItemsIndexed || crawlState.totalItems || 0,
          lastIncrementalItemsProcessed: crawlState.lastIncrementalItemsProcessed || 0,
          error: crawlState.errorMessage || null,
        },
        progress,
        schedule: {
          fullCrawlSchedule: services.config.fullCrawlSchedule,
          incrementalCrawlSchedule: services.config.incrementalCrawlSchedule,
          fullCrawlDays: services.config.fullCrawlDays,
          fullCrawlDayNames: services.config.fullCrawlDays.map(
            (d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]
          ),
        },
        connectionStatus,
      },
    };
  } catch (error: unknown) {
    return {
      status: 500,
      jsonBody: { status: "error", message: error instanceof Error ? error.message : "Unknown" },
    };
  }
}

// --- 5. Admin Dashboard ---

async function adminHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  // Serve the admin dashboard HTML
  const dashboardPath = path.join(__dirname, "..", "..", "admin", "dashboard.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf-8");
    return { status: 200, headers: { "Content-Type": "text/html" }, body: html };
  } catch {
    // Fallback: serve inline minimal dashboard
    return { status: 200, headers: { "Content-Type": "text/html" }, body: getInlineDashboard() };
  }
}

function getInlineDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Veeva Vault Connector — Admin Dashboard</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --green: #22c55e; --yellow: #eab308; --red: #ef4444; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .subtitle { color: var(--muted); font-size: 0.875rem; margin-bottom: 2rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; }
  .card h2 { font-size: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; font-weight: 500; }
  .stat { font-size: 2rem; font-weight: 700; }
  .stat-label { color: var(--muted); font-size: 0.75rem; margin-top: 0.25rem; }
  .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
  .badge-idle { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-running { background: rgba(59,130,246,0.15); color: var(--accent); animation: pulse 2s infinite; }
  .badge-paused { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-failed { background: rgba(239,68,68,0.15); color: var(--red); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
  .progress-bar { width: 100%; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin: 0.75rem 0; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green)); border-radius: 4px; transition: width 0.5s ease; }
  .info-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border); font-size: 0.875rem; }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--muted); }
  .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 0.875rem; transition: all 0.2s; }
  .btn:hover { background: var(--border); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { background: #2563eb; }
  .btn-danger { background: var(--red); border-color: var(--red); color: white; }
  .btn-danger:hover { background: #dc2626; }
  .btn-group { display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
  .schedule-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.5rem; margin: 0.75rem 0; }
  .day-btn { padding: 0.5rem; text-align: center; border-radius: 0.5rem; border: 1px solid var(--border); background: var(--card); color: var(--muted); cursor: pointer; font-size: 0.75rem; transition: all 0.2s; }
  .day-btn.active { background: var(--accent); border-color: var(--accent); color: white; }
  .day-btn:hover { border-color: var(--accent); }
  .heartbeat { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; }
  .heartbeat-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: blink 2s infinite; }
  .heartbeat-dot.stale { background: var(--yellow); animation: none; }
  .heartbeat-dot.dead { background: var(--red); animation: none; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .log { background: #0d1117; border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 0.75rem; max-height: 200px; overflow-y: auto; line-height: 1.6; color: var(--muted); }
  .error-text { color: var(--red); }
  #refreshTimer { color: var(--muted); font-size: 0.75rem; }
</style>
</head>
<body>
<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:2rem;">
  <div>
    <h1>🔗 Veeva Vault Connector</h1>
    <div class="subtitle" id="connectorInfo">Loading...</div>
  </div>
  <div style="text-align:right;">
    <span id="refreshTimer">Auto-refresh: 10s</span><br/>
    <button class="btn" onclick="fetchStatus()" style="margin-top:0.5rem;">↻ Refresh Now</button>
  </div>
</div>

<div class="grid">
  <!-- Status Card -->
  <div class="card">
    <h2>Crawl Status</h2>
    <div style="display:flex;align-items:center;gap:1rem;">
      <span class="stat" id="statusText">—</span>
      <span class="badge badge-idle" id="statusBadge">Loading</span>
    </div>
    <div class="stat-label" id="statusDetail"></div>
    <div class="heartbeat" id="heartbeatRow" style="display:none;">
      <div class="heartbeat-dot" id="heartbeatDot"></div>
      <span id="heartbeatText">Last heartbeat: —</span>
    </div>
  </div>

  <!-- Progress Card -->
  <div class="card" id="progressCard" style="display:none;">
    <h2>Progress</h2>
    <div class="stat" id="progressPct">0%</div>
    <div class="progress-bar"><div class="progress-fill" id="progressBar" style="width:0%"></div></div>
    <div class="info-row"><span class="info-label">Phase</span><span id="progressPhase">—</span></div>
    <div class="info-row"><span class="info-label">Items</span><span id="progressItems">0 / 0</span></div>
    <div class="info-row"><span class="info-label">Rate</span><span id="progressRate">0 items/min</span></div>
    <div class="info-row"><span class="info-label">ETA</span><span id="progressEta">Calculating...</span></div>
    <div class="info-row"><span class="info-label">Elapsed</span><span id="progressElapsed">0 min</span></div>
  </div>

  <!-- Stats Card -->
  <div class="card">
    <h2>Last Crawl Results</h2>
    <div class="info-row"><span class="info-label">Last Full Crawl</span><span id="lastFullCrawl">Never</span></div>
    <div class="info-row"><span class="info-label">Last Incremental</span><span id="lastIncremental">Never</span></div>
    <div class="info-row"><span class="info-label">Items Indexed</span><span id="itemsIndexed">0</span></div>
    <div class="info-row"><span class="info-label">Last Incremental Re-indexed</span><span id="lastIncrReindexed">0</span></div>
    <div id="errorRow" class="info-row" style="display:none;"><span class="info-label">Error</span><span class="error-text" id="errorText"></span></div>
  </div>

  <!-- Schedule Card -->
  <div class="card">
    <h2>Full Crawl Schedule</h2>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem;">Select which days full crawls run. Incremental crawls run every 15 minutes on all days.</p>
    <div class="schedule-grid" id="scheduleGrid"></div>
    <div class="info-row" style="margin-top:0.5rem;"><span class="info-label">Full Crawl CRON</span><span id="fullCrawlCron">—</span></div>
    <div class="info-row"><span class="info-label">Incremental CRON</span><span id="incrCrawlCron">—</span></div>
  </div>

  <!-- Actions Card -->
  <div class="card">
    <h2>Manual Actions</h2>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem;">Trigger crawls manually or manage the connection.</p>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="triggerCrawl('fullCrawl')">▶ Start Full Crawl</button>
      <button class="btn btn-primary" onclick="triggerCrawl('incrementalCrawl')">▶ Start Incremental</button>
      <button class="btn" onclick="triggerCrawl('deployConnection')">⚙ Deploy Connection</button>
    </div>
    <div class="log" id="actionLog" style="margin-top:1rem;">Ready. Click a button to trigger an action.</div>
  </div>

  <!-- Connection Card -->
  <div class="card">
    <h2>Connection Details</h2>
    <div class="info-row"><span class="info-label">Connector ID</span><span id="connectorId">—</span></div>
    <div class="info-row"><span class="info-label">Application</span><span id="application">—</span></div>
    <div class="info-row"><span class="info-label">Vault DNS</span><span id="vaultDns">—</span></div>
    <div class="info-row"><span class="info-label">Graph Connection</span><span id="connectionState">—</span></div>
  </div>
</div>

<script>
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let refreshInterval;
let currentDays = [];

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleString();
}

function timeAgo(iso) {
  if (!iso) return '';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm ago';
}

function initScheduleGrid() {
  const grid = document.getElementById('scheduleGrid');
  grid.innerHTML = '';
  DAYS.forEach((day, i) => {
    const btn = document.createElement('div');
    btn.className = 'day-btn' + (currentDays.includes(i) ? ' active' : '');
    btn.textContent = day;
    btn.onclick = () => { /* day toggle is visual-only in this version; config changes via env vars */ btn.classList.toggle('active'); };
    grid.appendChild(btn);
  });
}

async function fetchStatus() {
  try {
    const resp = await fetch('/api/dashboard/status');
    const data = await resp.json();

    // Connector info
    const c = data.connector || {};
    document.getElementById('connectorInfo').textContent = c.name + ' — ' + (c.vaultDns || '');
    document.getElementById('connectorId').textContent = c.id || '—';
    document.getElementById('application').textContent = (c.application || '—').toUpperCase();
    document.getElementById('vaultDns').textContent = c.vaultDns || '—';

    // Crawl state
    const s = data.crawlState || {};
    const statusText = document.getElementById('statusText');
    const badge = document.getElementById('statusBadge');
    const type = s.crawlType ? s.crawlType.charAt(0).toUpperCase() + s.crawlType.slice(1) : '';

    const isActive = s.status === 'running' || s.status === 'paused';

    badge.textContent = s.status || 'unknown';
    badge.className = 'badge badge-' + (s.status || 'idle');
    statusText.textContent = isActive ? type + ' Crawl' : (s.status || '—').charAt(0).toUpperCase() + (s.status || '—').slice(1);
    document.getElementById('statusDetail').textContent = s.status === 'running'
      ? 'Started ' + timeAgo(data.progress?.startedAt)
      : s.status === 'paused' ? 'Paused — will resume automatically' : '';

    // Heartbeat
    const hbRow = document.getElementById('heartbeatRow');
    const hbDot = document.getElementById('heartbeatDot');
    const hbText = document.getElementById('heartbeatText');
    if (data.progress && isActive) {
      hbRow.style.display = 'flex';
      const hbAge = data.progress.lastHeartbeat ? (Date.now() - new Date(data.progress.lastHeartbeat).getTime()) / 1000 : 999;
      hbDot.className = 'heartbeat-dot' + (hbAge < 120 ? '' : hbAge < 600 ? ' stale' : ' dead');
      hbText.textContent = 'Last heartbeat: ' + (data.progress.lastHeartbeat ? timeAgo(data.progress.lastHeartbeat) : 'never');
    } else {
      hbRow.style.display = 'none';
    }

    // Progress
    const pCard = document.getElementById('progressCard');
    if (data.progress && isActive) {
      pCard.style.display = 'block';
      const p = data.progress;
      document.getElementById('progressPct').textContent = p.percentComplete + '%';
      document.getElementById('progressBar').style.width = p.percentComplete + '%';
      document.getElementById('progressPhase').textContent = p.phase || '—';
      document.getElementById('progressItems').textContent = (p.itemsProcessed || 0).toLocaleString() + ' / ' + (p.totalItems || 0).toLocaleString();
      document.getElementById('progressRate').textContent = (p.itemsPerMinute || 0).toLocaleString() + ' items/min';
      document.getElementById('progressEta').textContent = p.estimatedCompletion ? formatDate(p.estimatedCompletion) : 'Calculating...';
      document.getElementById('progressElapsed').textContent = (p.elapsedMinutes || 0) < 60
        ? (p.elapsedMinutes || 0) + ' min'
        : Math.floor(p.elapsedMinutes / 60) + 'h ' + (p.elapsedMinutes % 60) + 'm';
    } else {
      pCard.style.display = 'none';
    }

    // Stats
    document.getElementById('lastFullCrawl').textContent = formatDate(s.lastFullCrawl);
    document.getElementById('lastIncremental').textContent = formatDate(s.lastIncrementalCrawl);
    document.getElementById('itemsIndexed').textContent = (s.itemCount || 0).toLocaleString();
    document.getElementById('lastIncrReindexed').textContent = (s.lastIncrementalItemsProcessed || 0).toLocaleString();
    const errRow = document.getElementById('errorRow');
    if (s.error) { errRow.style.display = 'flex'; document.getElementById('errorText').textContent = s.error; }
    else { errRow.style.display = 'none'; }

    // Schedule
    const sched = data.schedule || {};
    currentDays = sched.fullCrawlDays || [0,6];
    document.getElementById('fullCrawlCron').textContent = sched.fullCrawlSchedule || '—';
    document.getElementById('incrCrawlCron').textContent = sched.incrementalCrawlSchedule || '—';
    initScheduleGrid();

    // Connection
    const conn = data.connectionStatus || {};
    document.getElementById('connectionState').textContent = conn.state || conn.status || 'Unknown';
  } catch (e) {
    document.getElementById('statusText').textContent = 'Error';
    document.getElementById('statusBadge').textContent = 'unreachable';
    document.getElementById('statusBadge').className = 'badge badge-failed';
  }
}

async function triggerCrawl(endpoint) {
  const log = document.getElementById('actionLog');
  log.textContent += '\\n> Triggering ' + endpoint + '...';
  log.scrollTop = log.scrollHeight;
  try {
    const resp = await fetch('/api/' + endpoint, { method: 'POST' });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { status: resp.status, body: text || '(empty response)' }; }
    log.textContent += '\\n  ' + JSON.stringify(data, null, 2);
  } catch (e) {
    log.textContent += '\\n  ERROR: ' + e.message;
  }
  log.scrollTop = log.scrollHeight;
  setTimeout(fetchStatus, 1000);
}

// Initialize
fetchStatus();
refreshInterval = setInterval(fetchStatus, 10000);

let countdown = 10;
setInterval(() => {
  countdown = countdown <= 1 ? 10 : countdown - 1;
  document.getElementById('refreshTimer').textContent = 'Auto-refresh: ' + countdown + 's';
}, 1000);
</script>
</body>
</html>`;
}

// --- Register Azure Functions ---

app.http("deployConnection", { methods: ["POST"], authLevel: "function", handler: deployConnectionHandler });
app.timer("deployConnectionTimer", { schedule: process.env.DEPLOY_CONNECTION_SCHEDULE || "0 0 1 * * *", handler: deployConnectionTimerHandler });

app.http("fullCrawl", { methods: ["POST"], authLevel: "function", handler: fullCrawlHandler });
app.timer("fullCrawlTimer", { schedule: process.env.FULL_CRAWL_SCHEDULE || "0 0 2 * * *", handler: fullCrawlTimerHandler });

app.http("incrementalCrawl", { methods: ["POST"], authLevel: "function", handler: incrementalCrawlHandler });
app.timer("incrementalCrawlTimer", { schedule: process.env.INCREMENTAL_CRAWL_SCHEDULE || "0 */15 * * * *", handler: incrementalCrawlTimerHandler });

// Resume timer — checks every 5 minutes for paused crawls and continues them
app.timer("crawlResumeTimer", { schedule: process.env.CRAWL_RESUME_SCHEDULE || "0 */5 * * * *", handler: crawlResumeTimerHandler });

app.http("status", { methods: ["GET"], authLevel: "function", handler: statusHandler });
app.http("statusPatch", { methods: ["PATCH"], authLevel: "function", handler: statusPatchHandler });
app.http("dashboardStatus", { methods: ["GET"], authLevel: "anonymous", route: "dashboard/status", handler: statusHandler });
app.http("admin", { methods: ["GET"], authLevel: "anonymous", route: "dashboard", handler: adminHandler });
