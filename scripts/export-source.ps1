param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $sourceRoot 'dist' }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $sourceRoot 'manifest.json') -Encoding utf8 -Raw | ConvertFrom-Json).version
$sourceArchive = Join-Path $OutputDirectory ("dbx-doudizhu-plugin-$version-source.zip")
$topDirectories = @('.github', 'assets', 'backend', 'docs', 'public', 'scripts', 'src')
$rootFiles = @('.gitignore', '.gitattributes', '.dbx-store.json', 'dbx-plugin.toml', 'index.html', 'LICENSE', 'manifest.json', 'package.json', 'pnpm-lock.yaml', 'README.md', 'THIRD_PARTY_NOTICES.md', 'tsconfig.json', 'vite.config.ts')
$sources = @()
foreach ($directory in $topDirectories) {
    $sources += Get-ChildItem -LiteralPath (Join-Path $sourceRoot $directory) -File -Recurse | Where-Object {
        $relative = [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/')
        $relative -notmatch '(^|/)(bin|node_modules|\.cache|\.git|__pycache__|\.venv)(/|$)' -and $_.Extension -notin @('.exe', '.pyc') -and $_.Name -notin @('identity.json', 'custom-music.json', '.env') -and !$_.Name.StartsWith('.env.')
    }
}
foreach ($file in $rootFiles) { $sources += Get-Item -LiteralPath (Join-Path $sourceRoot $file) }
$stream = [IO.File]::Open($sourceArchive, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($file in ($sources | Sort-Object FullName)) {
        $relative = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, ('dbx-doudizhu-plugin/' + $relative), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose(); $stream.Dispose() }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceArchive).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($sourceArchive + '.sha256'), ($hash + '  ' + [IO.Path]::GetFileName($sourceArchive) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output ('Source archive: ' + $sourceArchive + ' (' + $sources.Count + ' files)')
Write-Output ('SHA-256: ' + $hash)
