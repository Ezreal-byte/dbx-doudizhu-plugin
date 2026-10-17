param(
    [string]$PackagePath = '',
    [ValidateSet('', 'windows-x64', 'darwin-arm64', 'darwin-x64')]
    [string]$Target = '',
    [string]$ProjectRoot = ''
)
$ErrorActionPreference = 'Stop'
if (!$ProjectRoot) { $ProjectRoot = Join-Path $PSScriptRoot '..' }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$expectedManifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Encoding utf8 -Raw | ConvertFrom-Json
if (!$PackagePath) {
    if (!$Target) { $Target = 'windows-x64' }
    $PackagePath = Join-Path $ProjectRoot ("dist/$($expectedManifest.id)-$($expectedManifest.version)-$Target.dbxp")
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if ([IO.Path]::GetExtension($PackagePath) -ne '.dbxp') { throw 'Package path must name a .dbxp archive' }
$metadata = Get-Content -Raw -Encoding utf8 -LiteralPath ($PackagePath -replace '\.dbxp$', '.artifact.json') | ConvertFrom-Json
if ($metadata.target -notin @('windows-x64', 'darwin-arm64', 'darwin-x64')) { throw "Unexpected package target: $($metadata.target)" }
if ($Target -and $metadata.target -ne $Target) { throw "Package target $($metadata.target) does not match requested target $Target" }
$Target = $metadata.target
$backendEntry = if ($Target -eq 'windows-x64') { 'bin/windows-x64/dbx-doudizhu.exe' } else { "bin/$Target/dbx-doudizhu" }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PackagePath).Hash.ToLowerInvariant()
if ($hash -ne $metadata.sha256) { throw 'Package checksum mismatch' }
if ((Get-Item -LiteralPath $PackagePath).Length -ne $metadata.size) { throw 'Package size mismatch' }
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
    foreach ($required in @('manifest.json','LICENSE',$backendEntry,'ui/index.html','ui/assets/countryside.png','ui/assets/characters.png','ui/assets/characters-extra.png','ui/assets/garden-sans.woff2','ui/assets/garden-sans-bold.woff2','ui/assets/audio/garden-table.ogg','assets/audio/garden-table.ogg','assets/licenses/index.json','assets/licenses/kokoro-Apache-2.0.txt')) {
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
if ($manifest.entrypoints.backend.executable -ne $backendEntry) { throw "Unexpected backend executable: $($manifest.entrypoints.backend.executable)" }
$binaryPath = Join-Path $verifyRoot $backendEntry
$binaryStream = [IO.File]::OpenRead($binaryPath)
$binaryReader = [IO.BinaryReader]::new($binaryStream)
try {
    if ($Target -eq 'windows-x64') {
        if ($binaryReader.ReadUInt16() -ne 0x5A4D) { throw 'Windows sidecar is not a PE executable' }
        $binaryStream.Position = 0x3C
        $peOffset = $binaryReader.ReadUInt32()
        if ($peOffset -gt $binaryStream.Length - 6) { throw 'Invalid PE header offset' }
        $binaryStream.Position = $peOffset
        if ($binaryReader.ReadUInt32() -ne 0x00004550 -or $binaryReader.ReadUInt16() -ne 0x8664) { throw 'Windows sidecar is not x64 PE' }
    } else {
        # Go emits a little-endian 64-bit Mach-O; CPU type distinguishes Intel and Apple Silicon.
        if ($binaryReader.ReadUInt32() -ne 0xFEEDFACFu) { throw 'macOS sidecar is not a 64-bit Mach-O executable' }
        $expectedCpuType = if ($Target -eq 'darwin-arm64') { 0x0100000C } else { 0x01000007 }
        if ($binaryReader.ReadUInt32() -ne $expectedCpuType) { throw "Mach-O CPU type does not match $Target" }
    }
} finally { $binaryReader.Dispose(); $binaryStream.Dispose() }
$nativeArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
$nativeTarget = if ($IsWindows) { "windows-$nativeArchitecture" } elseif ($IsMacOS) { "darwin-$nativeArchitecture" } else { "unsupported-$nativeArchitecture" }
if ($Target -ne $nativeTarget) { throw "Native integration requires a $Target host; current process is $nativeTarget" }
if ($IsMacOS) {
    # DBX marks the extracted Unix sidecar executable during installation; ZIP mode bits are not required.
    & chmod 0755 $binaryPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not make the extracted macOS sidecar executable' }
}
$previousBinary = $env:DBX_TEST_BINARY
try {
    $env:DBX_TEST_BINARY = $binaryPath
    & node (Join-Path $projectRoot 'scripts/integration.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged sidecar integration failed' }
} finally { $env:DBX_TEST_BINARY = $previousBinary }
$result = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); status='passed'; target=$Target; sha256=$hash; size=$metadata.size; entries=$entries.Count; packagedBinaryThreeProcessIntegration=$true; extractionDirectory=$verifyRoot }
$resultPath = Join-Path $projectRoot 'test-results/package-verification.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resultPath)) | Out-Null
[IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ("Package verified ($Target): " + $hash)
