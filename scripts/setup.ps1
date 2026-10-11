# Hey Jarvis - one-time setup for Windows.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# (ASCII only on purpose: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$missing = @()
function Check($cmd, $install) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Host "  [ok] $cmd" -ForegroundColor Green
    } else {
        Write-Host "  [missing] $cmd  ->  $install" -ForegroundColor Yellow
        $script:missing += $cmd
    }
}

Write-Host "`nChecking tools..." -ForegroundColor Cyan
Check "node"     "winget install OpenJS.NodeJS.LTS"
Check "pnpm"     "npm install -g pnpm"
Check "cargo"    "winget install Rustlang.Rustup   (Tauri also needs the 'Desktop development with C++' workload: winget install Microsoft.VisualStudio.2022.BuildTools)"
Check "uv"       "winget install astral-sh.uv"
Check "git"      "winget install Git.Git"
Check "opencode" "npm install -g opencode-ai   (then run 'opencode' once and sign in / pick a model)"

if ($missing.Count -gt 0) {
    Write-Host "`nInstall the missing tools above, open a NEW terminal, and run this script again." -ForegroundColor Yellow
    exit 1
}

if (Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) {
    $gpu = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) -join ", "
    Write-Host "  [ok] NVIDIA GPU: $gpu (Whisper will run on CUDA)" -ForegroundColor Green
} else {
    Write-Host "  [info] No NVIDIA GPU detected - Whisper will run on the CPU (slower but fine)." -ForegroundColor DarkGray
}

Write-Host "`nInstalling JavaScript dependencies..." -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nSetting up the voice engine (Python via uv, with CUDA libraries)..." -ForegroundColor Cyan
uv sync --project apps/voice --extra cuda
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nDownloading voice models (wake word, VAD, Kokoro voice, Whisper) - about 1 GB, first time only..." -ForegroundColor Cyan
uv run --project apps/voice --extra cuda python -m jarvis_voice --download
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$home_dir = Join-Path $env:USERPROFILE ".hey-jarvis"
$config = Join-Path $home_dir "config.json"
if (-not (Test-Path $config)) {
    New-Item -ItemType Directory -Force -Path $home_dir | Out-Null
    @'
{
  "brain": "opencode",
  "opencode": {},
  "voice": { "voice": "af_heart", "whisperModel": "small.en" }
}
'@ | Set-Content -Encoding ascii $config
    Write-Host "`nCreated $config" -ForegroundColor Green
}

Write-Host "`nAll set! Start Jarvis with:  pnpm dev" -ForegroundColor Green
Write-Host "Then say 'Hey Jarvis' (or press Ctrl+Shift+J to talk, Ctrl+Shift+K to type)." -ForegroundColor Green
