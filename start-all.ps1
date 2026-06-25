# start-all.ps1 — Start all microservices in separate windows (no Docker)
# Copy .env.example -> .env in each service if .env is missing.

$services = @(
  @{ name="auth-service";        port=3001 },
  @{ name="vehicle-service";     port=3002 },
  @{ name="inventory-service";   port=3003 },
  @{ name="transaction-service"; port=3004 },
  @{ name="people-service";      port=3005 },
  @{ name="integration-service"; port=3006 }
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($svc in $services) {
    $path   = Join-Path $root $svc.name
    $envSrc = Join-Path $path ".env.example"
    $envDst = Join-Path $path ".env"
    if (-not (Test-Path $envDst) -and (Test-Path $envSrc)) {
        Copy-Item $envSrc $envDst
        Write-Host "  Copied .env.example -> .env for $($svc.name)" -ForegroundColor Yellow
    }
    Write-Host "==> Starting $($svc.name) on port $($svc.port) ..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$path'; npm start" -WindowStyle Normal
}

Write-Host "`nAll services starting. Open http://localhost:80 for the API Gateway." -ForegroundColor Green
Write-Host "Make sure Nginx is running separately (see nginx/ folder)." -ForegroundColor Yellow
