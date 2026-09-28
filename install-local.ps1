# Spotify Universal Importer - Local Installation Script for Windows
$pluginName = "spotify-importer"
$appDataPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ApplicationData)
$audionPluginsDir = Join-Path $appDataPath "com.audion.app\plugins"
$targetDir = Join-Path $audionPluginsDir $pluginName

Write-Host "Installing $pluginName to Audion..." -ForegroundColor Cyan
Write-Host "Target: $targetDir" -ForegroundColor Gray

if (-not (Test-Path -Path $audionPluginsDir)) {
    New-Item -ItemType Directory -Path $audionPluginsDir -Force | Out-Null
}

if (Test-Path -Path $targetDir) {
    Remove-Item -Path $targetDir -Recurse -Force
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

Copy-Item -Path "$PSScriptRoot\plugin.json" -Destination $targetDir -Force
Copy-Item -Path "$PSScriptRoot\index.js" -Destination $targetDir -Force

Write-Host ""
Write-Host "Plugin installed successfully into Audion!" -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Open Audion"
Write-Host "  2. Go to Settings > Plugins"
Write-Host "  3. Click 'Reload Plugins' and toggle 'Spotify Universal Importer' ON."
