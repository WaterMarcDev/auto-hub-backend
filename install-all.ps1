# install-all.ps1 — Install dependencies for every microservice
$services = @("shared", "auth-service","vehicle-service","inventory-service","transaction-service","people-service","integration-service")
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($svc in $services) {
    $path = Join-Path $root $svc
    Write-Host "==> Installing $svc ..." -ForegroundColor Cyan
    Push-Location $path
    npm install
    Pop-Location
}
Write-Host "`nAll services installed." -ForegroundColor Green
