#!/usr/bin/env node
/**
 * Veeva Vault Copilot Connector — GUI Setup Wizard
 *
 * A lightweight local web server that provides a browser-based wizard for
 * configuring and deploying the connector. It is a thin frontend over
 * setup.ps1 — all provisioning logic lives in the PowerShell script.
 *
 * Usage:
 *   node setup/setup-gui.js
 *   node setup/setup-gui.js --port 8080
 *
 * The wizard:
 *   1. Loads values from setup/.env (or lets the user fill them in)
 *   2. Validates required fields
 *   3. Writes a temporary .env file and launches setup.ps1
 *   4. Streams real-time output back to the browser via SSE
 *   5. On completion, opens the admin dashboard
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const url = require("url");

const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--port") || "3000", 10);
const SETUP_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SETUP_DIR, "..");
const ENV_PATH = path.join(SETUP_DIR, ".env");
const TEMP_ENV_PATH = path.join(SETUP_DIR, ".env.gui-session");

// ─── .env file parser ──────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.substring(0, eq).trim();
    let val = trimmed.substring(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function writeEnvFile(filePath, vars) {
  const lines = [];
  for (const [key, val] of Object.entries(vars)) {
    if (val !== undefined && val !== null && val !== "") {
      lines.push(`${key}=${val}`);
    }
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ─── Active deploy process tracking ────────────────────────────────────────

let activeProcess = null;
const sseClients = new Set();

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ─── HTTP Server ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Route: GET / — Serve the wizard HTML
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getWizardHTML());
  }

  // Route: GET /api/env — Return current .env values (secrets masked)
  if (pathname === "/api/env" && req.method === "GET") {
    const vars = parseEnvFile(ENV_PATH);
    // Mask secrets
    const masked = { ...vars };
    for (const key of Object.keys(masked)) {
      if (key.startsWith("SECRET_") && masked[key]) {
        masked[key] = "••••••••";
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(masked));
  }

  // Route: POST /api/env — Save .env values (also used for upload)
  if (pathname === "/api/env" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const vars = JSON.parse(body);
        writeEnvFile(ENV_PATH, vars);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, saved: Object.keys(vars).length }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Route: POST /api/deploy — Start setup.ps1
  if (pathname === "/api/deploy" && req.method === "POST") {
    if (activeProcess) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Deployment already in progress" }));
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const vars = JSON.parse(body);
        writeEnvFile(TEMP_ENV_PATH, vars);

        const scriptPath = path.join(SETUP_DIR, "setup.ps1");
        const args = [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", scriptPath,
          "-EnvFile", TEMP_ENV_PATH
        ];

        // Try pwsh first (PS7), fall back to powershell
        const shell = fs.existsSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
          ? "pwsh" : "powershell";

        activeProcess = spawn(shell, args, {
          cwd: PROJECT_ROOT,
          env: { ...process.env, TERM: "dumb" },
          stdio: ["ignore", "pipe", "pipe"]
        });

        broadcastSSE("status", { state: "running", message: "Deployment started" });

        activeProcess.stdout.on("data", (data) => {
          const text = data.toString("utf-8");
          broadcastSSE("log", { stream: "stdout", text });
        });

        activeProcess.stderr.on("data", (data) => {
          const text = data.toString("utf-8");
          broadcastSSE("log", { stream: "stderr", text });
        });

        activeProcess.on("close", (code) => {
          broadcastSSE("status", {
            state: code === 0 ? "complete" : "failed",
            code,
            message: code === 0 ? "Deployment completed successfully!" : `Deployment failed (exit code ${code})`
          });
          activeProcess = null;
          // Clean up temp env
          try { fs.unlinkSync(TEMP_ENV_PATH); } catch {}
        });

        activeProcess.on("error", (err) => {
          broadcastSSE("status", { state: "failed", message: `Process error: ${err.message}` });
          activeProcess = null;
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Deployment started" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Route: GET /api/events — SSE stream for deployment output
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connected to setup server" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Route: POST /api/cancel — Cancel running deployment
  if (pathname === "/api/cancel" && req.method === "POST") {
    if (activeProcess) {
      activeProcess.kill("SIGTERM");
      activeProcess = null;
      broadcastSSE("status", { state: "cancelled", message: "Deployment cancelled by user" });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Route: GET /api/status — Check deployment status
  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ running: activeProcess !== null }));
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  const wizardUrl = `http://localhost:${PORT}`;
  console.log("");
  console.log("  ╔══════════════════════════════════════════════════════════════╗");
  console.log("  ║   Veeva Vault Connector — Setup Wizard                      ║");
  console.log(`  ║   ${wizardUrl.padEnd(55)}║`);
  console.log("  ╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Opening browser...");
  console.log("  Press Ctrl+C to stop the wizard server.");
  console.log("");

  // Auto-open browser
  const { exec } = require("child_process");
  if (process.platform === "win32") exec(`start "" "${wizardUrl}"`, { shell: "cmd.exe" });
  else if (process.platform === "darwin") exec(`open ${wizardUrl}`);
  else exec(`xdg-open ${wizardUrl}`);
});

// ─── Embedded Wizard HTML ──────────────────────────────────────────────────

function getWizardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Veeva Vault Connector — Setup Wizard</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #e2e8f0; --muted: #94a3b8;
          --accent: #3b82f6; --green: #22c55e; --yellow: #eab308; --red: #ef4444; --input-bg: #0f172a; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: var(--bg); color: var(--text); min-height: 100vh; }

  .header { padding: 1.5rem 2rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 1rem; }
  .header h1 { font-size: 1.25rem; }
  .header .badge { font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 9999px;
                   background: rgba(59,130,246,0.15); color: var(--accent); font-weight: 600; }

  .container { max-width: 900px; margin: 0 auto; padding: 2rem; }

  /* Stepper */
  .stepper { display: flex; gap: 0.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .step-dot { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem;
              border-radius: 0.5rem; font-size: 0.8rem; color: var(--muted); background: var(--card);
              border: 1px solid var(--border); cursor: pointer; transition: all 0.2s; }
  .step-dot.active { background: var(--accent); color: white; border-color: var(--accent); }
  .step-dot.complete { background: rgba(34,197,94,0.15); color: var(--green); border-color: var(--green); }
  .step-dot .num { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center;
                   justify-content: center; font-size: 0.7rem; font-weight: 700; background: var(--border); }
  .step-dot.active .num { background: rgba(255,255,255,0.2); }
  .step-dot.complete .num { background: var(--green); color: white; }

  /* Cards */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1rem; margin-bottom: 0.25rem; }
  .card .desc { color: var(--muted); font-size: 0.8rem; margin-bottom: 1.25rem; }

  /* Form */
  .field { margin-bottom: 1rem; }
  .field label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 0.3rem; font-weight: 500; }
  .field input, .field select { width: 100%; padding: 0.6rem 0.8rem; border-radius: 0.5rem;
    border: 1px solid var(--border); background: var(--input-bg); color: var(--text);
    font-size: 0.875rem; font-family: inherit; transition: border-color 0.2s; }
  .field input:focus, .field select:focus { outline: none; border-color: var(--accent); }
  .field input.error { border-color: var(--red); }
  .field .hint { font-size: 0.7rem; color: var(--muted); margin-top: 0.2rem; }
  .field .err-msg { font-size: 0.7rem; color: var(--red); margin-top: 0.2rem; display: none; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }

  /* Buttons */
  .btn { padding: 0.6rem 1.2rem; border-radius: 0.5rem; border: 1px solid var(--border);
         background: var(--card); color: var(--text); cursor: pointer; font-size: 0.875rem;
         font-family: inherit; transition: all 0.2s; display: inline-flex; align-items: center; gap: 0.5rem; }
  .btn:hover { background: var(--border); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { background: #2563eb; }
  .btn-danger { background: var(--red); border-color: var(--red); color: white; }
  .btn-danger:hover { background: #dc2626; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-group { display: flex; justify-content: space-between; margin-top: 1.5rem; }

  /* File drop zone */
  .drop-zone { border: 2px dashed var(--border); border-radius: 0.75rem; padding: 2rem;
               text-align: center; color: var(--muted); font-size: 0.85rem; cursor: pointer;
               transition: all 0.2s; margin-bottom: 1rem; }
  .drop-zone:hover, .drop-zone.drag-over { border-color: var(--accent); background: rgba(59,130,246,0.05); }

  /* Deploy log */
  .log-container { background: #0d1117; border: 1px solid var(--border); border-radius: 0.5rem;
                   padding: 1rem; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
                   font-size: 0.75rem; max-height: 500px; overflow-y: auto; line-height: 1.7;
                   color: var(--muted); white-space: pre-wrap; word-break: break-all; }
  .log-line { }
  .log-line.stderr { color: var(--yellow); }
  .log-line.error { color: var(--red); }
  .log-line.success { color: var(--green); }

  /* Progress */
  .progress-bar { width: 100%; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin: 1rem 0; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green));
                   border-radius: 3px; transition: width 0.5s ease; width: 0%; }

  /* Sections hidden by default */
  .wizard-step { display: none; }
  .wizard-step.active { display: block; }

  /* Summary */
  .summary-table { width: 100%; border-collapse: collapse; }
  .summary-table td { padding: 0.4rem 0; font-size: 0.85rem; border-bottom: 1px solid var(--border); }
  .summary-table td:first-child { color: var(--muted); width: 40%; }

  /* Success banner */
  .success-banner { background: rgba(34,197,94,0.1); border: 1px solid var(--green); border-radius: 0.75rem;
                    padding: 1.5rem; text-align: center; margin-bottom: 1.5rem; }
  .success-banner h2 { color: var(--green); font-size: 1.25rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>

<div class="header">
  <h1>🔗 Veeva Vault Connector</h1>
  <span class="badge">Setup Wizard</span>
</div>

<div class="container">
  <!-- Stepper -->
  <div class="stepper" id="stepper">
    <div class="step-dot active" data-step="0"><span class="num">1</span> Configuration</div>
    <div class="step-dot" data-step="1"><span class="num">2</span> Azure & Entra ID</div>
    <div class="step-dot" data-step="2"><span class="num">3</span> Connector Settings</div>
    <div class="step-dot" data-step="3"><span class="num">4</span> Review</div>
    <div class="step-dot" data-step="4"><span class="num">5</span> Deploy</div>
  </div>

  <!-- Step 0: Configuration Source -->
  <div class="wizard-step active" id="step-0">
    <div class="card">
      <h2>Load Configuration</h2>
      <p class="desc">Import your .env file or enter values manually. The wizard will try to load <code>setup/.env</code> automatically.</p>

      <div class="drop-zone" id="dropZone">
        📄 Drag &amp; drop your .env file here, or click to browse
        <input type="file" id="envFileInput" accept=".env,.env.*,.txt" style="display:none">
      </div>

      <div id="loadStatus" style="font-size:0.8rem; margin-bottom:1rem; color:var(--muted);"></div>
    </div>

    <div class="btn-group">
      <div></div>
      <button class="btn btn-primary" onclick="goToStep(1)">Next →</button>
    </div>
  </div>

  <!-- Step 1: Azure & Entra ID -->
  <div class="wizard-step" id="step-1">
    <div class="card">
      <h2>Azure Subscription</h2>
      <p class="desc">Azure resource configuration. Names are auto-derived but can be customized.</p>

      <div class="field-row">
        <div class="field">
          <label>Deploy Target *</label>
          <select id="f_DEPLOY_TARGET" onchange="toggleDeployTarget()">
            <option value="flex-consumption">Flex Consumption (serverless, pay-per-use) — Recommended</option>
            <option value="azure-functions">Azure Functions (App Service Plan)</option>
            <option value="container-app">Azure Functions on Container Apps</option>
          </select>
        </div>
        <div class="field">
          <label>Azure Location *</label>
          <select id="f_AZURE_LOCATION">
            <option value="eastus">East US</option>
            <option value="eastus2">East US 2</option>
            <option value="westus2">West US 2</option>
            <option value="westus3">West US 3</option>
            <option value="centralus">Central US</option>
            <option value="northeurope">North Europe</option>
            <option value="westeurope">West Europe</option>
            <option value="uksouth">UK South</option>
            <option value="southeastasia">Southeast Asia</option>
            <option value="australiaeast">Australia East</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Subscription ID</label>
          <input id="f_AZURE_SUBSCRIPTION_ID" placeholder="Leave blank for default subscription">
          <div class="hint">Optional — uses your current az CLI subscription if blank</div>
        </div>
        <div class="field">
          <label>Resource Group</label>
          <input id="f_AZURE_RESOURCE_GROUP" placeholder="rg-veeva-connector">
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Storage Account</label>
          <input id="f_AZURE_STORAGE_ACCOUNT" placeholder="Auto-derived from app name">
          <div class="hint">3–24 chars, lowercase alphanumeric only</div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Function App Name</label>
          <input id="f_AZURE_FUNCTION_APP" placeholder="Auto-derived from app name">
          <div class="hint">Must be globally unique</div>
        </div>
        <div class="field" id="skuField">
          <label>App Service Plan SKU</label>
          <select id="f_AZURE_PLAN_SKU">
            <option value="FC1">FC1 — Flex Consumption (serverless, pay-per-use)</option>
            <option value="EP1">EP1 — Premium Elastic (1 vCPU, 3.5 GB)</option>
            <option value="EP2">EP2 — Premium Elastic (2 vCPU, 7 GB)</option>
            <option value="EP3">EP3 — Premium Elastic (4 vCPU, 14 GB)</option>
            <option value="P1v3">P1v3 — Dedicated (2 vCPU, 8 GB)</option>
            <option value="P2v3">P2v3 — Dedicated (4 vCPU, 16 GB)</option>
            <option value="P3v3">P3v3 — Dedicated (8 vCPU, 32 GB)</option>
          </select>
        </div>
      </div>

      <div id="containerFields" style="display:none;">
        <div class="field-row">
          <div class="field">
            <label>Container Registry Name</label>
            <input id="f_AZURE_CONTAINER_REGISTRY" placeholder="Auto-derived from app name">
            <div class="hint">Azure Container Registry (lowercase alphanumeric)</div>
          </div>
          <div class="field">
            <label>Container Apps Environment</label>
            <input id="f_AZURE_CONTAINER_APP_ENV" placeholder="cae-veeva-connector">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Container CPU</label>
            <select id="f_CONTAINER_CPU">
              <option value="0.5">0.5 vCPU</option>
              <option value="1.0" selected>1.0 vCPU</option>
              <option value="2.0">2.0 vCPU</option>
              <option value="4.0">4.0 vCPU</option>
            </select>
          </div>
          <div class="field">
            <label>Container Memory</label>
            <select id="f_CONTAINER_MEMORY">
              <option value="1.0Gi">1.0 GB</option>
              <option value="2.0Gi" selected>2.0 GB</option>
              <option value="4.0Gi">4.0 GB</option>
              <option value="8.0Gi">8.0 GB</option>
            </select>
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Application Insights</label>
          <input id="f_AZURE_APP_INSIGHTS" placeholder="ai-veeva-connector">
          <div class="hint">Leave blank to skip App Insights creation</div>
        </div>
        <div class="field">
          <label>Key Vault</label>
          <select id="f_USE_KEY_VAULT">
            <option value="true">Enabled (recommended for production)</option>
            <option value="false">Disabled (dev/test only)</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Entra ID (Azure AD)</h2>
      <p class="desc">Provide existing app registration details, or leave Client ID blank to create one automatically.</p>

      <div class="field-row">
        <div class="field">
          <label>Tenant ID</label>
          <input id="f_AZURE_TENANT_ID" placeholder="Auto-detected from az login">
        </div>
        <div class="field">
          <label>Client ID</label>
          <input id="f_AZURE_CLIENT_ID" placeholder="Leave blank to auto-create">
          <div class="hint">Leave empty to create a new app registration</div>
        </div>
      </div>

      <div class="field">
        <label>Client Secret</label>
        <input id="f_SECRET_AZURE_CLIENT_SECRET" type="password" placeholder="Leave blank if auto-creating">
      </div>
    </div>

    <div class="btn-group">
      <button class="btn" onclick="goToStep(0)">← Back</button>
      <button class="btn btn-primary" onclick="goToStep(2)">Next →</button>
    </div>
  </div>

  <!-- Step 2: Veeva & Connector -->
  <div class="wizard-step" id="step-2">
    <div class="card">
      <h2>Veeva Vault Credentials</h2>
      <p class="desc">API credentials for your Veeva Vault instance. See Setup.md Step 3 for creating an API user.</p>

      <div class="field">
        <label>Vault Hostname *</label>
        <input id="f_VEEVA_VAULT_DNS" placeholder="mycompany-promomats.veevavault.com" required>
        <div class="err-msg" id="err_VEEVA_VAULT_DNS">Vault hostname is required</div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>API Username *</label>
          <input id="f_VEEVA_USERNAME" placeholder="api-copilot-connector@yourdomain.com" required>
          <div class="err-msg" id="err_VEEVA_USERNAME">Username is required</div>
        </div>
        <div class="field">
          <label>API Password *</label>
          <input id="f_SECRET_VEEVA_PASSWORD" type="password" placeholder="Vault API password" required>
          <div class="err-msg" id="err_SECRET_VEEVA_PASSWORD">Password is required</div>
        </div>
      </div>

      <div class="field">
        <label>Veeva API Version</label>
        <input id="f_VEEVA_API_VERSION" placeholder="v25.3" value="v25.3">
      </div>
    </div>

    <div class="card">
      <h2>Connector Settings</h2>
      <p class="desc">Configure the connector behavior.</p>

      <div class="field-row">
        <div class="field">
          <label>Vault Application *</label>
          <select id="f_VAULT_APPLICATION">
            <option value="promomats">PromoMats — Promotional content</option>
            <option value="qualitydocs">QualityDocs — Quality management</option>
            <option value="rim">RIM — Regulatory information</option>
          </select>
        </div>
        <div class="field">
          <label>Graph API Version</label>
          <select id="f_GRAPH_API_VERSION">
            <option value="v1.0">v1.0 — Stable (recommended)</option>
            <option value="beta">Beta — Preview features (rankingHint, etc.)</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Full Crawl Days</label>
          <input id="f_FULL_CRAWL_DAYS" placeholder="0,6" value="0,6">
          <div class="hint">0=Sun through 6=Sat, comma-separated. Empty = every day.</div>
        </div>
        <div class="field">
          <label>Progress Batch Size</label>
          <input id="f_PROGRESS_BATCH_SIZE" type="number" value="500" min="100">
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Crawl Batch Size</label>
          <input id="f_CRAWL_BATCH_SIZE" type="number" value="25" min="5">
        </div>
        <div class="field">
          <label>M365 Agents</label>
          <select id="f_DEPLOY_M365_AGENTS">
            <option value="false">Skip agent deployment</option>
            <option value="true">Deploy M365 Copilot agents</option>
          </select>
        </div>
      </div>
    </div>

    <div class="btn-group">
      <button class="btn" onclick="goToStep(1)">← Back</button>
      <button class="btn btn-primary" onclick="validateAndReview()">Next → Review</button>
    </div>
  </div>

  <!-- Step 3: Review -->
  <div class="wizard-step" id="step-3">
    <div class="card">
      <h2>Review Configuration</h2>
      <p class="desc">Review your settings before deploying. Click "Deploy" to begin provisioning.</p>

      <table class="summary-table" id="summaryTable"></table>
    </div>

    <div class="btn-group">
      <button class="btn" onclick="goToStep(2)">← Edit</button>
      <button class="btn btn-primary" id="deployBtn" onclick="startDeploy()">🚀 Deploy Connector</button>
    </div>
  </div>

  <!-- Step 4: Deploy -->
  <div class="wizard-step" id="step-4">
    <div class="card" id="deployStatusCard">
      <h2 id="deployTitle">Deploying...</h2>
      <p class="desc" id="deployDesc">The setup script is running. This may take several minutes.</p>
      <div class="progress-bar"><div class="progress-fill" id="deployProgress"></div></div>
    </div>

    <div class="log-container" id="deployLog"></div>

    <div class="btn-group" style="margin-top:1rem;">
      <button class="btn btn-danger" id="cancelBtn" onclick="cancelDeploy()">✕ Cancel</button>
      <button class="btn btn-primary" id="openAdminBtn" onclick="openAdmin()" style="display:none;">Open Admin Dashboard →</button>
    </div>

    <div class="success-banner" id="successBanner" style="display:none; margin-top:1.5rem;">
      <h2>✅ Deployment Complete!</h2>
      <p style="color:var(--muted); font-size:0.9rem;">Your connector is deployed and the first crawl has started.</p>
      <p style="margin-top:0.75rem; font-size:0.85rem;">Admin dashboard: <a id="adminLink" href="#" target="_blank" style="color:var(--accent);"></a></p>
    </div>
  </div>
</div>

<script>
// ─── State ─────────────────────────────────────────────────────────────────

let currentStep = 0;
let formData = {};
let eventSource = null;

const ALL_FIELDS = [
  'DEPLOY_TARGET', 'AZURE_SUBSCRIPTION_ID', 'AZURE_LOCATION', 'AZURE_RESOURCE_GROUP', 'AZURE_STORAGE_ACCOUNT',
  'AZURE_FUNCTION_APP', 'AZURE_PLAN_SKU', 'AZURE_APP_INSIGHTS', 'USE_KEY_VAULT',
  'AZURE_CONTAINER_REGISTRY', 'AZURE_CONTAINER_APP_ENV', 'CONTAINER_CPU', 'CONTAINER_MEMORY',
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'SECRET_AZURE_CLIENT_SECRET',
  'VEEVA_VAULT_DNS', 'VEEVA_USERNAME', 'SECRET_VEEVA_PASSWORD', 'VEEVA_API_VERSION',
  'VAULT_APPLICATION', 'GRAPH_API_VERSION', 'FULL_CRAWL_DAYS', 'CRAWL_BATCH_SIZE',
  'PROGRESS_BATCH_SIZE', 'DEPLOY_M365_AGENTS', 'AUTO_DISCOVER_OBJECTS',
  'AZURE_KEY_VAULT'
];

const REQUIRED_FIELDS = ['VEEVA_VAULT_DNS', 'VEEVA_USERNAME', 'SECRET_VEEVA_PASSWORD'];

// ─── Initialization ────────────────────────────────────────────────────────

async function init() {
  // Try loading .env from server
  try {
    const resp = await fetch('/api/env');
    const data = await resp.json();
    if (Object.keys(data).length > 0) {
      populateForm(data);
      document.getElementById('loadStatus').innerHTML =
        '<span style="color:var(--green)">✅ Loaded ' + Object.keys(data).length + ' values from setup/.env</span>';
    } else {
      document.getElementById('loadStatus').textContent = 'No .env file found — enter values manually.';
    }
  } catch {
    document.getElementById('loadStatus').textContent = 'Could not read .env from server.';
  }

  // File drop zone
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('envFileInput');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  // Connect SSE
  connectSSE();
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const vars = parseEnvText(e.target.result);
    populateForm(vars);
    document.getElementById('loadStatus').innerHTML =
      '<span style="color:var(--green)">✅ Loaded ' + Object.keys(vars).length + ' values from ' + file.name + '</span>';
  };
  reader.readAsText(file);
}

function parseEnvText(text) {
  const vars = {};
  for (const line of text.split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.substring(0, eq).trim();
    let val = trimmed.substring(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) vars[key] = val;
  }
  return vars;
}

function populateForm(vars) {
  for (const [key, val] of Object.entries(vars)) {
    const el = document.getElementById('f_' + key);
    if (el && val) {
      el.value = val;
    }
  }
  toggleDeployTarget();
}

function toggleDeployTarget() {
  const target = document.getElementById('f_DEPLOY_TARGET').value;
  const isACA = target === 'container-app';
  const isFlex = target === 'flex-consumption';
  const skuField = document.getElementById('skuField');
  const skuSelect = document.getElementById('f_AZURE_PLAN_SKU');
  skuField.style.display = isACA ? 'none' : '';
  document.getElementById('containerFields').style.display = isACA ? '' : 'none';
  if (isFlex) {
    skuSelect.value = 'FC1';
    skuSelect.disabled = true;
  } else {
    skuSelect.disabled = false;
    if (skuSelect.value === 'FC1') skuSelect.value = 'EP1';
  }
}

function collectForm() {
  const data = {};
  for (const key of ALL_FIELDS) {
    const el = document.getElementById('f_' + key);
    if (el && el.value) {
      data[key] = el.value;
    }
  }
  return data;
}

// ─── Navigation ────────────────────────────────────────────────────────────

function goToStep(step) {
  const steps = document.querySelectorAll('.wizard-step');
  const dots = document.querySelectorAll('.step-dot');

  steps.forEach(s => s.classList.remove('active'));
  document.getElementById('step-' + step).classList.add('active');

  dots.forEach((d, i) => {
    d.classList.remove('active');
    if (i < step) d.classList.add('complete');
    if (i === step) { d.classList.add('active'); d.classList.remove('complete'); }
  });

  currentStep = step;
  window.scrollTo(0, 0);
}

function validateAndReview() {
  let valid = true;
  for (const key of REQUIRED_FIELDS) {
    const el = document.getElementById('f_' + key);
    const errEl = document.getElementById('err_' + key);
    if (!el.value) {
      el.classList.add('error');
      if (errEl) errEl.style.display = 'block';
      valid = false;
    } else {
      el.classList.remove('error');
      if (errEl) errEl.style.display = 'none';
    }
  }
  if (!valid) return;

  formData = collectForm();
  buildSummary();
  goToStep(3);
}

function buildSummary() {
  const table = document.getElementById('summaryTable');
  const isACA = formData.DEPLOY_TARGET === 'container-app';
  const isFlex = formData.DEPLOY_TARGET === 'flex-consumption';
  const targetLabel = isFlex ? 'Flex Consumption' : isACA ? 'Container Apps' : 'Azure Functions (App Service Plan)';
  const displayOrder = [
    ['Deploy Target', targetLabel],
    ['Vault Application', formData.VAULT_APPLICATION || 'promomats'],
    ['Vault Hostname', formData.VEEVA_VAULT_DNS],
    ['Vault Username', formData.VEEVA_USERNAME],
    ['Azure Location', formData.AZURE_LOCATION || 'eastus'],
    ['Function App', formData.AZURE_FUNCTION_APP || '(auto-derived)'],
  ];
  if (isACA) {
    displayOrder.push(['Container Registry', formData.AZURE_CONTAINER_REGISTRY || '(auto-derived)']);
    displayOrder.push(['Container CPU/Memory', (formData.CONTAINER_CPU || '1.0') + ' vCPU / ' + (formData.CONTAINER_MEMORY || '2.0Gi')]);
  } else {
    displayOrder.push(['Plan SKU', formData.AZURE_PLAN_SKU || (isFlex ? 'FC1' : 'EP1')]);
  }
  displayOrder.push(
    ['Graph API Version', formData.GRAPH_API_VERSION || 'v1.0'],
    ['Key Vault', formData.USE_KEY_VAULT === 'false' ? 'Disabled' : 'Enabled'],
    ['Entra ID App', formData.AZURE_CLIENT_ID || '(will create automatically)'],
    ['Full Crawl Days', formData.FULL_CRAWL_DAYS || '0,6'],
    ['M365 Agents', formData.DEPLOY_M365_AGENTS === 'true' ? 'Will deploy' : 'Skip'],
  );

  table.innerHTML = displayOrder.map(([label, val]) =>
    '<tr><td>' + label + '</td><td>' + (val || '—') + '</td></tr>'
  ).join('');
}

// ─── Deploy ────────────────────────────────────────────────────────────────

async function startDeploy() {
  goToStep(4);
  document.getElementById('deployLog').textContent = '';
  document.getElementById('deployProgress').style.width = '0%';
  document.getElementById('deployTitle').textContent = 'Deploying...';
  document.getElementById('deployDesc').textContent = 'The setup script is running. This may take several minutes.';
  document.getElementById('cancelBtn').style.display = '';
  document.getElementById('openAdminBtn').style.display = 'none';
  document.getElementById('successBanner').style.display = 'none';

  try {
    const resp = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    const data = await resp.json();
    if (!resp.ok) {
      appendLog('ERROR: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    appendLog('ERROR: Could not start deployment — ' + e.message, 'error');
  }
}

async function cancelDeploy() {
  if (!confirm('Are you sure you want to cancel the deployment?')) return;
  try { await fetch('/api/cancel', { method: 'POST' }); } catch {}
}

function openAdmin() {
  const app = formData.AZURE_FUNCTION_APP || 'func-veeva-' + (formData.VAULT_APPLICATION || 'promomats');
  window.open('https://' + app + '.azurewebsites.net/api/admin', '_blank');
}

// ─── SSE (Server-Sent Events) ──────────────────────────────────────────────

function connectSSE() {
  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    appendLog(data.text, data.stream === 'stderr' ? 'stderr' : '');
    updateProgressFromLog(data.text);
  });

  eventSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    if (data.state === 'complete') {
      document.getElementById('deployTitle').textContent = '✅ Deployment Complete!';
      document.getElementById('deployDesc').textContent = data.message;
      document.getElementById('deployProgress').style.width = '100%';
      document.getElementById('cancelBtn').style.display = 'none';
      document.getElementById('openAdminBtn').style.display = '';
      document.getElementById('successBanner').style.display = '';

      const app = formData.AZURE_FUNCTION_APP || 'func-veeva-' + (formData.VAULT_APPLICATION || 'promomats');
      const adminUrl = 'https://' + app + '.azurewebsites.net/api/admin';
      const link = document.getElementById('adminLink');
      link.href = adminUrl;
      link.textContent = adminUrl;

      // Mark step complete
      document.querySelectorAll('.step-dot').forEach(d => d.classList.add('complete'));
    } else if (data.state === 'failed') {
      document.getElementById('deployTitle').textContent = '❌ Deployment Failed';
      document.getElementById('deployDesc').textContent = data.message;
      document.getElementById('deployProgress').style.width = '100%';
      document.getElementById('deployProgress').style.background = 'var(--red)';
      document.getElementById('cancelBtn').textContent = '← Back to Review';
      document.getElementById('cancelBtn').className = 'btn';
      document.getElementById('cancelBtn').onclick = () => goToStep(3);
    } else if (data.state === 'cancelled') {
      document.getElementById('deployTitle').textContent = '⚠️ Deployment Cancelled';
      document.getElementById('deployDesc').textContent = data.message;
      document.getElementById('cancelBtn').textContent = '← Back to Review';
      document.getElementById('cancelBtn').className = 'btn';
      document.getElementById('cancelBtn').onclick = () => goToStep(3);
    }
  });
}

let stepProgress = 0;
function updateProgressFromLog(text) {
  // Parse step indicators from setup.ps1 output to update progress bar
  const stepMatch = text.match(/\\[(\\d+)\\/10\\]/);
  if (stepMatch) {
    stepProgress = parseInt(stepMatch[1]) * 10;
    document.getElementById('deployProgress').style.width = stepProgress + '%';
  }
}

function appendLog(text, className) {
  const log = document.getElementById('deployLog');
  const lines = text.split('\\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const el = document.createElement('div');
    el.className = 'log-line' + (className ? ' ' + className : '');

    // Color-code certain patterns
    if (line.includes('✅')) el.classList.add('success');
    else if (line.includes('❌') || line.includes('ERROR')) el.classList.add('error');
    else if (line.includes('⚠')) el.classList.add('stderr');

    el.textContent = line;
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}

// ─── Boot ──────────────────────────────────────────────────────────────────
init();
</script>
</body>
</html>`;
}
