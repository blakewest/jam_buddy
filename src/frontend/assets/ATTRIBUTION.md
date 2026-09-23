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
- Source performance IDs are recorded in `src/core/pattern/presets.js`.
