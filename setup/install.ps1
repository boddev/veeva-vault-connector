<#
.SYNOPSIS
    Veeva Vault Copilot Connector — Setup Launcher & Prerequisite Installer

.DESCRIPTION
    Entry point for the connector setup process. Checks for all required tools,
    installs any that are missing, then lets the user choose between the
    PowerShell script or browser GUI wizard.

    Double-click install.bat or run this script directly to get started.

.EXAMPLE
    .\setup\install.ps1
#>

$ErrorActionPreference = "Stop"

# ─── Helpers ────────────────────────────────────────────────────────────────

function Write-Banner {
    $banner = @"

  ╔══════════════════════════════════════════════════════════════╗
  ║                                                            ║
  ║   🔗  Veeva Vault Copilot Connector                        ║
  ║       Setup Launcher & Prerequisite Installer              ║
  ║                                                            ║
  ╚══════════════════════════════════════════════════════════════╝

"@
    Write-Host $banner -ForegroundColor Cyan
}

function Write-Ok   { param([string]$Msg) Write-Host "  ✅ $Msg" -ForegroundColor Green }
function Write-Info { param([string]$Msg) Write-Host "  ℹ  $Msg" -ForegroundColor Gray }
function Write-Warn { param([string]$Msg) Write-Host "  ⚠️  $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "  ❌ $Msg" -ForegroundColor Red }

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "  ── $Title ──────────────────────────────────────────" -ForegroundColor White
    Write-Host ""
}

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-WingetAvailable {
    return (Test-Command "winget")
}

function Install-WithWinget {
    param([string]$PackageId, [string]$Label)
    Write-Info "Installing $Label via winget..."
    $output = & winget install --id $PackageId --accept-source-agreements --accept-package-agreements --silent 2>&1
    if ($LASTEXITCODE -ne 0) {
        $errText = ($output | Out-String)
        if ($errText -match "already installed") {
            Write-Ok "$Label is already installed (winget confirmed)"
            return $true
        }
        Write-Err "winget install failed for $Label"
        return $false
    }
    Write-Ok "$Label installed successfully"
    return $true
}

function Refresh-Path {
    # Reload PATH from registry so newly installed tools are found
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

# ─── Main ───────────────────────────────────────────────────────────────────

Write-Banner

# Resolve paths
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectRoot = Split-Path -Parent $scriptDir

$hasWinget = Test-WingetAvailable
if ($hasWinget) {
    Write-Info "winget detected — will use it for automatic installations"
} else {
    Write-Warn "winget not available — will provide manual install instructions for missing tools"
}

# ─── Prerequisite Checks ───────────────────────────────────────────────────

Write-Section "Checking Prerequisites"

$allInstalled = $true
$needsPathRefresh = $false
$installResults = @{}

# ── 1. PowerShell 7+ (pwsh)
$pwshOk = $false
if (Test-Command "pwsh") {
    $pwshVer = (pwsh --version 2>$null) -replace 'PowerShell ', ''
    $pwshMajor = [int]($pwshVer.Split('.')[0])
    if ($pwshMajor -ge 7) {
        Write-Ok "PowerShell 7: $pwshVer"
        $pwshOk = $true
    } else {
        Write-Warn "PowerShell 7+ recommended (found: $pwshVer)"
    }
} else {
    # Check if we're running in PS 5.1 (Windows PowerShell)
    if ($PSVersionTable.PSVersion.Major -ge 5) {
        Write-Warn "Running Windows PowerShell $($PSVersionTable.PSVersion). PowerShell 7+ is recommended."
    }
}

if (-not $pwshOk) {
    Write-Info "Attempting to install PowerShell 7..."
    if ($hasWinget) {
        $installed = Install-WithWinget -PackageId "Microsoft.PowerShell" -Label "PowerShell 7"
        if ($installed) { $needsPathRefresh = $true; $pwshOk = $true }
    }
    if (-not $pwshOk) {
        Write-Warn "Install PowerShell 7 manually: https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows"
        $installResults["PowerShell 7"] = "manual"
    }
}

# ── 2. Node.js 20+
$nodeOk = $false
if (Test-Command "node") {
    $nodeVer = (node --version 2>$null) -replace 'v', ''
    $nodeMajor = [int]($nodeVer.Split('.')[0])
    if ($nodeMajor -ge 20) {
        Write-Ok "Node.js: v$nodeVer"
        $nodeOk = $true
    } else {
        Write-Warn "Node.js 20+ required (found: v$nodeVer)"
    }
} else {
    Write-Warn "Node.js not found"
}

if (-not $nodeOk) {
    Write-Info "Attempting to install Node.js 20 LTS..."
    if ($hasWinget) {
        $installed = Install-WithWinget -PackageId "OpenJS.NodeJS.LTS" -Label "Node.js LTS"
        if ($installed) { $needsPathRefresh = $true; $nodeOk = $true }
    }
    if (-not $nodeOk) {
        Write-Warn "Install Node.js 20+ manually: https://nodejs.org/"
        $installResults["Node.js 20+"] = "manual"
        $allInstalled = $false
    }
}

# Refresh PATH after Node install before checking npm and installing npm-based tools
if ($needsPathRefresh) { Refresh-Path }

# ── 3. npm (comes with Node.js, but verify)
if (Test-Command "npm") {
    $npmVer = (npm --version 2>$null)
    Write-Ok "npm: v$npmVer"
} else {
    if ($nodeOk) {
        Write-Warn "npm not found despite Node.js being installed. Refreshing PATH..."
        Refresh-Path
        if (Test-Command "npm") {
            $npmVer = (npm --version 2>$null)
            Write-Ok "npm: v$npmVer (found after PATH refresh)"
        } else {
            Write-Err "npm not found. Reinstall Node.js from https://nodejs.org/"
            $installResults["npm"] = "manual"
            $allInstalled = $false
        }
    } else {
        Write-Info "npm will be available after Node.js is installed"
    }
}

# ── 4. Azure CLI
$azOk = $false
if (Test-Command "az") {
    $azVer = (az version 2>$null | ConvertFrom-Json).'azure-cli'
    Write-Ok "Azure CLI: v$azVer"
    $azOk = $true
} else {
    Write-Warn "Azure CLI not found"
}

if (-not $azOk) {
    Write-Info "Attempting to install Azure CLI..."
    if ($hasWinget) {
        $installed = Install-WithWinget -PackageId "Microsoft.AzureCLI" -Label "Azure CLI"
        if ($installed) { $needsPathRefresh = $true; $azOk = $true }
    }
    if (-not $azOk) {
        Write-Warn "Install Azure CLI manually: https://learn.microsoft.com/cli/azure/install-azure-cli"
        $installResults["Azure CLI"] = "manual"
        $allInstalled = $false
    }
}

if ($needsPathRefresh) { Refresh-Path }

# ── 5. Azure Functions Core Tools
$funcOk = $false
if (Test-Command "func") {
    $funcVer = (func --version 2>$null)
    Write-Ok "Azure Functions Core Tools: v$funcVer"
    $funcOk = $true
} else {
    Write-Warn "Azure Functions Core Tools not found"
}

if (-not $funcOk) {
    Write-Info "Attempting to install Azure Functions Core Tools..."

    # Try npm global install first (works cross-platform, no elevation needed)
    if (Test-Command "npm") {
        Write-Info "Installing via npm..."
        $npmOutput = & npm install -g azure-functions-core-tools@4 --unsafe-perm true 2>&1
        if ($LASTEXITCODE -eq 0) {
            Refresh-Path
            Write-Ok "Azure Functions Core Tools installed via npm"
            $funcOk = $true
        } else {
            Write-Warn "npm global install failed (may need elevation)"
        }
    }

    # Fallback to winget
    if (-not $funcOk -and $hasWinget) {
        $installed = Install-WithWinget -PackageId "Microsoft.Azure.FunctionsCoreTools" -Label "Azure Functions Core Tools"
        if ($installed) { $needsPathRefresh = $true; $funcOk = $true }
    }

    if (-not $funcOk) {
        Write-Warn "Install manually: npm install -g azure-functions-core-tools@4"
        Write-Warn "Or download from: https://learn.microsoft.com/azure/azure-functions/functions-run-local"
        $installResults["Azure Functions Core Tools"] = "manual"
        $allInstalled = $false
    }
}

if ($needsPathRefresh) { Refresh-Path }

# ─── Summary ────────────────────────────────────────────────────────────────

Write-Section "Prerequisite Summary"

# Re-check everything after installations and PATH refresh
$finalChecks = @(
    @{ Name = "node"; Label = "Node.js 20+"; MinMajor = 20 },
    @{ Name = "npm";  Label = "npm" },
    @{ Name = "az";   Label = "Azure CLI" },
    @{ Name = "func"; Label = "Azure Functions Core Tools" }
)

$missingTools = @()
foreach ($tool in $finalChecks) {
    if (Test-Command $tool.Name) {
        $ver = & $tool.Name --version 2>$null | Select-Object -First 1
        if ($tool.MinMajor) {
            $major = [int](($ver -replace '[^0-9.]', '').Split('.')[0])
            if ($major -lt $tool.MinMajor) {
                Write-Err "$($tool.Label): $ver (need $($tool.MinMajor)+)"
                $missingTools += $tool.Label
                continue
            }
        }
        Write-Ok "$($tool.Label): $ver"
    } else {
        Write-Err "$($tool.Label): NOT FOUND"
        $missingTools += $tool.Label
    }
}

if ($missingTools.Count -gt 0) {
    Write-Host ""
    Write-Err "The following tools could not be installed automatically:"
    foreach ($tool in $missingTools) {
        Write-Host "     • $tool" -ForegroundColor Red
    }
    Write-Host ""
    Write-Warn "Please install the missing tools above, then re-run this script."
    Write-Host ""
    Write-Host "  Press any key to exit..." -ForegroundColor Gray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host ""
Write-Ok "All prerequisites are installed!"

# ─── Choose Setup Method ────────────────────────────────────────────────────

Write-Section "Choose Setup Method"

Write-Host "  How would you like to configure and deploy the connector?" -ForegroundColor White
Write-Host ""
Write-Host "    [1]  📜  PowerShell Script" -ForegroundColor Cyan
Write-Host "         Command-line setup that reads from a .env file." -ForegroundColor Gray
Write-Host "         Best for: scripted deployments, CI/CD, headless environments" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    [2]  🌐  Browser GUI Wizard" -ForegroundColor Cyan
Write-Host "         Visual step-by-step wizard in your browser." -ForegroundColor Gray
Write-Host "         Best for: first-time setup, interactive configuration" -ForegroundColor DarkGray
Write-Host ""

do {
    $choice = Read-Host "  Enter your choice (1 or 2)"
} while ($choice -ne "1" -and $choice -ne "2")

# ─── Check for .env ─────────────────────────────────────────────────────────

$envPath = Join-Path $scriptDir ".env"
$templatePath = Join-Path $scriptDir ".env.template"

if (-not (Test-Path $envPath)) {
    Write-Host ""
    Write-Warn "No .env file found at: $envPath"

    if (Test-Path $templatePath) {
        Write-Info "Creating .env from template..."
        Copy-Item $templatePath $envPath
        Write-Ok "Created setup/.env — please edit it with your values before continuing."
        Write-Host ""

        if ($choice -eq "1") {
            Write-Host "  Opening .env file for editing..." -ForegroundColor Gray
            # Try VS Code first, then notepad
            if (Test-Command "code") {
                & code $envPath --wait
            } else {
                & notepad $envPath | Out-Null
            }
            Write-Host ""
            $continue = Read-Host "  Have you saved your .env file? (y/n)"
            if ($continue -ne "y" -and $continue -ne "Y") {
                Write-Info "Edit setup/.env and re-run when ready."
                exit 0
            }
        } else {
            Write-Info "The GUI wizard will let you enter values in the browser."
        }
    } else {
        Write-Err "Template not found at: $templatePath"
        Write-Info "Create setup/.env manually. See setup/README.md for reference."
        exit 1
    }
}

# ─── Install npm dependencies if needed ─────────────────────────────────────

Write-Section "Preparing Project"

$nodeModulesPath = Join-Path $projectRoot "node_modules"
if (-not (Test-Path $nodeModulesPath)) {
    Write-Info "Installing project dependencies (npm ci)..."
    Push-Location $projectRoot
    & npm ci --prefer-offline 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "npm ci failed, trying npm install..."
        & npm install 2>&1 | Out-Null
    }
    Pop-Location
    Write-Ok "Dependencies installed"
} else {
    Write-Ok "Dependencies already installed"
}

# ─── Launch chosen method ───────────────────────────────────────────────────

Write-Section "Launching Setup"

if ($choice -eq "1") {
    Write-Info "Starting PowerShell script setup..."
    Write-Host ""

    $setupScript = Join-Path $scriptDir "setup.ps1"

    # Prefer pwsh (PS7) if available
    if (Test-Command "pwsh") {
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $setupScript -EnvFile $envPath
    } else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $setupScript -EnvFile $envPath
    }
} else {
    Write-Info "Starting GUI wizard server..."
    Write-Host ""

    $guiScript = Join-Path $scriptDir "setup-gui.js"
    & node $guiScript
}
