"""Build the small browser drum kit from pinned CC0 Virtuosity Drums FLACs."""

import io
import json
import math
import re
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf


REVISION = "9f04cf9a734527edfbb0a4eee1f674e45bbf71bc"
ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "src/frontend/assets/virtuosity"
TREE_URL = f"https://api.github.com/repos/sfzinstruments/virtuosity_drums/git/trees/{REVISION}?recursive=1"
FAMILIES = {
    "kick": ("Samples/kickmic/kick/kickmic_kick_snon", 4),
    "snare_center": ("Samples/mid/snare/mid_snare_center", 6),
    "snare_rim": ("Samples/mid/snare/mid_snare_rimshot", 4),
    "snare_side": ("Samples/mid/snare/mid_snare_crossstick", 4),
    "hat_closed": ("Samples/mid/hh/mid_hh_closed", 4),
    "hat_half": ("Samples/mid/hh/mid_hh_half", 4),
    "hat_pedal": ("Samples/mid/hh/mid_hh_pedal", 3),
    "hat_open": ("Samples/mid/hh/mid_hh_open", 4),
    "hat_three_quarter": ("Samples/mid/hh/mid_hh_34", 4),
    "ride_bow": ("Samples/mid/ride/mid_ride_ride", 3),
    "ride_bell": ("Samples/mid/ride/mid_ride_bell", 3),
    "crash": ("Samples/mid/crash/mid_crash_crash", 4),
    "tom_high": ("Samples/mid/htom/mid_htom_center", 4),
    "tom_mid": ("Samples/mid/ltom/mid_ltom_offcenter", 4),
    "tom_low": ("Samples/mid/ltom/mid_ltom_center", 4),
}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "jam-partner-drum-kit-builder"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def selected_paths(paths, stem, max_layers):
    available = {}
    pattern = re.compile(re.escape(stem) + r"_vl(\d+)(?:_rr1)?\.flac$")
    for path in paths:
        match = pattern.fullmatch(path)
        if match:
            available[int(match.group(1))] = path
    if not available:
        raise RuntimeError(f"No source samples for {stem}")
    layers = sorted(available)
    count = min(max_layers, len(layers))
    indices = [math.ceil((index + 1) * len(layers) / count) - 1 for index in range(count)]
    return [available[layers[index]] for index in indices]


def main():
    tree = json.loads(fetch(TREE_URL))
    if tree.get("truncated"):
        raise RuntimeError("GitHub source tree was truncated")
    paths = {entry["path"] for entry in tree["tree"] if entry["type"] == "blob"}
    DESTINATION.mkdir(parents=True, exist_ok=True)
    families = {}
    source_files = {}
    for family, (stem, max_layers) in FAMILIES.items():
        families[family] = []
        source_files[family] = []
        for index, source_path in enumerate(selected_paths(paths, stem, max_layers), start=1):
            destination = f"{family}-layer-{index}.wav"
            data = fetch(f"https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/{REVISION}/{source_path}")
            audio, rate = sf.read(io.BytesIO(data), dtype="float32")
            if audio.ndim == 2:
                audio = np.mean(audio, axis=1)
            sf.write(DESTINATION / destination, audio, rate, subtype="PCM_16")
            families[family].append(destination)
            source_files[family].append(source_path)
            print(family, index, destination)
    manifest = {
        "name": "Virtuosity Drums subset",
        "license": "CC0-1.0",
        "source_revision": REVISION,
        "families": families,
        "source_files": source_files,
        "approximations": {"22": "hat_half (source pitch: closed edge)", "26": "hat_three_quarter (source pitch: open edge)", "45": "tom_mid (off-center low tom)", "47": "tom_mid (off-center low tom)"},
    }
    (DESTINATION / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
