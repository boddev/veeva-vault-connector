# Setup Guide — Veeva Vault Unified Copilot Connector

This guide walks you through every step required to deploy the Veeva Vault Unified Copilot Connector, from a fresh environment to a fully operational instance indexing content into Microsoft 365 Copilot. It covers Azure resource provisioning, Veeva API configuration, Microsoft Graph permissions, build and deployment, and production recommendations.

> **🚀 Quick Start:** For an automated end-to-end setup, double-click **[`setup/install.bat`](./setup/install.bat)** — it checks and installs prerequisites automatically, then lets you choose between a **PowerShell script** or **browser-based GUI wizard**. See the [Guided Setup documentation](./setup/README.md) for details.

---

## Table of Contents

- [Guided Setup (Automated)](#guided-setup-automated)
- [Prerequisites](#prerequisites)
- [Architecture Overview](#architecture-overview)
- [Step 1: Provision Azure Resources](#step-1-provision-azure-resources)
- [Step 2: Register the Entra ID Application](#step-2-register-the-entra-id-application)
- [Step 3: Configure Veeva Vault API Access](#step-3-configure-veeva-vault-api-access)
- [Step 4: Clone and Build the Connector](#step-4-clone-and-build-the-connector)
- [Step 5: Configure Environment Variables](#step-5-configure-environment-variables)
- [Step 6: Deploy to Azure](#step-6-deploy-to-azure)
- [Step 7: Initialize the Connection](#step-7-initialize-the-connection)
- [Step 8: Verify the Deployment](#step-8-verify-the-deployment)
- [Step 9: Deploy the M365 Copilot Agents](#step-9-deploy-the-m365-copilot-agents)
- [Multi-Application Deployment](#multi-application-deployment)
- [Cross-Tenant Deployment](#cross-tenant-deployment)
- [Azure Hosting Options](#azure-hosting-options)
- [Production Recommendations](#production-recommendations)
- [Environment Variable Reference](#environment-variable-reference)
- [Troubleshooting](#troubleshooting)

---

## Guided Setup (Automated)

Instead of following the manual steps below, you can use the automated setup process in the [`setup/`](./setup/) directory. Both methods provision all Azure resources, configure Entra ID, deploy the connector, initialize the Graph connection, start the first crawl, and open the admin dashboard.

| Method | Command | Best for |
|--------|---------|----------|
| **PowerShell Script** | `.\setup\setup.ps1` | CI/CD pipelines, scripted deployments, headless environments |
| **Browser GUI Wizard** | `node setup/setup-gui.js` | Interactive setup with visual feedback and form-based configuration |

**Deployment targets:** Both methods support three deployment targets: **Flex Consumption** (serverless, recommended), **Azure Functions on App Service Plan** (Premium/Dedicated), or **Azure Functions on Container Apps**. Set `DEPLOY_TARGET` in your `.env` or select from the GUI dropdown.

**Quick start:**

```bash
# Easiest: double-click the launcher (checks & installs prerequisites automatically)
setup\install.bat

# Or run the launcher in PowerShell
.\setup\install.ps1

# Or skip the launcher and run setup directly (prerequisites must be installed)
.\setup\setup.ps1                  # PowerShell script
node setup/setup-gui.js            # Browser GUI wizard
```

See the [setup/README.md](./setup/README.md) for full instructions.

---

## Prerequisites

### Required Accounts and Access

| Requirement | Details |
|-------------|---------|
| **Azure Subscription** | Active Azure subscription with permissions to create resources |
| **Microsoft 365 Tenant** | M365 tenant with Copilot licenses for end users |
| **Entra ID Admin** | Cloud Application Administrator or Global Administrator role |
| **Veeva Vault Account** | Vault user account with API access (VaultActions_API_Access permission) |
| **Veeva Vault Admin** | Admin access to configure API users, security profiles, and Direct Data API |

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | 20.x or later | Runtime for Azure Functions |
| **npm** | 10.x or later | Package management |
| **TypeScript** | 5.5+ | Compilation |
| **Azure Functions Core Tools** | 4.x | Local development and deployment |
| **Azure CLI** | 2.x | Azure resource management |
| **M365 Agents Toolkit (Teams Toolkit)** | Latest | Agent deployment (VS Code extension or CLI) |

### Install Prerequisites

```bash
# Install Node.js 20+ (via nvm or direct download)
# https://nodejs.org/

# Install Azure Functions Core Tools
npm install -g azure-functions-core-tools@4

# Install Azure CLI
# https://learn.microsoft.com/cli/azure/install-azure-cli

# Login to Azure
az login

# Login to M365
# Install Teams Toolkit VS Code extension or use CLI
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Azure Subscription                           │
│                                                                     │
│  ┌─────────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │  Azure Functions │   │  Azure Storage   │   │  Application    │  │
│  │  (Premium Plan)  │   │  Account         │   │  Insights       │  │
│  │                  │   │                  │   │                 │  │
│  │  • fullCrawl     │   │  • Table Storage │   │  • Logs         │  │
│  │  • incremental   │──►│    (Crawl State)  │   │  • Metrics      │  │
│  │  • deploy        │   │  • Blob Storage  │   │  • Alerts       │  │
│  │  • status        │   │    (Function App)│   │                 │  │
│  │  • admin         │   │                  │   │                 │  │
│  └────────┬─────────┘   └──────────────────┘   └─────────────────┘  │
│           │                                                         │
└───────────┼─────────────────────────────────────────────────────────┘
            │
     ┌──────┴──────┐
     │             │
     ▼             ▼
┌─────────┐  ┌──────────┐
│  Veeva  │  │ Microsoft│
│  Vault  │  │  Graph   │
│         │  │          │
│  REST   │  │ External │
│  API    │  │ Items    │
│  Direct │  │ ACLs     │
│  Data   │  │ Schema   │
│  API    │  │ Groups   │
└─────────┘  └──────────┘
```

---

## Step 1: Provision Azure Resources

### 1a. Create a Resource Group

```bash
az group create \
  --name rg-veeva-connector \
  --location eastus
```

### 1b. Create a Storage Account

Azure Table Storage is required for crawl state persistence, progress tracking, and checkpoint management.

```bash
az storage account create \
  --name stveevacrawlstate \
  --resource-group rg-veeva-connector \
  --location eastus \
  --sku Standard_LRS \
  --kind StorageV2
```

> **Note:** The connector automatically creates the required table (`VeevaConnectorCrawlState{AppName}`) on first run. No manual table creation is needed.

### 1c. Create an Azure Functions App

**⚠️ Critical: Use a Premium or Dedicated (App Service) Plan — NOT Consumption.**

The connector requires **unlimited function execution time** for initial full crawls that may run for 24+ hours on large Vaults. The Consumption plan has a 10-minute maximum timeout and cannot be extended.

```bash
# Create an App Service Plan (Premium Elastic)
az functionapp plan create \
  --name plan-veeva-connector \
  --resource-group rg-veeva-connector \
  --location eastus \
  --sku EP1 \
  --is-linux true

# Create the Function App
az functionapp create \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --plan plan-veeva-connector \
  --storage-account stveevacrawlstate \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --os-type Linux
```

### 1d. Create Application Insights (Optional but Recommended)

```bash
az monitor app-insights component create \
  --app ai-veeva-connector \
  --location eastus \
  --resource-group rg-veeva-connector \
  --application-type web

# Link to Function App
az functionapp config appsettings set \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --settings APPLICATIONINSIGHTS_CONNECTION_STRING="<connection-string>"
```

---

## Step 2: Register the Entra ID Application

The connector requires an Entra ID app registration to authenticate with Microsoft Graph.

### 2a. Create the App Registration

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com).
2. Navigate to **Identity > Applications > App registrations**.
3. Click **+ New registration**.
4. Enter:
   - **Name:** `Veeva Vault Copilot Connector`
   - **Supported account types:** Accounts in this organizational directory only (Single tenant)
   - **Redirect URI:** Leave blank (not needed for client credentials flow)
5. Click **Register**.
6. Note the **Application (client) ID** and **Directory (tenant) ID**.

### 2b. Create a Client Secret

1. In the app registration, go to **Certificates & secrets**.
2. Click **+ New client secret**.
3. Enter a description: `Veeva Connector Secret`
4. Set expiration (recommended: 12 or 24 months — set a calendar reminder to rotate).
5. Click **Add**.
6. **Copy the secret value immediately** — it cannot be retrieved later.

### 2c. Grant Microsoft Graph Permissions

1. In the app registration, go to **API permissions**.
2. Click **+ Add a permission > Microsoft Graph > Application permissions**.
3. Add the following permissions:

   | Permission | Purpose |
   |-----------|---------|
   | `ExternalConnection.ReadWrite.OwnedBy` | Create and manage the connector's own external connections |
   | `ExternalItem.ReadWrite.OwnedBy` | Create, update, and delete external items in owned connections |
   | `ExternalConnection.Read.All` | Read external connection configurations |
   | `Directory.Read.All` | Resolve Vault users to Entra ID identities for ACL mapping |
   | `Group.Read.All` | Resolve Vault groups to Entra ID groups for ACL mapping |
   | `User.Read.All` | Look up users by email/UPN for ACL mapping |

4. Click **Grant admin consent for [your tenant]**.
5. Verify all permissions show ✅ **Granted** status.

> **Security Note:** The `*.OwnedBy` permissions are scoped to only the connections this app creates. The `Directory.Read.All`, `Group.Read.All`, and `User.Read.All` permissions are needed for ACL mapping to resolve Vault users/groups to Entra ID identities. If your organization has security concerns about these broad read permissions, you can restrict using Entra ID application access policies.

---

## Step 3: Configure Veeva Vault API Access

### 3a. Create a Dedicated API User

Best practice is to create a dedicated Vault user for the connector, rather than using a personal account.

1. In Vault, navigate to **Admin > Users & Groups > Users**.
2. Click **Create**.
3. Set up the user:
   - **User Name:** `api-copilot-connector@yourdomain.com`
   - **Security Profile:** Assign a profile with:
     - **API Access** permission (VaultActions_API_Access)
     - **Read** access to all document types, objects, and lifecycles you want to index
     - **View** access to document content (for downloading renditions)
   - **License Type:** Full API user or appropriate license
4. Save the user and set a strong password.

### 3b. Verify Direct Data API Access

The connector primarily uses the Direct Data API for crawling. Verify it is enabled:

1. Log in to Vault as an Admin.
2. Navigate to **Admin > Settings > General Settings**.
3. Ensure **Direct Data API** is enabled for your Vault.
4. The API user must have appropriate permissions to extract data.

### 3c. Verify API Connectivity

Test from your deployment environment:

```bash
# Test authentication
curl -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=api-copilot-connector@yourdomain.com&password=YOUR_PASSWORD" \
  "https://your-vault.veevavault.com/api/v25.3/auth"

# Expected response: { "responseStatus": "SUCCESS", "sessionId": "...", ... }
```

### 3d. Vault API Permissions Matrix

The connector uses these Vault APIs and requires corresponding permissions:

| API Endpoint | Permission Required | Purpose |
|-------------|-------------------|---------|
| `POST /api/{v}/auth` | All users | Authentication (session ID) |
| `POST /api/{v}/services/directdata/files` | Direct Data API access | Full and incremental crawl data extraction |
| `GET /api/{v}/objects/documents/{id}/roles` | Document read access | Document ACL retrieval |
| `GET /api/{v}/vobjects/{type}/{id}/roles` | Object read access | Object ACL retrieval |
| `GET /api/{v}/configuration/lifecycle.{name}` | Metadata read access | Lifecycle permission matrix |
| `POST /api/{v}/query` (VQL) | Query access | User/group lookups, audit trail queries |

---

## Step 4: Clone and Build the Connector

### 4a. Clone the Repository

```bash
git clone https://github.com/your-org/veeva-vault-connector.git
cd veeva-vault-connector
```

### 4b. Install Dependencies

```bash
npm install
```

### 4c. Build the Project

```bash
npm run build
```

This compiles TypeScript to the `dist/` directory.

### 4d. Run Tests

```bash
npm test
```

Expected: 7 test suites, 55 tests passing.

---

## Step 5: Configure Environment Variables

### For Local Development

Create a `local.settings.json` file in the project root:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",

    "VEEVA_VAULT_DNS": "your-vault.veevavault.com",
    "VEEVA_USERNAME": "api-copilot-connector@yourdomain.com",
    "SECRET_VEEVA_PASSWORD": "your-vault-password",

    "AZURE_CLIENT_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "SECRET_AZURE_CLIENT_SECRET": "your-client-secret",
    "AZURE_TENANT_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",

    "VAULT_APPLICATION": "promomats",
    "GRAPH_API_VERSION": "v1.0",

    "FULL_CRAWL_DAYS": "0,6",
    "PROGRESS_BATCH_SIZE": "500"
  }
}
```

> **Note:** Use the [Azure Storage Emulator (Azurite)](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) for local development with `UseDevelopmentStorage=true`.

### For Azure Deployment

Set application settings on the Function App:

```bash
az functionapp config appsettings set \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --settings \
    VEEVA_VAULT_DNS="your-vault.veevavault.com" \
    VEEVA_USERNAME="api-copilot-connector@yourdomain.com" \
    VAULT_APPLICATION="promomats" \
    GRAPH_API_VERSION="v1.0" \
    AZURE_TENANT_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
    AZURE_CLIENT_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
    FULL_CRAWL_DAYS="0,6" \
    PROGRESS_BATCH_SIZE="500"
```

**Store secrets in Azure Key Vault** (recommended for production):

```bash
# Create Key Vault
az keyvault create \
  --name kv-veeva-connector \
  --resource-group rg-veeva-connector \
  --location eastus

# Store secrets
az keyvault secret set --vault-name kv-veeva-connector --name VeevaPassword --value "your-password"
az keyvault secret set --vault-name kv-veeva-connector --name AzureClientSecret --value "your-secret"

# Reference from Function App settings
az functionapp config appsettings set \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --settings \
    SECRET_VEEVA_PASSWORD="@Microsoft.KeyVault(VaultName=kv-veeva-connector;SecretName=VeevaPassword)" \
    SECRET_AZURE_CLIENT_SECRET="@Microsoft.KeyVault(VaultName=kv-veeva-connector;SecretName=AzureClientSecret)"
```

> **Important:** Enable the Function App's system-assigned managed identity and grant it **Get** permission on Key Vault secrets.

---

## Step 6: Deploy to Azure

### Option A: Deploy via Azure Functions Core Tools

```bash
# Build first
npm run build

# Deploy
func azure functionapp publish func-veeva-promomats
```

### Option B: Deploy via Azure CLI (Zip Deploy)

```bash
npm run build
cd dist && zip -r ../deploy.zip . && cd ..
az functionapp deployment source config-zip \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --src deploy.zip
```

### Option C: Deploy via CI/CD (GitHub Actions)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Veeva Connector
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: npm test
      - uses: Azure/functions-action@v1
        with:
          app-name: func-veeva-promomats
          package: .
          publish-profile: ${{ secrets.AZURE_FUNCTIONAPP_PUBLISH_PROFILE }}
```

---

## Step 7: Initialize the Connection

After deployment, you need to create the Microsoft Graph external connection and register the schema.

### 7a. Deploy the Connection (Automatic)

The `deployConnection` function runs automatically on its timer schedule (default: daily at 1 AM) and also via HTTP trigger. To initialize immediately:

```bash
# Trigger via HTTP
curl -X POST "https://func-veeva-promomats.azurewebsites.net/api/deployConnection?code=<function-key>"
```

This will:
1. Create the external connection in Microsoft Graph (`veevaPromoMats`)
2. Configure the URL resolver for deep-linking into Vault
3. Register the schema (47 base properties + app-specific extensions)

> **Note:** Schema registration can take 5–15 minutes. The function polls until the schema is ready.

> **Beta API:** If `GRAPH_API_VERSION=beta`, the connection is additionally configured with `enabledContentExperiences` and the schema includes `rankingHint` importance scores for enhanced Copilot relevance. Switching between v1.0 and Beta requires redeploying the connection and re-registering the schema.

### 7b. Trigger the First Full Crawl

```bash
curl -X POST "https://func-veeva-promomats.azurewebsites.net/api/fullCrawl?code=<function-key>"
```

> **⚠️ Important:** The first full crawl can take hours or days depending on Vault size. See [Production Recommendations](#production-recommendations) for guidance on monitoring.

### 7c. Monitor Progress

```bash
# Check status with progress details
curl "https://func-veeva-promomats.azurewebsites.net/api/status?code=<function-key>"
```

Or open the admin dashboard:
```
https://func-veeva-promomats.azurewebsites.net/api/admin
```

The admin dashboard shows:
- Current crawl phase and progress percentage
- Items processed / total items
- Processing rate (items per minute)
- Estimated time to completion
- Last heartbeat (confirms the crawl is still running)
- Schedule configuration

---

## Step 8: Verify the Deployment

### 8a. Check Connection in Microsoft 365 Admin Center

1. Go to [admin.microsoft.com](https://admin.microsoft.com).
2. Navigate to **Settings > Search & intelligence > Data sources**.
3. Verify the connection (e.g., `veevaPromoMats`) appears with status **Ready**.

### 8b. Verify Content in Copilot

1. Open Microsoft 365 Copilot (in Teams, Bing, or Microsoft365.com).
2. Ask a question about Vault content: *"Find documents in PromoMats about diabetes"*
3. Results should include Vault documents with titles, statuses, and direct Vault links.

### 8c. Verify Permissions

1. Ask for a document that the test user should **not** have access to.
2. Verify it does not appear in results.
3. Ask for a document the test user **should** have access to.
4. Verify it appears with correct metadata.

---

## Step 9: Deploy the M365 Copilot Agents

The connector includes declarative agents for each Vault application. Deploy them via the M365 Agents Toolkit:

### Using VS Code (Teams Toolkit Extension)

1. Open the project in VS Code with the Teams Toolkit extension installed.
2. Sign in to your M365 tenant via the Teams Toolkit sidebar.
3. Click **Provision** to register the Teams app and agents.
4. Click **Deploy** to publish.

### Using CLI

```bash
# Install Teams Toolkit CLI
npm install -g @microsoft/teamsapp-cli

# Provision and deploy
teamsapp provision
teamsapp deploy
```

### Verify Agent Availability

1. Open Microsoft 365 Copilot.
2. Look for the **Veeva PromoMats**, **Veeva QualityDocs**, or **Veeva RIM** agents in the agent picker.
3. Select an agent and test with a domain-specific query.

---

## Multi-Application Deployment

To index multiple Vault applications (e.g., PromoMats AND QualityDocs AND RIM), deploy separate Function App instances from the **same codebase**, each configured for a different application:

```
Function App 1: VAULT_APPLICATION=promomats   → Connection: veevaPromoMats
Function App 2: VAULT_APPLICATION=qualitydocs  → Connection: veevaQualityDocs
Function App 3: VAULT_APPLICATION=rim          → Connection: veevaRIM
```

All three can share:
- The same Azure Storage Account (each uses its own table)
- The same Entra ID app registration
- The same App Service Plan (to share compute resources)
- The same Application Insights instance

```bash
# Create additional Function Apps on the same plan
az functionapp create \
  --name func-veeva-qualitydocs \
  --resource-group rg-veeva-connector \
  --plan plan-veeva-connector \
  --storage-account stveevacrawlstate \
  --runtime node --runtime-version 20 --functions-version 4 --os-type Linux

az functionapp create \
  --name func-veeva-rim \
  --resource-group rg-veeva-connector \
  --plan plan-veeva-connector \
  --storage-account stveevacrawlstate \
  --runtime node --runtime-version 20 --functions-version 4 --os-type Linux

# Set VAULT_APPLICATION for each
az functionapp config appsettings set --name func-veeva-qualitydocs --resource-group rg-veeva-connector \
  --settings VAULT_APPLICATION="qualitydocs"
az functionapp config appsettings set --name func-veeva-rim --resource-group rg-veeva-connector \
  --settings VAULT_APPLICATION="rim"
```

> **Tip:** If all three apps connect to the same Vault domain, they can share the same Veeva credentials. If they connect to different Vaults, configure separate `VEEVA_VAULT_DNS`, `VEEVA_USERNAME`, and `SECRET_VEEVA_PASSWORD` for each.

---

## Cross-Tenant Deployment

In some organizations, the Azure subscription used for hosting infrastructure is in a **different Entra ID tenant** than the Microsoft 365 tenant where search results should appear. For example:

- **Tenant A** (Hosting): Azure subscription where the Function App runs
- **Tenant B** (M365): The Microsoft 365 tenant where users search via Copilot

The connector fully supports this scenario — no code changes are required. The `ClientSecretCredential` authenticates to whichever tenant you specify in `AZURE_TENANT_ID`.

### How It Works

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│  Tenant A (Azure Hosting)    │      │  Tenant B (Microsoft 365)    │
│                              │      │                              │
│  ┌────────────────────────┐  │      │  ┌────────────────────────┐  │
│  │ Azure Function App     │──┼──────┼──│ Entra ID App Reg       │  │
│  │ (runs the connector)   │  │      │  │ (client ID + secret)   │  │
│  └────────────────────────┘  │      │  └────────────────────────┘  │
│                              │      │          │                   │
│  ┌────────────────────────┐  │      │  ┌───────▼────────────────┐  │
│  │ Storage Account        │  │      │  │ Microsoft Graph API    │  │
│  │ Key Vault              │  │      │  │ External Connections   │  │
│  └────────────────────────┘  │      │  └────────────────────────┘  │
└──────────────────────────────┘      └──────────────────────────────┘
```

### Prerequisites

1. **Tenant B**: Create the Entra ID app registration manually (see [Step 2](#step-2-register-the-entra-id-application))
2. **Tenant B**: Grant the app the required Graph API permissions and admin consent
3. **Tenant A**: Have an Azure subscription with sufficient permissions to create resources
4. Record the **Client ID**, **Client Secret**, and **Tenant ID** from the Tenant B app registration

### Configuration

In your `.env` file:

```bash
# Tenant B — your M365 tenant (where Graph connections and search results live)
AZURE_TENANT_ID=<tenant-b-id>
AZURE_CLIENT_ID=<app-reg-client-id-from-tenant-b>
SECRET_AZURE_CLIENT_SECRET=<app-reg-secret-from-tenant-b>

# Tenant A — your Azure hosting tenant (where the Function App runs)
AZURE_HOSTING_TENANT_ID=<tenant-a-id>
AZURE_SUBSCRIPTION_ID=<subscription-in-tenant-a>
```

### Automated Setup

The guided setup script (`setup/install.bat`) handles cross-tenant automatically:

1. Detects `AZURE_HOSTING_TENANT_ID` is set
2. Validates that `AZURE_CLIENT_ID` and `SECRET_AZURE_CLIENT_SECRET` are provided (app auto-creation is disabled in cross-tenant mode — the app must exist in Tenant B)
3. Logs you into **Tenant A** for infrastructure deployment
4. Configures the Function App with **Tenant B** credentials for Graph API access

### Important Notes

- **App registration must be pre-created** in Tenant B. The setup script cannot create apps across tenants.
- **Admin consent** must be granted in Tenant B before the connector can access the Graph API.
- **Key Vault** (if enabled) is created in Tenant A. The managed identity used for Key Vault access is separate from the Graph API service principal.
- **ACLs** use `AZURE_TENANT_ID` (Tenant B) for the `everyoneExceptGuests` access control — ensuring only Tenant B users can see search results.

---

## Azure Hosting Options

The connector is built as an Azure Functions v4 application but can be hosted on several Azure compute platforms. The key constraint is **long-running execution support** — full crawls of large Vaults (10M+ documents) can run for 24 hours or more.

### Option 1: Azure Functions — Premium Plan (Recommended)

| Feature | Detail |
|---------|--------|
| **Plan SKU** | Elastic Premium (EP1, EP2, EP3) |
| **Function Timeout** | Unlimited (`functionTimeout: "-1"` in host.json) |
| **Auto-scaling** | Yes — scales based on event load |
| **Always Ready** | Configurable pre-warmed instances |
| **VNet Integration** | Supported (for Vault behind firewall) |
| **Cost Model** | Per-second billing + pre-warmed instance cost |

**Why Premium Plan:**
- The `functionTimeout: "-1"` setting (unlimited) is **only available on Premium and Dedicated plans**. The Consumption plan has a hard 10-minute limit that cannot be overridden.
- Full crawls of enterprise Vaults can process millions of documents over 24+ hours. The Consumption plan would kill the function after 10 minutes, leaving the crawl incomplete.
- Premium provides pre-warmed instances, so timer-triggered incremental crawls start instantly without cold-start delays.
- Elastic scaling handles spikes in concurrent Graph API calls during high-throughput crawls.

**Recommended SKU for Vault size:**
| Vault Size | SKU | Rationale |
|-----------|-----|-----------|
| < 100K documents | EP1 (1 vCPU, 3.5 GB RAM) | Sufficient for most Vaults; full crawl completes in hours |
| 100K–1M documents | EP2 (2 vCPU, 7 GB RAM) | Higher throughput for parallel Graph API calls |
| 1M–10M+ documents | EP3 (4 vCPU, 14 GB RAM) | Maximum throughput for enterprise-scale crawls |

```bash
# Example: Create Premium plan
az functionapp plan create \
  --name plan-veeva-connector \
  --resource-group rg-veeva-connector \
  --location eastus \
  --sku EP2 \
  --is-linux true \
  --min-instances 1 \
  --max-burst 3
```

### Option 2: Azure Functions — Flex Consumption (Serverless)

| Feature | Detail |
|---------|--------|
| **Plan** | Flex Consumption (serverless, no App Service Plan) |
| **Function Timeout** | Unlimited (`functionTimeout: "-1"`) |
| **Auto-scaling** | Event-driven, scales to zero when idle, up to 1000 instances |
| **Cost Model** | Pay-per-use (execution time + optional always-ready instances) |
| **OS** | Linux only |
| **Automated Setup** | ✅ Set `DEPLOY_TARGET=flex-consumption` |

**When to use Flex Consumption:**
- You want the lowest cost option — pay only when code is running
- You want serverless auto-scaling with unlimited timeout
- You don't need a dedicated App Service Plan
- Your workload is bursty (e.g., periodic crawls with long idle periods)

> **Note:** Flex Consumption is Linux-only, code-only (no custom containers), and is available in [supported regions](https://learn.microsoft.com/azure/azure-functions/flex-consumption-how-to#view-currently-supported-regions).

```bash
# Example: Create Flex Consumption function app
az functionapp create \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --storage-account stveevacrawlstate \
  --flexconsumption-location eastus \
  --runtime node --runtime-version 20
```

### Option 3: Azure Functions — Premium or Dedicated (App Service Plan)

| Feature | Detail |
|---------|--------|
| **Plan SKU** | EP1/EP2/EP3 (Premium), P1v3/P2v3/P3v3 (Dedicated) |
| **Function Timeout** | Unlimited (`functionTimeout: "-1"`) |
| **Auto-scaling** | Premium: elastic auto-scale; Dedicated: manual/rule-based |
| **VNet Integration** | Supported |
| **Cost Model** | Fixed monthly cost for the App Service Plan |
| **Automated Setup** | ✅ Set `DEPLOY_TARGET=azure-functions` |

**When to use Premium/Dedicated instead of Flex:**
- You need VNet integration or private endpoints
- You already have an App Service Plan with spare capacity
- You prefer always-warm instances (no cold start latency)
- You need predictable monthly costs

```bash
# Example: Create Premium plan
az appservice plan create \
  --name plan-veeva-connector \
  --resource-group rg-veeva-connector \
  --location eastus \
  --sku EP1 \
  --is-linux true

az functionapp create \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --plan plan-veeva-connector \
  --storage-account stveevacrawlstate \
  --runtime node --runtime-version 20 --functions-version 4 --os-type Linux
```

### Option 4: Azure Container Apps

| Feature | Detail |
|---------|--------|
| **Execution** | Azure Functions hosted on Container Apps infrastructure |
| **Timeout** | Unlimited (same Azure Functions runtime) |
| **Scaling** | KEDA-based auto-scaling (event-driven) |
| **VNet Integration** | Supported |
| **Cost Model** | Per-second billing based on vCPU/memory consumption |
| **Automated Setup** | ✅ Fully supported by `setup.ps1` and GUI wizard |

**When to use Container Apps:**
- Your organization standardizes on container-based deployments
- You want per-second billing with consumption-based scaling
- You want to run multiple connectors in a shared Container Apps Environment
- You need fine-grained control over CPU/memory allocation

**Automated deployment** — set `DEPLOY_TARGET=container-app` in your `.env` file or select "Azure Functions on Container Apps" in the GUI wizard. The setup script handles everything: ACR creation, Container Apps Environment, image build/push, and function app configuration.

**Manual deployment:**

```bash
# 1. Create Azure Container Registry
az acr create \
  --name crveeva \
  --resource-group rg-veeva-connector \
  --location eastus \
  --sku Basic \
  --admin-enabled true

# 2. Create Container Apps Environment
az containerapp env create \
  --name cae-veeva-connector \
  --resource-group rg-veeva-connector \
  --location eastus

# 3. Create Function App on Container Apps
az functionapp create \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --storage-account stveevacrawlstate \
  --environment cae-veeva-connector \
  --runtime node --runtime-version 20 --functions-version 4 \
  --workload-profile-name Consumption \
  --cpu 1.0 --memory 2.0Gi

# 4. Build and push container image via ACR
az acr build \
  --registry crveeva \
  --resource-group rg-veeva-connector \
  --image func-veeva-promomats:latest \
  --file Dockerfile .

# 5. Configure function app to use ACR image
az functionapp config container set \
  --name func-veeva-promomats \
  --resource-group rg-veeva-connector \
  --image crveeva.azurecr.io/func-veeva-promomats:latest \
  --registry-server crveeva.azurecr.io \
  --registry-username <acr-username> \
  --registry-password <acr-password>
```

> **Note:** The project includes a `Dockerfile` optimized for Azure Functions on Container Apps. Timer triggers and HTTP triggers work identically to the App Service Plan deployment — no code changes are required.

### Option 5: Azure App Service (Without Azure Functions)

If you prefer to run the connector as a standalone web application rather than Azure Functions, you would need to implement your own scheduling (e.g., using `node-cron` or Azure Logic Apps for triggers). This is **not recommended** unless you have specific requirements that prevent using Azure Functions.

### Hosting Comparison Summary

| Feature | Flex Consumption | Functions Premium | Functions Dedicated | Container Apps |
|---------|-----------------|------------------|--------------------|----|
| **Unlimited Timeout** | ✅ | ✅ | ✅ | ✅ |
| **Timer Triggers** | ✅ Built-in | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **Auto-scaling** | ✅ Event-driven | ✅ Elastic | ⚠️ Manual rules | ✅ KEDA-based |
| **Scale to Zero** | ✅ | ❌ (pre-warmed) | ❌ (always running) | ✅ |
| **Cold Start** | ~3-5s | ~1s (pre-warmed) | None (always running) | ~3-5s |
| **Setup Complexity** | Low | Low | Low | Low (automated) |
| **Cost (low usage)** | $ (near-free when idle) | $$ | $$$ (fixed) | $ |
| **Cost (high usage)** | $$ | $$$ | $$$ (fixed) | $$ |
| **Container Support** | ❌ | ✅ Linux | ✅ Linux | ✅ |
| **VNet Integration** | ✅ | ✅ | ✅ | ✅ |
| **Automated Setup** | ✅ | ✅ | ✅ | ✅ |
| **Recommended** | ✅ **Best for most** | ✅ Low-latency | ✅ Predictable cost | ✅ Container orgs |

---

## Production Recommendations

### Crawl Duration Planning

The single most important factor in planning your deployment is **expected crawl duration**. Use this table to estimate:

| Vault Size | Estimated Full Crawl | Estimated Incremental | Recommended Plan |
|-----------|---------------------|----------------------|------------------|
| 10,000 documents | 30–60 minutes | < 1 minute | Flex Consumption / EP1 |
| 100,000 documents | 4–8 hours | 1–5 minutes | Flex Consumption / EP1 |
| 500,000 documents | 12–24 hours | 5–15 minutes | EP2 / P1v3 |
| 1,000,000 documents | 24–48 hours | 10–30 minutes | EP2 / P2v3 |
| 5,000,000+ documents | 3–7 days | 30–60 minutes | EP3 / P3v3 |
| 10,000,000+ documents | 7–14 days | 1–2 hours | EP3 / P3v3 |

> **Why full crawls take so long:** Each document requires downloading content via the Direct Data API, resolving ACLs via the Vault REST API (document roles, lifecycle permissions, group memberships), mapping ACLs to Entra ID identities via Microsoft Graph, and upserting the item into Microsoft Graph with a 4 MB size limit. The Microsoft Graph External Items API has a recommended concurrency limit of 4–8 simultaneous calls per connection (hard limit: 25), which creates a natural throughput ceiling.

### Scheduling Best Practices

| Recommendation | Configuration |
|---------------|---------------|
| **Full crawls on weekends only** | `FULL_CRAWL_DAYS=0,6` (Sunday + Saturday) |
| **Incremental crawls every 15 minutes** | `INCREMENTAL_CRAWL_SCHEDULE=0 */15 * * * *` |
| **Full crawl at off-peak hours** | `FULL_CRAWL_SCHEDULE=0 0 2 * * *` (2 AM) |
| **Monitor via admin dashboard** | Access at `/api/admin` (anonymous auth) |

### Security Best Practices

| Recommendation | Details |
|---------------|---------|
| **Store secrets in Key Vault** | Use `@Microsoft.KeyVault()` references in app settings |
| **Use Managed Identity** | Enable system-assigned managed identity for Key Vault and Storage access |
| **Rotate Vault API credentials** | Set a calendar reminder to rotate the Vault API user password periodically |
| **Rotate Entra ID client secret** | Client secrets expire — rotate before expiration |
| **Restrict admin dashboard** | The admin dashboard endpoint uses anonymous auth for simplicity. Consider adding authentication via Azure Functions proxies or API Management if exposed publicly. |
| **Network restrictions** | Use VNet integration if your Vault is behind a corporate firewall or VPN |
| **Minimum privilege** | The Vault API user should have **read-only** access — it never writes to Vault |

### Monitoring and Alerting

Set up Application Insights alerts for:

| Alert | Condition | Action |
|-------|-----------|--------|
| **Crawl failure** | Custom event: crawl status = "failed" | Email notification to admin team |
| **Stale heartbeat** | No heartbeat update for > 1 hour during running crawl | Investigate — crawl may be stuck |
| **High error rate** | > 5% of Graph API calls failing | Check Graph throttling or permissions |
| **Function timeout** | Function execution exceeds expected duration significantly | Check Vault API responsiveness |

### Backup and Recovery

- **Crawl state** is stored in Azure Table Storage with optimistic concurrency. If the table is lost, the connector will simply re-run a full crawl from scratch.
- **Resume from checkpoint:** If a full crawl is interrupted (function restart, deployment, etc.), it resumes from the last checkpoint index. No data is lost.
- **Stale lock detection:** If a crawl process crashes, the 6-hour stale lock breaker automatically allows the next scheduled crawl to proceed.

---

## Environment Variable Reference

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `VEEVA_VAULT_DNS` | Veeva Vault hostname | `promo-vee.veevavault.com` |
| `VEEVA_USERNAME` | Vault API user username | `api-connector@yourdomain.com` |
| `SECRET_VEEVA_PASSWORD` | Vault API user password | (stored in Key Vault) |
| `AZURE_CLIENT_ID` | Entra ID app registration client ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `SECRET_AZURE_CLIENT_SECRET` | Entra ID client secret | (stored in Key Vault) |
| `AZURE_TENANT_ID` | Entra ID tenant ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VAULT_APPLICATION` | Which Veeva app to index | `promomats` |
| `VEEVA_API_VERSION` | Veeva API version | `v25.3` |
| `CRAWL_BATCH_SIZE` | Items per processing batch | `25` |
| `PROGRESS_BATCH_SIZE` | Items per progress checkpoint/heartbeat | `500` |
| `AUTO_DISCOVER_OBJECTS` | Auto-discover custom Vault objects | `true` |
| `FULL_CRAWL_DAYS` | Days of week for full crawls (0=Sun–6=Sat) | `0,6` |
| `FULL_CRAWL_SCHEDULE` | CRON schedule for full crawl timer | `0 0 2 * * *` |
| `INCREMENTAL_CRAWL_SCHEDULE` | CRON schedule for incremental crawl | `0 */15 * * * *` |
| `DEPLOY_CONNECTION_SCHEDULE` | CRON schedule for connection check | `0 0 1 * * *` |
| `CONNECTOR_ID` | Override connector ID | (from app profile) |
| `CONNECTOR_NAME` | Override connector name | (from app profile) |
| `CONNECTOR_DESCRIPTION` | Override connector description | (from app profile) |
| `AzureWebJobsStorage` | Azure Storage connection string | `UseDevelopmentStorage=true` |
| `GRAPH_API_VERSION` | Microsoft Graph API version (`v1.0` or `beta`) | `v1.0` |
| `DEPLOY_TARGET` | Deployment target (`flex-consumption`, `azure-functions`, or `container-app`) | `flex-consumption` |
| `AZURE_CONTAINER_REGISTRY` | ACR name (for container-app target) | Auto-derived |
| `AZURE_CONTAINER_APP_ENV` | Container Apps Environment name | `cae-veeva-connector` |
| `CONTAINER_CPU` | Container CPU allocation | `1.0` |
| `CONTAINER_MEMORY` | Container memory allocation | `2.0Gi` |
| `AZURE_HOSTING_TENANT_ID` | Hosting tenant ID (cross-tenant only) | (blank for single-tenant) |
| `CRAWL_STATE_TABLE` | Azure Table name for crawl state | Auto-generated per app |

---

## Troubleshooting

### Common Issues

| Issue | Cause | Resolution |
|-------|-------|------------|
| **"INSUFFICIENT_ACCESS" from Vault** | API user lacks VaultActions_API_Access permission | Ask Vault Admin to update the user's security profile |
| **Schema registration stuck** | Graph API schema provisioning can take 15+ minutes | Wait and retry. Check status with `GET /external/connections/{id}/schema` |
| **Crawl processes no items** | Direct Data API returns empty extract | Verify Vault has documents and the API user has read access |
| **ACLs show "everyoneExceptGuests"** | Vault user Federated IDs not configured | Configure SSO and populate Federated IDs. See [SingleSignOn-Setup.md](./SingleSignOn-Setup.md) |
| **Function timeout on Consumption plan** | 10-minute limit exceeded | Upgrade to Premium or Dedicated plan (required for this connector) |
| **"409 Conflict" on crawl start** | Another crawl is already running | Wait for it to finish, or if stuck for >6h, the stale lock breaker will clear it |
| **Admin dashboard returns 404** | Function not deployed or route not configured | Verify the `admin` function is deployed: check `/api/admin` |
| **Graph API 429 (Throttled)** | Too many concurrent requests | The connector's ConcurrencyLimiter (max 8) should prevent this. If it occurs, reduce `CRAWL_BATCH_SIZE` |
| **Incremental crawl finds no changes** | No Vault changes in the last 15 minutes | This is normal — incremental crawls are no-ops when there are no changes |
| **Items missing from Copilot results** | Search index not yet updated | Microsoft Graph search index may take 1–4 hours to update after items are ingested |

### Diagnostic Commands

```bash
# Check function app status
az functionapp show --name func-veeva-promomats --resource-group rg-veeva-connector --query "state"

# View function app logs (live)
az functionapp log tail --name func-veeva-promomats --resource-group rg-veeva-connector

# Check connector status
curl "https://func-veeva-promomats.azurewebsites.net/api/status?code=<function-key>"

# View crawl state in Azure Table Storage
az storage entity query \
  --table-name VeevaConnectorCrawlStateProomomats \
  --account-name stveevacrawlstate \
  --filter "PartitionKey eq 'CrawlState'"

# Test Vault connectivity
curl -X POST -d "username=USER&password=PASS" "https://vault.veevavault.com/api/v25.3/auth"
```

### Getting Help

- **Connector Issues:** File an issue on the GitHub repository
- **Veeva Vault API:** [Veeva Developer Portal](https://developer.veevavault.com/docs/)
- **Microsoft Graph Connectors:** [Microsoft Graph Connectors Documentation](https://learn.microsoft.com/graph/connecting-external-content-connectors-overview)
- **Azure Functions:** [Azure Functions Documentation](https://learn.microsoft.com/azure/azure-functions/)
- **SSO Setup:** See [SingleSignOn-Setup.md](./SingleSignOn-Setup.md) for Entra ID ↔ Vault SAML configuration
