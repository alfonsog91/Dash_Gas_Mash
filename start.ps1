Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$port = 5173
$uri = "http://localhost:$port/"

# Prefer the workspace venv Python if present.
$python = Join-Path $here '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
  $python = 'python'
}

try {
  $proc = Start-Process -FilePath $python -ArgumentList @('-m', 'http.server', $port) -WorkingDirectory $here -PassThru -WindowStyle Hidden
} catch {
  Write-Warning "Could not start server on port $port (maybe it's already running)."
}

# Wait briefly for the server to come up (best-effort).
for ($i = 0; $i -lt 40; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing $uri -TimeoutSec 1 | Out-Null
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
}

Start-Process $uri
Write-Host "Opened $uri"
Write-Host "If you need to stop the server: close the Python process using Task Manager, or run a different port (e.g., 5174)."
