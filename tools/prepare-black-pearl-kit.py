"""Prepare AVL Black Pearl samples. Requires numpy and soundfile."""

import io
import json
import urllib.request
from pathlib import Path

import soundfile as sf

REVISION = "b06cb2c27359cbc68a830a82bddced05bd73d1a0"
SOURCE = f"https://raw.githubusercontent.com/studiorack/avl-drumkits/{REVISION}"
DESTINATION = Path(__file__).resolve().parents[1] / "src/frontend/assets/black-pearl"
FAMILIES = {
    "kick": "36-Pearl22Kick",
    "snare_center": "38-PearlSnare2",
    "snare_rim": "40-PearlSnare2Edge",
    "snare_side": "37-Sidestick2",
    "hat_closed": "42-SabianRockHatClosed",
    "hat_half": "46-SabianRockHatSemiOpen",
    "hat_pedal": "44-SabianRockHatPedal",
    "hat_open": "48-SabianRockHatSwish",
    "hat_three_quarter": "48-SabianRockHatSwish",
    "ride_bow": "51-SabianAAX20Ride",
    "ride_bell": "53-SabianAAX20RideBell",
    "crash": "49-SabianAA16Crash",
    "tom_high": "45-Pearl12Tom",
    "tom_mid": "47-Pearl13Tom2",
    "tom_low": "41-Pearl16FloorTom",
}


def fetch(path):
    with urllib.request.urlopen(f"{SOURCE}/{path}", timeout=60) as response:
        return response.read()


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    families = {}
    source_files = {}
    for family, stem in FAMILIES.items():
        files = []
        for layer in range(1, 6):
            filename = f"{stem.lower()}-{layer}.wav"
            source_path = f"Samples/{stem}-{layer}.flac"
            if filename not in source_files:
                audio, rate = sf.read(io.BytesIO(fetch(source_path)), dtype="int16")
                # Lossless format conversion: retain the source balance and dynamics.
                sf.write(DESTINATION / filename, audio, rate, subtype="PCM_16")
                source_files[filename] = source_path
            files.append(filename)
        families[family] = files
        print(family, flush=True)
    manifest = {
        "name": "AVL Black Pearl 5-piece subset",
        "author": "Glen MacArthur",
        "license": "CC-BY-SA-3.0",
        "source": "https://github.com/studiorack/avl-drumkits",
        "source_revision": REVISION,
        "families": families,
        "source_files": source_files,
        "approximations": {
            "snare_rim": "Snare edge hit",
            "hat_three_quarter": "Open hi-hat swish",
        },
    }
    (DESTINATION / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (DESTINATION / "LICENSE.txt").write_bytes(fetch("LICENSE"))
    (DESTINATION / "NOTICE.txt").write_text(
        "AVL Black Pearl drum samples by Glen MacArthur.\n"
        "Source: https://www.bandshed.net/avldrumkits/\n"
        f"Mirror revision: {REVISION}\n"
        "Licensed under Creative Commons Attribution-ShareAlike 3.0 Unported.\n"
        "https://creativecommons.org/licenses/by-sa/3.0/\n"
        "Changes: selected a subset and converted FLAC to PCM WAV without audio processing.\n"
        "These sample files retain the same CC-BY-SA-3.0 license.\n"
    )


if __name__ == "__main__":
    main()
