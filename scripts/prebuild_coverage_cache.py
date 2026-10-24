"""
Pre-build the 0.2° tile cache of a 4G coverage GeoPackage for the whole country, so a server
answers 4G lookups from the small cached tiles and never opens the 1.2 GB GeoPackage (a cold
read peaks at ~1.4 GB of RAM and takes 7–10 s).

    python scripts/prebuild_coverage_cache.py data/coverage/RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg

Writes data/coverage/cache/<gpkg name>/<x>_<y>.json (the cache core/cellular.py reads; tiles
already there are skipped, so it can be resumed). Empty tiles (sea) are written too.
"""

import argparse
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from core.cellular import TILE_DEG, CoverageSource  # noqa: E402

MEXICO = (-118.6, 14.4, -86.6, 32.8)       # lon / lat box, a little wider than the country
BLOCK = 5                                   # tiles per side read from the GeoPackage at once


def blocks(src: CoverageSource, block: int = BLOCK) -> list[list[tuple[int, int]]]:
    x0, y0 = src._tile_of(MEXICO[0], MEXICO[1])
    x1, y1 = src._tile_of(MEXICO[2], MEXICO[3])
    out = []
    for bx in range(x0, x1 + 1, block):
        for by in range(y0, y1 + 1, block):
            tiles = [(x, y) for x in range(bx, min(bx + block, x1 + 1)) for y in range(by, min(by + block, y1 + 1))]
            if any(not src._tile_file(t).exists() for t in tiles):
                out.append(tiles)
    return out


def build(args) -> int:
    path, tiles = args
    src = CoverageSource(path)
    src._load_tiles(tiles)
    return len(tiles)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gpkg", type=Path)
    ap.add_argument("--workers", type=int, default=4)
    # dense areas: a 5×5 block peaked at 7.9 GB on the server (2026-10-23); smaller blocks use less
    ap.add_argument("--block", type=int, default=BLOCK, help="tiles per side read at once")
    args = ap.parse_args()
    src = CoverageSource(args.gpkg)
    todo = blocks(src, args.block)
    print(f"{len(todo)} blocks of up to {args.block}×{args.block} tiles ({TILE_DEG}°) to build into {src.cache_dir}", flush=True)
    t0, done = time.time(), 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for i, n in enumerate(pool.map(build, [(args.gpkg, b) for b in todo]), 1):
            done += n
            if i % 10 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)} blocks, {done} tiles, {time.time() - t0:.0f} s", flush=True)
    files = list(src.cache_dir.glob("*.json"))
    print(f"cache: {len(files)} tiles, {sum(f.stat().st_size for f in files) / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
