$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageInfo = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageInfo.version
if ($version -ne '0.2.1') { throw 'This publication is limited to version 0.2.1.' }
$releaseRoot = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$modName = "DRGChatTranslator-$version-Mintcat.zip"
$kitName = "drg-chat-translator-$version.zip"
$modPath = Join-Path $releaseRoot $modName
Add-Type -AssemblyName System.IO.Compression
function Write-Package([string]$path, $files) {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Create)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in $files) {
            $entry = $archive.CreateEntry($item.Name, [IO.Compression.CompressionLevel]::Optimal)
            $inputStream = [IO.File]::OpenRead($item.Path)
            $outputStream = $entry.Open()
            try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
        }
    } finally { $archive.Dispose(); $stream.Dispose() }
}
$modFiles = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'js') -File -Filter '*.js' | Sort-Object Name | ForEach-Object { @{ Name = 'js/' + $_.Name; Path = $_.FullName } }
Write-Package $modPath $modFiles
$kitFiles = @(
    @{ Name = $modName; Path = $modPath },
    @{ Name = 'configure.ps1'; Path = (Join-Path $projectRoot 'configure.ps1') },
    @{ Name = '配置翻译.cmd'; Path = (Join-Path $projectRoot '配置翻译.cmd') },
    @{ Name = 'README.md'; Path = (Join-Path $projectRoot 'README.md') }
)
Write-Package (Join-Path $releaseRoot $kitName) $kitFiles
@($kitName, $modName) | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath (Join-Path $releaseRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $_"
} | Set-Content -LiteralPath (Join-Path $releaseRoot 'SHA256SUMS.txt') -Encoding ascii
Get-ChildItem -LiteralPath $releaseRoot -File | Select-Object Name,Length
