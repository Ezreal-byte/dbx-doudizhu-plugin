param([string]$PackagePath = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedManifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Encoding utf8 -Raw | ConvertFrom-Json
if (!$PackagePath) {
    $PackagePath = Join-Path $projectRoot ("dist/$($expectedManifest.id)-$($expectedManifest.version)-windows-x64.dbxp")
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$metadata = Get-Content -Raw -Encoding utf8 -LiteralPath ($PackagePath -replace '\.dbxp$', '.artifact.json') | ConvertFrom-Json
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PackagePath).Hash.ToLowerInvariant()
if ($hash -ne $metadata.sha256) { throw 'Package checksum mismatch' }
if ((Get-Item -LiteralPath $PackagePath).Length -ne $metadata.size) { throw 'Package size mismatch' }
if ($metadata.target -ne 'windows-x64') { throw 'Unexpected package target' }
if ($metadata.PSObject.Properties.Name -contains 'signingKeyId') { throw 'Review candidate must not declare a signing key' }
$verifyRoot = Join-Path ([IO.Path]::GetTempPath()) ('dbx-ddz-package-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($verifyRoot) | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($entries -contains 'signature.json') { throw 'Review candidate must be unsigned' }
    if (($entries | Sort-Object -Unique).Count -ne $entries.Count) { throw 'Duplicate archive entry' }
    foreach ($entry in $archive.Entries) {
        $destination = [IO.Path]::GetFullPath((Join-Path $verifyRoot $entry.FullName))
        if (!$destination.StartsWith($verifyRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
        if ($entry.FullName.StartsWith('ui/') -and $entry.Length -gt 32MB) { throw 'UI asset exceeds host 32 MiB limit' }
    }
    foreach ($required in @('manifest.json','LICENSE','bin/windows-x64/dbx-doudizhu.exe','ui/index.html','ui/assets/countryside.png','ui/assets/characters.png','ui/assets/characters-extra.png','ui/assets/garden-sans.woff2','ui/assets/garden-sans-bold.woff2','ui/assets/audio/garden-table.ogg','assets/audio/garden-table.ogg','assets/licenses/index.json','assets/licenses/kokoro-Apache-2.0.txt')) {
        if ($entries -notcontains $required) { throw "Missing package entry: $required" }
    }
    foreach ($prefix in @('assets/audio/voices/', 'ui/assets/audio/voices/')) {
        $clips = @($entries | Where-Object { $_.StartsWith($prefix) -and $_.EndsWith('.ogg') })
        if ($clips.Count -ne 360) { throw "Expected 360 voice clips under $prefix, found $($clips.Count)" }
    }
    if ($entries | Where-Object { $_ -match '(^|/)(node_modules|\.dbx-dev|identity\.json|\.git)(/|$)' }) { throw 'Development data leaked into package' }
} finally { $archive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($PackagePath, $verifyRoot)
$manifest = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $verifyRoot 'manifest.json') | ConvertFrom-Json
foreach ($field in @('id', 'version', 'publisher')) {
    if ($manifest.$field -ne $expectedManifest.$field) { throw "Unexpected package manifest $field" }
}
if (($manifest.permissions | Sort-Object | ConvertTo-Json -Compress) -ne ($expectedManifest.permissions | Sort-Object | ConvertTo-Json -Compress)) { throw 'Package permissions differ from source manifest' }
$previousBinary = $env:DBX_TEST_BINARY
try {
    $env:DBX_TEST_BINARY = Join-Path $verifyRoot $manifest.entrypoints.backend.executable
    & node (Join-Path $projectRoot 'scripts/integration.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged sidecar integration failed' }
} finally { $env:DBX_TEST_BINARY = $previousBinary }
$result = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); status='passed'; sha256=$hash; size=$metadata.size; entries=$entries.Count; packagedBinaryThreeProcessIntegration=$true; extractionDirectory=$verifyRoot }
$resultPath = Join-Path $projectRoot 'test-results/package-verification.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resultPath)) | Out-Null
[IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ('Package verified: ' + $hash)
