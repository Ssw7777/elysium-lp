$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host 'Elysium LP -> http://127.0.0.1:8097/elysium-lp/'
python server.py --port 8097
