"""Check that adding a native backend does not change the version's UI or media."""
import hashlib
import sys
import zipfile


def content(package):
    with zipfile.ZipFile(package) as archive:
        return {
            entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
            for entry in archive.infolist()
            if not entry.is_dir()
            and entry.filename.startswith(("ui/", "assets/"))
            and not entry.filename.startswith("assets/licenses/")
        }


if len(sys.argv) != 4:
    raise SystemExit("usage: verify-platform-content.py windows.dbxp arm64.dbxp x64.dbxp")
reference = content(sys.argv[1])
if not reference:
    raise SystemExit("No UI/media found in reference package")
for package in sys.argv[2:]:
    candidate = content(package)
    differences = sorted(name for name in reference.keys() | candidate.keys() if reference.get(name) != candidate.get(name))
    if differences:
        raise SystemExit(f"UI/media differs in {package}: {differences[:20]}")
print(f"All three packages contain identical {len(reference)} UI/media files.")
