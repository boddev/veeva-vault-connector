# Guided Setup — Veeva Vault Copilot Connector

Two automated setup methods are available. Both produce the same end result: a fully deployed connector that is actively indexing your Veeva Vault content, with the admin dashboard open in your browser.

## Quick Start

The fastest way to get started — double-click **`install.bat`** (or run `install.ps1`). The launcher will:

1. ✅ Check for all required tools (Node.js, npm, Azure CLI, Functions Core Tools, PowerShell 7)
2. 📦 Automatically install any missing prerequisites via `winget` / `npm`
3. 🔀 Ask you to choose: **PowerShell script** or **Browser GUI wizard**
4. 🚀 Launch your chosen setup method

```bash
# Option A: Double-click
setup\install.bat

# Option B: Run directly in PowerShell
.\setup\install.ps1
```

> The launcher handles prerequisites automatically — you don't need to install anything manually first.

---

## Prerequisites

The launcher installs these automatically, but for reference:

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org/) |
| **npm** | 10+ | Included with Node.js |
| **Azure CLI** | 2.x | [Install Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| **Azure Functions Core Tools** | 4.x | `npm install -g azure-functions-core-tools@4` |
| **PowerShell** | 7.x (recommended) or 5.1 | [Install PowerShell](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) |

You also need:
- An **Azure subscription** with permissions to create resources
- **Veeva Vault** API credentials (username, password, hostname) — see [Setup.md Step 3](../Setup.md#step-3-configure-veeva-vault-api-access)
- **Entra ID** privileges to create app registrations (Cloud Application Administrator), OR an existing app registration with the required Graph permissions

---

## Method 1: Script-Based Setup (PowerShell)

The PowerShell script reads a `.env` file and orchestrates the entire deployment end-to-end.

### Step 1: Create your .env file

```bash
# Copy the template
cp setup/.env.template setup/.env

# Edit with your values
code setup/.env    # or any editor
```

At minimum, fill in these **required** values:

| Variable | Description |
|----------|-------------|
| `VEEVA_VAULT_DNS` | Your Vault hostname (e.g., `mycompany.veevavault.com`) |
| `VEEVA_USERNAME` | Vault API user username |
| `SECRET_VEEVA_PASSWORD` | Vault API user password |

All other values have sensible defaults. To use an **existing Entra ID app registration**, also set:
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `SECRET_AZURE_CLIENT_SECRET`

Leave `AZURE_CLIENT_ID` blank to have the script create one automatically.

### Step 2: Run the setup script

```powershell
.\setup\setup.ps1
```

Or with a custom .env path:

```powershell
.\setup\setup.ps1 -EnvFile .\my-config.env
```

Optional flags:

| Flag | Description |
|------|-------------|
| `-EnvFile <path>` | Path to .env file (default: `setup/.env`) |
| `-SkipBuild` | Skip npm install/build (use if already built) |
| `-SkipAgents` | Skip M365 agent deployment |

### What the script does

1. **Validates prerequisites** — checks `az`, `node`, `npm` (and `func` for Azure Functions target) are installed
2. **Azure login** — prompts for login if not already authenticated
3. **Provisions infrastructure** — Resource Group, Storage Account, and either:
   - **Flex Consumption:** Function App (serverless, no App Service Plan needed)
   - **Azure Functions:** App Service Plan + Function App
   - **Container Apps:** Container Registry + Container Apps Environment + Function App on ACA
4. **Configures Entra ID** — creates app registration + service principal + client secret + Graph permissions (or uses your existing one)
5. **Sets up Key Vault** — creates Key Vault, enables managed identity, stores secrets (opt-out with `USE_KEY_VAULT=false`)
6. **Configures app settings** — sets all environment variables on the Function App
7. **Verifies Veeva connectivity** — tests API authentication against your Vault
8. **Builds and deploys** — `npm ci`, `npm run build`, `npm test`, then:
   - **Azure Functions:** `func azure functionapp publish`
   - **Container Apps:** `az acr build` + configures function app container image
9. **Initializes connection** — calls `deployConnection` to create the Graph external connection and register the schema
10. **Starts first crawl** — triggers `fullCrawl` to begin indexing content
11. **Opens admin dashboard** — launches the admin UI in your browser

The script is **idempotent** — safe to re-run if a step fails. Existing resources are detected and skipped.

---

## Method 2: GUI Setup Wizard (Browser)

A browser-based wizard that guides you through configuration and streams the deployment in real-time.

### Step 1: Start the wizard server

```bash
node setup/setup-gui.js
```

Or on a custom port:

```bash
node setup/setup-gui.js --port 8080
```

Your browser will open automatically to `http://localhost:3000`.

### Step 2: Walk through the wizard

The wizard has 5 steps:

1. **Configuration** — Load an existing `.env` file (drag & drop or file picker), or proceed to enter values manually. The wizard automatically reads `setup/.env` if it exists.

2. **Azure & Entra ID** — Choose deployment target (Azure Functions or Container Apps), configure Azure resource names, location, plan SKU or container settings, Key Vault, and Entra ID app registration details.

3. **Connector Settings** — Set Veeva credentials, Vault application, Graph API version, and crawl configuration.

4. **Review** — Review all settings before deploying.

5. **Deploy** — Real-time streaming output of the setup script. Watch each step execute with color-coded log output and a progress bar.

### How it works

The GUI is a **thin frontend** over `setup.ps1`. It:
- Collects your configuration values in the browser
- Writes them to a temporary `.env` file
- Launches `setup.ps1` in a subprocess
- Streams stdout/stderr back to the browser via Server-Sent Events (SSE)
- Shows a direct link to the admin dashboard on completion

The GUI server runs locally and does not send any data externally. Close the terminal (Ctrl+C) to stop the server when done.

---

## Configuration Reference

See [`.env.template`](./.env.template) for all available variables with descriptions and defaults.

### Key configuration choices

| Choice | Options | Recommendation |
|--------|---------|----------------|
| **Deploy Target** | `flex-consumption` (default), `azure-functions`, or `container-app` | Flex for serverless; Functions for always-warm; Container Apps for container orgs |
| **Entra ID** | Auto-create or bring-your-own | BYO for restricted tenants; auto-create for dev/test |
| **Key Vault** | Enabled (default) or disabled | Always enable for production |
| **Graph API** | `v1.0` (default) or `beta` | Use `v1.0` for production; `beta` for enhanced search features |
| **Plan SKU** | EP1/EP2/EP3 or P1v3/P2v3/P3v3 (only for `azure-functions` target) | EP1 for <100K docs; EP2/EP3 for enterprise |

### Entra ID permissions required

If auto-creating, the script adds these Microsoft Graph application permissions:

| Permission | Purpose |
|-----------|---------|
| `ExternalConnection.ReadWrite.OwnedBy` | Create/manage external connections |
| `ExternalItem.ReadWrite.OwnedBy` | Create/update/delete external items |
| `ExternalConnection.Read.All` | Read connection configurations |
| `Directory.Read.All` | Resolve Vault users to Entra ID identities |
| `Group.Read.All` | Resolve Vault groups for ACL mapping |
| `User.Read.All` | Look up users by email/UPN |

> **Note:** Admin consent is required and may need a Global Administrator or Cloud Application Administrator. If auto-consent fails, the script provides manual instructions.

---

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `az: command not found` | Install [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| `func: command not found` | `npm install -g azure-functions-core-tools@4` |
| Admin consent fails | Grant consent manually in the [Entra admin center](https://entra.microsoft.com) |
| Function App name taken | Set a unique `AZURE_FUNCTION_APP` name in your .env |
| Key Vault access denied | Wait 30s for identity propagation and re-run the script |
| Veeva auth fails | Verify credentials and that the API user has VaultActions_API_Access |
| GUI won't start | Ensure port 3000 is free, or use `--port 8080` |

---

## Post-Setup

After the setup completes:

1. **Monitor the crawl** — Open the admin dashboard to watch progress
2. **Verify in M365 Admin** — Check [admin.microsoft.com](https://admin.microsoft.com) → Settings → Search & intelligence → Data sources
3. **Test in Copilot** — Ask Copilot about your Vault content
4. **Deploy agents** (optional) — Run `teamsapp provision && teamsapp deploy` to enable dedicated Copilot agents

For detailed production guidance, see [Setup.md — Production Recommendations](../Setup.md#production-recommendations).
