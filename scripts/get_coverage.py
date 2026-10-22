"""
Download the 4G coverage maps into data/coverage/.

The files (the operator map ≈1.2 GB, its map tiles ≈130 MB, the terrain relief grid 22 MB) are too big for the repository, so they are published
as assets of a GitHub release of this repo. Run once per computer, and again
when a new quarter is published:

    python scripts/get_coverage.py

Uses only the standard library, so it works before installing requirements.
Source: Comisión Reguladora de Telecomunicaciones, datos.gob.mx (CC BY 4.0);
see data/coverage/README.md.
"""

import hashlib
import shutil
import sys
import time
import urllib.request
from pathlib import Path

REPO = "guychomendoza/verea"
RELEASE_TAG = "coverage-2026Q2"

# name, size in bytes, sha256
FILES = [
    ("RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg", 1204379648,
     "dc54d40be2d479102345f314fed6cad95db85a36a24fe54f68059d133eca1463"),
    # map tiles made by scripts/build_coverage_tiles.py (terrain-adaptive margin)
    ("telcel_4g_2026q2.pmtiles", 130051722,
     "5b9b5b7c191b36d5b0793fb325eace113a101bce7bf760aa4be9730de6d31ba2"),
    # relief that sizes the margin (scripts/build_relief.py, Copernicus DEM GLO-90)
    ("relief_mx.npz", 21978076,
     "9f541951ebb319fa0df37cc3d3c23d3636b56bdc8fbea4c6426e655757cf1f23"),
]

DEST = Path(__file__).resolve().parent.parent / "data" / "coverage"
CHUNK = 1024 * 1024


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def download(name: str, size: int, digest: str) -> bool:
    target = DEST / name
    if target.exists() and target.stat().st_size == size:
        print(f"{name}: checking the existing file…")
        if sha256_of(target) == digest:
            print(f"{name}: already up to date.")
            return True
        print(f"{name}: existing file is different, downloading again.")

    url = f"https://github.com/{REPO}/releases/download/{RELEASE_TAG}/{name}"
    part = target.with_suffix(target.suffix + ".part")
    print(f"{name}: downloading {size / 1e6:,.0f} MB from {url}")
    h = hashlib.sha256()
    done, last = 0, 0.0
    with urllib.request.urlopen(url) as resp, open(part, "wb") as out:
        while block := resp.read(CHUNK):
            out.write(block)
            h.update(block)
            done += len(block)
            now = time.monotonic()
            if now - last > 1 or done == size:
                print(f"\r  {done / 1e6:,.0f} / {size / 1e6:,.0f} MB ({done / size:.0%})", end="", flush=True)
                last = now
    print()
    if done != size or h.hexdigest() != digest:
        part.unlink(missing_ok=True)
        print(f"{name}: the download is incomplete or corrupt, run the script again.")
        return False
    part.replace(target)
    # Tiles cut from an older version of this file are no longer valid
    shutil.rmtree(DEST / "cache" / target.stem, ignore_errors=True)
    print(f"{name}: ready.")
    return True


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    ok = all([download(*f) for f in FILES])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
