"""
Fill the API server's data volume (Fly.io, mounted at /data = ./data) once; safe to run again:

    fly ssh console -C "python scripts/server_data.py"

  1. the Copernicus GLO-90 DEM tiles of Mexico (dem_tiles.txt, ≈1 GB) from the public AWS bucket;
  2. the operator 4G GeoPackage and the relief grid from this repo's GitHub release (get_coverage.py);
  3. the national 0.2° 4G tile cache (prebuild_coverage_cache.py), so lookups never read the
     1.2 GB GeoPackage (that needs ~1.4 GB of RAM): give the machine more memory and CPUs for
     this step only (deploy/README.md).
"""

import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))
import get_coverage  # noqa: E402

BUCKET = "https://copernicus-dem-90m.s3.amazonaws.com"
DEM_DIR = ROOT / "data" / "dem"
SERVER_FILES = ("RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg", "relief_mx.npz")


def dem() -> None:
    DEM_DIR.mkdir(parents=True, exist_ok=True)
    names = (HERE / "dem_tiles.txt").read_text().split()
    for i, name in enumerate(names, 1):
        path = DEM_DIR / f"{name}.tif"
        if path.exists():
            continue
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(f"{BUCKET}/{name}/{name}.tif", tmp)
        tmp.replace(path)
        if i % 20 == 0:
            print(f"  DEM {i}/{len(names)}", flush=True)
    print(f"DEM: {len(list(DEM_DIR.glob('*.tif')))} tiles")


def main() -> int:
    dem()
    get_coverage.DEST.mkdir(parents=True, exist_ok=True)
    if not all(get_coverage.download(*f) for f in get_coverage.FILES if f[0] in SERVER_FILES):
        return 1
    import prebuild_coverage_cache
    # A worker on a dense block peaks at ~4.1 GB: three, then two, on 8 GB were OOM-killed (2026-10-23)
    mem_gb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    workers = max(1, min((os.cpu_count() or 2) - 1, int((mem_gb - 1) // 4.5)))
    sys.argv = ["prebuild", str(get_coverage.DEST / SERVER_FILES[0]), "--workers", str(workers), "--block", "2"]
    return prebuild_coverage_cache.main()


if __name__ == "__main__":
    sys.exit(main())
