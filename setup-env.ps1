# setup-env.ps1 — Copy .env.example to .env for every service (safe — won't overwrite existing)
$services = @("auth-service","vehicle-service","inventory-service","transaction-service","people-service","integration-service")
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($svc in $services) {
    $src = Join-Path $root "$svc\.env.example"
    $dst = Join-Path $root "$svc\.env"
    if (Test-Path $src) {
        if (-not (Test-Path $dst)) {
            Copy-Item $src $dst
            Write-Host "  Created .env for $svc" -ForegroundColor Green
        } else {
            Write-Host "  .env already exists for $svc (skipped)" -ForegroundColor DarkGray
        }
    }
}
Write-Host "`nDone. Edit each service .env file with real values before starting." -ForegroundColor Cyan
