"""
Build data/coverage/towers_mx.csv (approximate LTE sites) from OpenCelliD.

OpenCelliD (https://opencellid.org, CC BY-SA 4.0) needs a free account; its
"Downloads" page gives a token and the per-country file for Mexico (MCC 334).

    OPENCELLID_TOKEN=pk.xxxx python scripts/get_towers.py
    python scripts/get_towers.py --from-file ~/Downloads/334.csv.gz   # downloaded in a browser

A token allows only a few downloads per day: the raw file is kept in data/towers/.
"""

import argparse
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from core.towers import TOWERS_FILE, read_opencellid, save_towers, sites_from_cells  # noqa: E402

RAW_DIR = ROOT / "data" / "towers"
URL = "https://opencellid.org/ocid/downloads?token={token}&type=mcc&file=334.csv.gz"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-file", type=Path, help="OpenCelliD export already downloaded")
    ap.add_argument("--token", default=os.environ.get("OPENCELLID_TOKEN"))
    args = ap.parse_args()
    src = args.from_file
    if src is None:
        src = RAW_DIR / "334.csv.gz"
        if not src.exists():
            if not args.token:
                print("Set OPENCELLID_TOKEN (free account at opencellid.org) or use --from-file.")
                return 1
            RAW_DIR.mkdir(parents=True, exist_ok=True)
            print("Downloading OpenCelliD Mexico (MCC 334)…", flush=True)
            req = urllib.request.Request(URL.format(token=args.token), headers={"User-Agent": "verea"})
            with urllib.request.urlopen(req, timeout=300) as r:
                data = r.read()
            if data[:2] != b"\x1f\x8b":
                print("OpenCelliD did not return a file:", data[:200].decode(errors="replace"))
                return 1
            src.write_bytes(data)
    rows = read_opencellid(src)
    towers = sites_from_cells(rows)
    save_towers(towers)
    counts = {}
    for t in towers:
        counts[t.operator] = counts.get(t.operator, 0) + 1
    print(f"{len(rows):,} cells -> {len(towers):,} LTE sites in {TOWERS_FILE}: "
          + ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
