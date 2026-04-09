<#
.SYNOPSIS
    Veeva Vault Copilot Connector — Automated Setup Script

.DESCRIPTION
    End-to-end deployment: provisions Azure infrastructure, configures Entra ID,
    deploys the connector, initializes the Graph connection, starts the first
    crawl, and opens the admin dashboard.

    Reads configuration from a .env file. Safe to re-run (idempotent steps).

.PARAMETER EnvFile
    Path to the .env configuration file. Default: setup/.env

.PARAMETER SkipBuild
    Skip npm install and build steps (use if already built).

.PARAMETER SkipAgents
    Skip M365 Copilot agent deployment even if DEPLOY_M365_AGENTS=true.

.EXAMPLE
    .\setup\setup.ps1
    .\setup\setup.ps1 -EnvFile .\my-config.env
#>

[CmdletBinding()]
param(
    [string]$EnvFile = "",
    [switch]$SkipBuild,
    [switch]$SkipAgents
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ─── Helpers ────────────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "  [$Step] $Message" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
}

function Write-Info { param([string]$Msg) Write-Host "  ℹ $Msg" -ForegroundColor Gray }
function Write-Ok { param([string]$Msg) Write-Host "  ✅ $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  ⚠️  $Msg" -ForegroundColor Yellow }
function Write-Err { param([string]$Msg) Write-Host "  ❌ $Msg" -ForegroundColor Red }

function Invoke-AzCmd {
    param([string[]]$Arguments, [switch]$AllowFailure)
    $result = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        $errorMsg = ($result | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
        if (-not $errorMsg) { $errorMsg = $result -join "`n" }
        throw "Azure CLI command failed: az $($Arguments -join ' ')`n$errorMsg"
    }
    $stdout = ($result | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    return $stdout
}

function Invoke-AzJson {
    param([string[]]$Arguments, [switch]$AllowFailure)
    $raw = Invoke-AzCmd -Arguments $Arguments -AllowFailure:$AllowFailure
    if ($raw) {
        try { return $raw | ConvertFrom-Json } catch { return $raw }
    }
    return $null
}

function Test-Command { param([string]$Name) return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

function Read-EnvFile {
    param([string]$Path)
    $vars = @{}
    if (-not (Test-Path $Path)) { return $vars }
    foreach ($line in Get-Content $Path) {
        $line = $line.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -le 0) { continue }
        $key = $line.Substring(0, $eqIdx).Trim()
        $val = $line.Substring($eqIdx + 1).Trim()
        # Strip surrounding quotes
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $vars[$key] = $val
    }
    return $vars
}

function Get-EnvValue {
    param([hashtable]$Env, [string]$Key, [string]$Default = "")
    if ($Env.ContainsKey($Key) -and $Env[$Key] -ne "") { return $Env[$Key] }
    return $Default
}

function Require-EnvValue {
    param([hashtable]$Env, [string]$Key, [string]$Prompt)
    $val = Get-EnvValue -Env $Env -Key $Key
    if ($val -ne "") { return $val }
    $val = Read-Host "  → $Prompt"
    if ($val -eq "") { throw "Required value '$Key' not provided." }
    return $val
}

# ─── Main ───────────────────────────────────────────────────────────────────

$banner = @"

  ╔══════════════════════════════════════════════════════════════╗
  ║   Veeva Vault Copilot Connector — Automated Setup          ║
  ║                                                            ║
  ║   This script will provision Azure resources, deploy the   ║
  ║   connector, and start indexing your Vault content.        ║
  ╚══════════════════════════════════════════════════════════════╝

"@
Write-Host $banner -ForegroundColor Cyan

# ── Resolve project root (script lives in setup/)
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectRoot = Split-Path -Parent $scriptDir
Push-Location $projectRoot

try {

# ─── Step 0: Load .env ──────────────────────────────────────────────────────

Write-Step "0/10" "Loading Configuration"

if ($EnvFile -eq "") {
    # Try setup/.env first, then project root .env
    if (Test-Path (Join-Path $scriptDir ".env")) {
        $EnvFile = Join-Path $scriptDir ".env"
    } elseif (Test-Path (Join-Path $projectRoot ".env")) {
        $EnvFile = Join-Path $projectRoot ".env"
    } else {
        $EnvFile = Join-Path $scriptDir ".env"
    }
}

$envVars = @{}
if (Test-Path $EnvFile) {
    Write-Info "Reading configuration from: $EnvFile"
    $envVars = Read-EnvFile -Path $EnvFile
    Write-Ok "Loaded $($envVars.Count) variables from .env file"
} else {
    Write-Warn "No .env file found at $EnvFile — will prompt for all values"
}

# ─── Gather required values ─────────────────────────────────────────────────

$vaultApp       = Get-EnvValue $envVars "VAULT_APPLICATION" "promomats"
$vaultAppClean  = $vaultApp.ToLower() -replace '[^a-z0-9]', ''
$azLocation     = Get-EnvValue $envVars "AZURE_LOCATION" "eastus"
$azPlanSku      = Get-EnvValue $envVars "AZURE_PLAN_SKU" "EP1"
$graphApiVer    = Get-EnvValue $envVars "GRAPH_API_VERSION" "v1.0"
$useKeyVault    = (Get-EnvValue $envVars "USE_KEY_VAULT" "true") -eq "true"
$deployAgents   = (Get-EnvValue $envVars "DEPLOY_M365_AGENTS" "false") -eq "true"
$deployTarget   = Get-EnvValue $envVars "DEPLOY_TARGET" "azure-functions"
$isContainerApp = ($deployTarget -eq "container-app")
$isFlexConsumption = ($deployTarget -eq "flex-consumption")

# Auto-derive resource names (user can override via .env)
$azResourceGroup   = Get-EnvValue $envVars "AZURE_RESOURCE_GROUP"   "rg-veeva-connector"
$azStorageAccount  = Get-EnvValue $envVars "AZURE_STORAGE_ACCOUNT"  "stveeva$($vaultAppClean)"
$azAppPlan         = Get-EnvValue $envVars "AZURE_APP_SERVICE_PLAN" "plan-veeva-connector"
$azFuncApp         = Get-EnvValue $envVars "AZURE_FUNCTION_APP"     "func-veeva-$vaultAppClean"
$azAppInsights     = Get-EnvValue $envVars "AZURE_APP_INSIGHTS"     "ai-veeva-connector"
$azKeyVault        = Get-EnvValue $envVars "AZURE_KEY_VAULT"        "kv-veeva-$vaultAppClean"

# Container Apps settings (only used if DEPLOY_TARGET=container-app)
$azContainerRegistry = Get-EnvValue $envVars "AZURE_CONTAINER_REGISTRY" "crveeva$($vaultAppClean)"
$azContainerAppEnv   = Get-EnvValue $envVars "AZURE_CONTAINER_APP_ENV"  "cae-veeva-connector"
$containerCpu        = Get-EnvValue $envVars "CONTAINER_CPU" "1.0"
$containerMemory     = Get-EnvValue $envVars "CONTAINER_MEMORY" "2.0Gi"

# Veeva credentials
$vaultDns      = Require-EnvValue $envVars "VEEVA_VAULT_DNS"       "Enter Veeva Vault hostname (e.g., myco.veevavault.com)"
$vaultUser     = Require-EnvValue $envVars "VEEVA_USERNAME"        "Enter Veeva API username"
$vaultPassword = Require-EnvValue $envVars "SECRET_VEEVA_PASSWORD" "Enter Veeva API password"
$veevaApiVer   = Get-EnvValue $envVars "VEEVA_API_VERSION" "v25.3"

# Entra ID (may be empty = auto-create)
$azTenantId     = Get-EnvValue $envVars "AZURE_TENANT_ID" ""
$azClientId     = Get-EnvValue $envVars "AZURE_CLIENT_ID" ""
$azClientSecret = Get-EnvValue $envVars "SECRET_AZURE_CLIENT_SECRET" ""
$entraAutoCreate = ($azClientId -eq "")

# Optional crawl settings
$fullCrawlDays   = Get-EnvValue $envVars "FULL_CRAWL_DAYS" "0,6"
$crawlBatchSize  = Get-EnvValue $envVars "CRAWL_BATCH_SIZE" "25"
$progressBatch   = Get-EnvValue $envVars "PROGRESS_BATCH_SIZE" "500"
$autoDiscover    = Get-EnvValue $envVars "AUTO_DISCOVER_OBJECTS" "true"
$connectorId     = Get-EnvValue $envVars "CONNECTOR_ID" ""
$connectorName   = Get-EnvValue $envVars "CONNECTOR_NAME" ""
$connectorDesc   = Get-EnvValue $envVars "CONNECTOR_DESCRIPTION" ""

Write-Host ""
Write-Host "  Configuration Summary:" -ForegroundColor White
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Info "Vault Application:   $vaultApp"
Write-Info "Vault DNS:           $vaultDns"
Write-Info "Azure Location:      $azLocation"
Write-Info "Deploy Target:       $deployTarget"
if ($isContainerApp) {
    Write-Info "Container Registry:  $azContainerRegistry"
    Write-Info "Container Env:       $azContainerAppEnv"
    Write-Info "Container CPU/Mem:   $containerCpu / $containerMemory"
} elseif ($isFlexConsumption) {
    Write-Info "Function App:        $azFuncApp"
    Write-Info "Plan:                Flex Consumption (serverless)"
} else {
    Write-Info "Function App:        $azFuncApp"
    Write-Info "Plan SKU:            $azPlanSku"
}
Write-Info "Graph API Version:   $graphApiVer"
Write-Info "Key Vault:           $(if ($useKeyVault) { 'Enabled' } else { 'Disabled' })"
Write-Info "Entra ID App:        $(if ($entraAutoCreate) { 'Will create automatically' } else { 'Using provided: ' + $azClientId })"
Write-Host ""

# ─── Step 1: Prerequisites ──────────────────────────────────────────────────

Write-Step "1/10" "Checking Prerequisites"

$prereqsFailed = $false
$requiredTools = @(
    @{ Name = "az";   Label = "Azure CLI" },
    @{ Name = "node"; Label = "Node.js" },
    @{ Name = "npm";  Label = "npm" }
)
if (-not $isContainerApp) {
    $requiredTools += @{ Name = "func"; Label = "Azure Functions Core Tools" }
}
foreach ($tool in $requiredTools) {
    if (Test-Command $tool.Name) {
        $ver = & $tool.Name --version 2>$null | Select-Object -First 1
        Write-Ok "$($tool.Label): $ver"
    } else {
        Write-Err "$($tool.Label) is not installed. See Setup.md Prerequisites."
        $prereqsFailed = $true
    }
}

if ($prereqsFailed) {
    throw "Missing required tools. Please install them and re-run."
}

# Node version check
$nodeVer = (node --version) -replace 'v', ''
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20+ is required. Found: v$nodeVer"
}
Write-Ok "Node.js version $nodeVer meets minimum (20+)"

# ─── Step 2: Azure Login ────────────────────────────────────────────────────

Write-Step "2/10" "Azure Authentication"

$account = Invoke-AzJson -Arguments @("account", "show") -AllowFailure
if ($null -eq $account -or $LASTEXITCODE -ne 0) {
    Write-Info "Not logged in to Azure. Opening browser for login..."
    Invoke-AzCmd -Arguments @("login")
    $account = Invoke-AzJson -Arguments @("account", "show")
}

Write-Ok "Logged in as: $($account.user.name)"
Write-Info "Subscription: $($account.name) ($($account.id))"

# Set subscription if specified
$azSubId = Get-EnvValue $envVars "AZURE_SUBSCRIPTION_ID" ""
if ($azSubId -ne "") {
    Write-Info "Setting subscription to: $azSubId"
    Invoke-AzCmd -Arguments @("account", "set", "--subscription", $azSubId)
    $account = Invoke-AzJson -Arguments @("account", "show")
    Write-Ok "Active subscription: $($account.name)"
}

# Capture tenant ID from login if not provided
if ($azTenantId -eq "") {
    $azTenantId = $account.tenantId
    Write-Info "Using tenant ID from login: $azTenantId"
}

# ─── Step 3: Provision Azure Resources ──────────────────────────────────────

Write-Step "3/10" "Provisioning Azure Resources"

# 3a. Resource Group
Write-Info "Creating resource group: $azResourceGroup"
$existing = Invoke-AzJson -Arguments @("group", "show", "--name", $azResourceGroup) -AllowFailure
if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
    Write-Ok "Resource group already exists: $azResourceGroup"
} else {
    Invoke-AzCmd -Arguments @("group", "create", "--name", $azResourceGroup, "--location", $azLocation) | Out-Null
    Write-Ok "Created resource group: $azResourceGroup"
}

# 3b. Storage Account
Write-Info "Creating storage account: $azStorageAccount"
$existing = Invoke-AzJson -Arguments @("storage", "account", "show", "--name", $azStorageAccount, "--resource-group", $azResourceGroup) -AllowFailure
if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
    Write-Ok "Storage account already exists: $azStorageAccount"
} else {
    Invoke-AzCmd -Arguments @(
        "storage", "account", "create",
        "--name", $azStorageAccount,
        "--resource-group", $azResourceGroup,
        "--location", $azLocation,
        "--sku", "Standard_LRS",
        "--kind", "StorageV2"
    ) | Out-Null
    Write-Ok "Created storage account: $azStorageAccount"
}

# Get storage connection string
$storageKeys = Invoke-AzJson -Arguments @(
    "storage", "account", "show-connection-string",
    "--name", $azStorageAccount,
    "--resource-group", $azResourceGroup
)
$storageConnStr = $storageKeys.connectionString

# 3c–3d: Compute resources (branched by deploy target)

if ($isContainerApp) {
    # ── Container Apps path ──────────────────────────────────────────────────

    # 3c. Azure Container Registry
    Write-Info "Creating Azure Container Registry: $azContainerRegistry"
    $existing = Invoke-AzJson -Arguments @("acr", "show", "--name", $azContainerRegistry, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Container Registry already exists: $azContainerRegistry"
    } else {
        Invoke-AzCmd -Arguments @(
            "acr", "create",
            "--name", $azContainerRegistry,
            "--resource-group", $azResourceGroup,
            "--location", $azLocation,
            "--sku", "Basic",
            "--admin-enabled", "true"
        ) | Out-Null
        Write-Ok "Created Container Registry: $azContainerRegistry"
    }

    # 3d. Container Apps Environment
    Write-Info "Creating Container Apps Environment: $azContainerAppEnv"
    $existing = Invoke-AzJson -Arguments @("containerapp", "env", "show", "--name", $azContainerAppEnv, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Container Apps Environment already exists: $azContainerAppEnv"
    } else {
        Invoke-AzCmd -Arguments @(
            "containerapp", "env", "create",
            "--name", $azContainerAppEnv,
            "--resource-group", $azResourceGroup,
            "--location", $azLocation
        ) | Out-Null
        Write-Ok "Created Container Apps Environment: $azContainerAppEnv"
    }

    # 3e. Function App on Container Apps
    Write-Info "Creating Function App on Container Apps: $azFuncApp"
    $existing = Invoke-AzJson -Arguments @("functionapp", "show", "--name", $azFuncApp, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Function App already exists: $azFuncApp"
    } else {
        Invoke-AzCmd -Arguments @(
            "functionapp", "create",
            "--name", $azFuncApp,
            "--resource-group", $azResourceGroup,
            "--storage-account", $azStorageAccount,
            "--environment", $azContainerAppEnv,
            "--runtime", "node",
            "--runtime-version", "20",
            "--functions-version", "4",
            "--workload-profile-name", "Consumption",
            "--cpu", $containerCpu,
            "--memory", $containerMemory
        ) | Out-Null
        Write-Ok "Created Function App on Container Apps: $azFuncApp"
    }

} elseif ($isFlexConsumption) {
    # ── Flex Consumption path ────────────────────────────────────────────────

    Write-Info "Creating Flex Consumption Function App: $azFuncApp"
    $existing = Invoke-AzJson -Arguments @("functionapp", "show", "--name", $azFuncApp, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Function App already exists: $azFuncApp"
    } else {
        Invoke-AzCmd -Arguments @(
            "functionapp", "create",
            "--name", $azFuncApp,
            "--resource-group", $azResourceGroup,
            "--storage-account", $azStorageAccount,
            "--flexconsumption-location", $azLocation,
            "--runtime", "node",
            "--runtime-version", "20"
        ) | Out-Null
        Write-Ok "Created Flex Consumption Function App: $azFuncApp"
    }

} else {
    # ── Azure Functions (Premium/Dedicated) path ─────────────────────────────

    # 3c. App Service Plan
    Write-Info "Creating App Service Plan: $azAppPlan ($azPlanSku)"
    $existing = Invoke-AzJson -Arguments @("functionapp", "plan", "show", "--name", $azAppPlan, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "App Service Plan already exists: $azAppPlan"
    } else {
        Invoke-AzCmd -Arguments @(
            "functionapp", "plan", "create",
            "--name", $azAppPlan,
            "--resource-group", $azResourceGroup,
            "--location", $azLocation,
            "--sku", $azPlanSku,
            "--is-linux", "true"
        ) | Out-Null
        Write-Ok "Created App Service Plan: $azAppPlan ($azPlanSku)"
    }

    # 3d. Function App
    Write-Info "Creating Function App: $azFuncApp"
    $existing = Invoke-AzJson -Arguments @("functionapp", "show", "--name", $azFuncApp, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Function App already exists: $azFuncApp"
    } else {
        Invoke-AzCmd -Arguments @(
            "functionapp", "create",
            "--name", $azFuncApp,
            "--resource-group", $azResourceGroup,
            "--plan", $azAppPlan,
            "--storage-account", $azStorageAccount,
            "--runtime", "node",
            "--runtime-version", "20",
            "--functions-version", "4",
            "--os-type", "Linux"
        ) | Out-Null
        Write-Ok "Created Function App: $azFuncApp"
    }
}

# 3e. Application Insights (if name provided; Flex auto-creates its own)
if ($azAppInsights -ne "" -and -not $isFlexConsumption) {
    Write-Info "Creating Application Insights: $azAppInsights"
    $existing = Invoke-AzJson -Arguments @("monitor", "app-insights", "component", "show", "--app", $azAppInsights, "--resource-group", $azResourceGroup) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Application Insights already exists: $azAppInsights"
        $aiConnStr = $existing.connectionString
    } else {
        $aiResult = Invoke-AzJson -Arguments @(
            "monitor", "app-insights", "component", "create",
            "--app", $azAppInsights,
            "--location", $azLocation,
            "--resource-group", $azResourceGroup,
            "--application-type", "web"
        )
        $aiConnStr = $aiResult.connectionString
        Write-Ok "Created Application Insights: $azAppInsights"
    }

    # Link to Function App
    Invoke-AzCmd -Arguments @(
        "functionapp", "config", "appsettings", "set",
        "--name", $azFuncApp,
        "--resource-group", $azResourceGroup,
        "--settings", "APPLICATIONINSIGHTS_CONNECTION_STRING=$aiConnStr"
    ) | Out-Null
    Write-Ok "Linked Application Insights to Function App"
}

# ─── Step 4: Entra ID App Registration ──────────────────────────────────────

Write-Step "4/10" "Configuring Entra ID Application"

if ($entraAutoCreate) {
    Write-Info "Creating Entra ID app registration: Veeva Vault Copilot Connector"

    # Create app registration
    $appResult = Invoke-AzJson -Arguments @(
        "ad", "app", "create",
        "--display-name", "Veeva Vault Copilot Connector",
        "--sign-in-audience", "AzureADMyOrg"
    )
    $azClientId = $appResult.appId
    Write-Ok "Created app registration: $azClientId"

    # Create service principal
    $spExists = Invoke-AzJson -Arguments @("ad", "sp", "show", "--id", $azClientId) -AllowFailure
    if ($null -eq $spExists -or $LASTEXITCODE -ne 0) {
        Invoke-AzCmd -Arguments @("ad", "sp", "create", "--id", $azClientId) | Out-Null
        Write-Ok "Created service principal"
    } else {
        Write-Ok "Service principal already exists"
    }

    # Create client secret
    Write-Info "Creating client secret..."
    $secretResult = Invoke-AzJson -Arguments @(
        "ad", "app", "credential", "reset",
        "--id", $azClientId,
        "--display-name", "Veeva Connector Setup",
        "--years", "2"
    )
    $azClientSecret = $secretResult.password
    Write-Ok "Client secret created (expires in 2 years)"

    # Add Graph API permissions
    $graphAppId = "00000003-0000-0000-c000-000000000000"  # Microsoft Graph
    $permissions = @(
        "f431331c-49a6-499f-be1c-62af19c34a9d",  # ExternalConnection.ReadWrite.OwnedBy
        "8116ae0f-55c2-452d-9571-d9b8f16f0734",  # ExternalItem.ReadWrite.OwnedBy
        "1914711b-a1cb-4793-b019-c2ce0ed21b8c",  # ExternalConnection.Read.All
        "7ab1d382-f21e-4acd-a863-ba3e13f7da61",  # Directory.Read.All
        "5b567255-7703-4780-807c-7be8301ae99b",  # Group.Read.All
        "df021288-bdef-4463-88db-98f22de89214"   # User.Read.All
    )

    Write-Info "Adding Microsoft Graph API permissions..."
    foreach ($permId in $permissions) {
        Invoke-AzCmd -Arguments @(
            "ad", "app", "permission", "add",
            "--id", $azClientId,
            "--api", $graphAppId,
            "--api-permissions", "$permId=Role"
        ) -AllowFailure | Out-Null
    }
    Write-Ok "Added 6 Graph API permissions"

    # Grant admin consent
    Write-Info "Granting admin consent (requires Cloud Application Admin or Global Admin role)..."
    Start-Sleep -Seconds 5  # Wait for permission propagation
    $consentResult = Invoke-AzCmd -Arguments @(
        "ad", "app", "permission", "admin-consent",
        "--id", $azClientId
    ) -AllowFailure

    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Could not auto-grant admin consent. This may require elevated privileges."
        Write-Warn "Please grant consent manually in the Azure Portal:"
        Write-Warn "  https://entra.microsoft.com → App registrations → Veeva Vault Copilot Connector → API permissions → Grant admin consent"
        Write-Host ""
        Read-Host "  Press Enter after granting consent to continue"
    } else {
        Write-Ok "Admin consent granted for all permissions"
    }

} else {
    Write-Ok "Using existing Entra ID app: $azClientId"
    if ($azTenantId -eq "") {
        $azTenantId = Require-EnvValue $envVars "AZURE_TENANT_ID" "Enter your Entra ID tenant ID"
    }
    if ($azClientSecret -eq "") {
        $azClientSecret = Require-EnvValue $envVars "SECRET_AZURE_CLIENT_SECRET" "Enter the Entra ID client secret"
    }
}

# ─── Step 5: Key Vault & Secrets ────────────────────────────────────────────

Write-Step "5/10" "Configuring Secrets"

if ($useKeyVault) {
    Write-Info "Creating Key Vault: $azKeyVault"
    $existing = Invoke-AzJson -Arguments @("keyvault", "show", "--name", $azKeyVault) -AllowFailure
    if ($null -ne $existing -and $LASTEXITCODE -eq 0) {
        Write-Ok "Key Vault already exists: $azKeyVault"
    } else {
        Invoke-AzCmd -Arguments @(
            "keyvault", "create",
            "--name", $azKeyVault,
            "--resource-group", $azResourceGroup,
            "--location", $azLocation
        ) | Out-Null
        Write-Ok "Created Key Vault: $azKeyVault"
    }

    # Enable Function App managed identity
    Write-Info "Enabling managed identity on Function App..."
    $identity = Invoke-AzJson -Arguments @(
        "functionapp", "identity", "assign",
        "--name", $azFuncApp,
        "--resource-group", $azResourceGroup
    )
    $principalId = $identity.principalId
    Write-Ok "Managed identity enabled: $principalId"

    # Wait for identity propagation
    Write-Info "Waiting for identity propagation..."
    Start-Sleep -Seconds 15

    # Grant Key Vault access
    Write-Info "Granting Key Vault secret access to Function App..."
    Invoke-AzCmd -Arguments @(
        "keyvault", "set-policy",
        "--name", $azKeyVault,
        "--object-id", $principalId,
        "--secret-permissions", "get", "list"
    ) | Out-Null
    Write-Ok "Key Vault access granted"

    # Store secrets
    Write-Info "Storing secrets in Key Vault..."
    Invoke-AzCmd -Arguments @(
        "keyvault", "secret", "set",
        "--vault-name", $azKeyVault,
        "--name", "VeevaPassword",
        "--value", $vaultPassword
    ) | Out-Null
    Invoke-AzCmd -Arguments @(
        "keyvault", "secret", "set",
        "--vault-name", $azKeyVault,
        "--name", "AzureClientSecret",
        "--value", $azClientSecret
    ) | Out-Null
    Write-Ok "Secrets stored in Key Vault"

    $secretVeevaRef = "@Microsoft.KeyVault(VaultName=$azKeyVault;SecretName=VeevaPassword)"
    $secretClientRef = "@Microsoft.KeyVault(VaultName=$azKeyVault;SecretName=AzureClientSecret)"
} else {
    Write-Warn "Key Vault disabled — secrets will be stored directly in app settings (not recommended for production)"
    $secretVeevaRef = $vaultPassword
    $secretClientRef = $azClientSecret
}

# ─── Step 6: Configure App Settings ─────────────────────────────────────────

Write-Step "6/10" "Configuring Function App Settings"

$appSettings = @(
    "VEEVA_VAULT_DNS=$vaultDns",
    "VEEVA_USERNAME=$vaultUser",
    "SECRET_VEEVA_PASSWORD=$secretVeevaRef",
    "VEEVA_API_VERSION=$veevaApiVer",
    "AZURE_CLIENT_ID=$azClientId",
    "SECRET_AZURE_CLIENT_SECRET=$secretClientRef",
    "AZURE_TENANT_ID=$azTenantId",
    "VAULT_APPLICATION=$vaultApp",
    "GRAPH_API_VERSION=$graphApiVer",
    "FULL_CRAWL_DAYS=$fullCrawlDays",
    "CRAWL_BATCH_SIZE=$crawlBatchSize",
    "PROGRESS_BATCH_SIZE=$progressBatch",
    "AUTO_DISCOVER_OBJECTS=$autoDiscover"
)

# Add optional overrides
if ($connectorId -ne "")   { $appSettings += "CONNECTOR_ID=$connectorId" }
if ($connectorName -ne "") { $appSettings += "CONNECTOR_NAME=$connectorName" }
if ($connectorDesc -ne "") { $appSettings += "CONNECTOR_DESCRIPTION=$connectorDesc" }

Write-Info "Setting $($appSettings.Count) application settings..."
$settingsArgs = @(
    "functionapp", "config", "appsettings", "set",
    "--name", $azFuncApp,
    "--resource-group", $azResourceGroup,
    "--settings"
) + $appSettings

Invoke-AzCmd -Arguments $settingsArgs | Out-Null
Write-Ok "Application settings configured"

# ─── Step 7: Veeva Connectivity Check ───────────────────────────────────────

Write-Step "7/10" "Verifying Veeva Vault Connectivity"

Write-Info "Testing authentication against $vaultDns..."
try {
    $veevaAuthUrl = "https://$vaultDns/api/$veevaApiVer/auth"
    $authBody = "username=$([Uri]::EscapeDataString($vaultUser))&password=$([Uri]::EscapeDataString($vaultPassword))"
    $authResponse = Invoke-RestMethod -Uri $veevaAuthUrl -Method Post -Body $authBody -ContentType "application/x-www-form-urlencoded" -ErrorAction Stop
    if ($authResponse.responseStatus -eq "SUCCESS") {
        Write-Ok "Veeva Vault authentication successful"
        Write-Info "Session ID: $($authResponse.sessionId.Substring(0, 8))..."
    } else {
        Write-Warn "Veeva responded but auth failed: $($authResponse.responseMessage)"
        Write-Warn "Continuing — verify Vault credentials before crawling"
    }
} catch {
    Write-Warn "Could not reach Veeva Vault at $vaultDns — $($_.Exception.Message)"
    Write-Warn "Continuing — the connector will retry at runtime"
}

# ─── Step 8: Build & Deploy ─────────────────────────────────────────────────

Write-Step "8/10" "Building and Deploying Connector"

if (-not $SkipBuild) {
    Write-Info "Installing dependencies..."
    & npm ci --prefer-offline 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    Write-Ok "Dependencies installed"

    Write-Info "Building project..."
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    Write-Ok "Build successful"

    Write-Info "Running tests..."
    $testOutput = & npm test 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Some tests failed — review output:"
        Write-Host ($testOutput | Select-Object -Last 10 | Out-String)
    } else {
        $testLine = ($testOutput | Select-String "Tests:") | Select-Object -Last 1
        Write-Ok "Tests passed: $testLine"
    }
} else {
    Write-Info "Skipping build (--SkipBuild flag set)"
    if (-not (Test-Path (Join-Path $projectRoot "dist"))) {
        throw "dist/ directory not found. Build the project first or remove --SkipBuild"
    }
}

Write-Info "Deploying to ${deployTarget}: ${azFuncApp}..."
Write-Info "(This may take a few minutes)"

if ($isContainerApp) {
    # Build and deploy container image via ACR
    $acrLoginServer = "$azContainerRegistry.azurecr.io"
    $imageName = "$acrLoginServer/${azFuncApp}:latest"

    Write-Info "Building container image via ACR: $imageName"
    $dockerfilePath = Join-Path $projectRoot "Dockerfile"
    if (-not (Test-Path $dockerfilePath)) {
        throw "Dockerfile not found at $dockerfilePath"
    }

    Invoke-AzCmd -Arguments @(
        "acr", "build",
        "--registry", $azContainerRegistry,
        "--resource-group", $azResourceGroup,
        "--image", "${azFuncApp}:latest",
        "--file", "Dockerfile",
        "."
    ) | Out-Null
    Write-Ok "Container image built and pushed to ACR"

    # Configure the function app to use the ACR image
    Write-Info "Configuring Function App to use container image..."
    $acrCreds = Invoke-AzJson -Arguments @(
        "acr", "credential", "show",
        "--name", $azContainerRegistry,
        "--resource-group", $azResourceGroup
    )
    $acrUsername = $acrCreds.username
    $acrPassword = $acrCreds.passwords[0].value

    Invoke-AzCmd -Arguments @(
        "functionapp", "config", "container", "set",
        "--name", $azFuncApp,
        "--resource-group", $azResourceGroup,
        "--image", $imageName,
        "--registry-server", $acrLoginServer,
        "--registry-username", $acrUsername,
        "--registry-password", $acrPassword
    ) | Out-Null
    Write-Ok "Function App configured with container image"
} else {
    # Deploy via Azure Functions Core Tools
    $deployOutput = & func azure functionapp publish $azFuncApp 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Deployment failed:"
        Write-Host ($deployOutput | Out-String)
        throw "func azure functionapp publish failed"
    }
}
Write-Ok "Deployment successful"

# ─── Step 9: Initialize Connection & Start Crawl ────────────────────────────

Write-Step "9/10" "Initializing Graph Connection & Starting Crawl"

# Get function base URL
Write-Info "Retrieving function app URL..."

if ($isContainerApp) {
    # For Container Apps, get the FQDN from the function app properties
    $funcAppInfo = Invoke-AzJson -Arguments @(
        "functionapp", "show",
        "--name", $azFuncApp,
        "--resource-group", $azResourceGroup
    )
    $hostName = $funcAppInfo.defaultHostName
    if (-not $hostName) {
        Write-Warn "Could not retrieve Container Apps FQDN. Trying convention-based URL..."
        $hostName = "$azFuncApp.azurecontainerapps.io"
    }
    $baseUrl = "https://$hostName/api"
    Write-Info "Container App URL: $baseUrl"
} else {
    $baseUrl = "https://$azFuncApp.azurewebsites.net/api"
}

# Get function keys
Write-Info "Retrieving function keys..."
$funcKeys = Invoke-AzJson -Arguments @(
    "functionapp", "keys", "list",
    "--name", $azFuncApp,
    "--resource-group", $azResourceGroup
) -AllowFailure
$defaultKey = ""
if ($funcKeys -and $funcKeys.functionKeys) {
    $defaultKey = $funcKeys.functionKeys.default
}
if (-not $defaultKey) {
    if ($funcKeys -and $funcKeys.masterKey) {
        $defaultKey = $funcKeys.masterKey
    }
}

if ($defaultKey) {
    $codeParam = "?code=$defaultKey"
} else {
    Write-Warn "Could not retrieve function key. Trying without auth..."
    $codeParam = ""
}

# Wait for the function app to be ready (cold start / Flex scale-from-zero)
Write-Info "Waiting for function app to become ready..."
$maxRetries = 12
$retryDelay = 10
$ready = $false
for ($i = 1; $i -le $maxRetries; $i++) {
    try {
        $statusResp = Invoke-RestMethod -Uri "$baseUrl/status$codeParam" -Method Get -TimeoutSec 15 -ErrorAction Stop
        Write-Ok "Function app is ready (attempt $i/$maxRetries)"
        $ready = $true
        break
    } catch {
        Write-Info "Attempt $i/$maxRetries — not ready yet, retrying in ${retryDelay}s..."
        Start-Sleep -Seconds $retryDelay
    }
}
if (-not $ready) {
    Write-Warn "Function app did not respond after $maxRetries attempts. Proceeding anyway..."
}

# Deploy connection
Write-Info "Creating Graph external connection and registering schema..."
try {
    $deployResult = Invoke-RestMethod -Uri "$baseUrl/deployConnection$codeParam" -Method Post -TimeoutSec 600 -ErrorAction Stop
    Write-Ok "Connection deployed: $($deployResult.connectionId)"
    if ($deployResult.schemaStatus) {
        Write-Info "Schema status: $($deployResult.schemaStatus)"
    }
} catch {
    Write-Warn "Deploy connection call returned: $($_.Exception.Message)"
    Write-Warn "The connection timer will retry automatically. Check the admin dashboard."
}

# Wait a moment then start full crawl
Start-Sleep -Seconds 5

Write-Info "Starting initial full crawl..."
try {
    $crawlResult = Invoke-RestMethod -Uri "$baseUrl/fullCrawl$codeParam" -Method Post -TimeoutSec 30 -ErrorAction Stop
    Write-Ok "Full crawl started: $($crawlResult.status)"
    Write-Info "The crawl will run in the background. Monitor progress in the admin dashboard."
} catch {
    Write-Warn "Full crawl trigger returned: $($_.Exception.Message)"
    Write-Warn "The full crawl timer will start automatically. Check the admin dashboard."
}

# ─── Step 10: Complete ──────────────────────────────────────────────────────

Write-Step "10/10" "Setup Complete!"

$adminUrl = "$baseUrl/admin"

# Deploy M365 agents if requested
if ($deployAgents -and -not $SkipAgents) {
    Write-Info "Deploying M365 Copilot agents..."
    if (Test-Command "teamsapp") {
        try {
            & teamsapp provision 2>&1 | Out-Null
            & teamsapp deploy 2>&1 | Out-Null
            Write-Ok "M365 Copilot agents deployed"
        } catch {
            Write-Warn "Agent deployment failed: $($_.Exception.Message)"
            Write-Warn "Deploy manually with: teamsapp provision && teamsapp deploy"
        }
    } else {
        Write-Warn "teamsapp CLI not found. Install it with: npm install -g @microsoft/teamsapp-cli"
        Write-Warn "Then deploy agents: teamsapp provision && teamsapp deploy"
    }
}

$summary = @"

  ╔══════════════════════════════════════════════════════════════╗
  ║   ✅  Deployment Complete!                                  ║
  ╠══════════════════════════════════════════════════════════════╣
  ║                                                            ║
  ║   Deploy Target: $($deployTarget.PadRight(38))║
  ║   Function App:  $($azFuncApp.PadRight(38))║
  ║   Connector ID:  $((if ($connectorId) { $connectorId } else { "veeva" + (Get-Culture).TextInfo.ToTitleCase($vaultApp) }).PadRight(38))║
  ║   Application:   $($vaultApp.PadRight(38))║
  ║   Graph API:     $($graphApiVer.PadRight(38))║
  ║   Key Vault:     $($(if ($useKeyVault) { $azKeyVault } else { 'Disabled' }).PadRight(38))║
  ║                                                            ║
  ║   Admin Dashboard:                                         ║
  ║   $($adminUrl.PadRight(55))║
  ║                                                            ║
  ║   Status API:                                              ║
  ║   $("$baseUrl/status$codeParam".Substring(0, [Math]::Min("$baseUrl/status$codeParam".Length, 55)).PadRight(55))║
  ║                                                            ║
  ╚══════════════════════════════════════════════════════════════╝

"@
Write-Host $summary -ForegroundColor Green

Write-Info "Opening admin dashboard in your browser..."
Start-Process $adminUrl

} finally {
    Pop-Location
}
