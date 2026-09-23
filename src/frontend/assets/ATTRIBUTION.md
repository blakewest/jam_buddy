# Drum sample attribution

The kick, snare, closed hi-hat, open hi-hat, ride, crash, high tom, mid tom, and floor tom WAV files come from the Open Source Drumkit (OSDK).

- Source: https://download.linuxaudio.org/musical-instrument-libraries/sfz/the_open_source_drumkit.tar.7z
- License: Public Domain
- Original notice: The samples and mappings are completely in the public domain.

The articulation-aware kit used by the beat maker is a mono, 16-bit WAV subset of Virtuosity Drums. Its selected samples and source paths are listed in `virtuosity/manifest.json`; some MIDI pitches share a nearby available articulation, as noted there.

- Source: https://github.com/sgossner/VirtuosityDrums/tree/9f04cf9a734527edfbb0a4eee1f674e45bbf71bc
- License: CC0 1.0
- Processing: Selected velocity layers were downmixed to mono and converted from FLAC to WAV. No timing or pitch quantization was applied.

Selected beat presets adapt performances from the Groove MIDI Dataset by Google LLC.

- Source: https://magenta.tensorflow.org/datasets/groove
- License: Creative Commons Attribution 4.0 International
- Source performance IDs are recorded in `src/core/pattern/presets.ts`.

## Roland TR-808

Michael Fischer / Technopolis TR-808 sample set (1994), distributed by [smpldsnds/drum-machines](https://github.com/smpldsnds/drum-machines), which identifies the collection as public domain.

- [Original author notes](https://smpldsnds.github.io/drum-machines/TR-808/TR808.TXT)
- Sources: `TR-808/kick/bd5050.m4a`, `TR-808/snare/sd5050.m4a`, `TR-808/hihat-close/ch.m4a`, `TR-808/hihat-open/oh50.m4a` under https://smpldsnds.github.io/drum-machines/.
- These are the auditioned AAC-derived samples, decoded to mono 44.1 kHz 16-bit WAV and peak-normalized. They are not claimed to be original lossless recordings.

## Roland TR-505

[Oramics Sampled TR-505](https://oramics.github.io/sampled/DM/TR-505/) identifies these samples as Public Domain, sourced from Progsounds.

- Source files: `tr505-kick.wav`, `tr505-snare.wav`, `tr505-hihat-closed.wav`, `tr505-hihat-open.wav` in that collection's `samples/` directory.
- Converted to mono 44.1 kHz 16-bit WAV and peak-normalized.

Electronic kits use five gain levels applied to one sample per instrument, not five separately recorded velocity layers. Kit balance and gain levels are demo engineering choices.
