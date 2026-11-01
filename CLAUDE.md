# Arranger ST

A 1-bit, Atari-ST-style arrange sequencer with eight tracks (DS-10 style synths or DS-10 style drum kits
of rendered samples), a mixer
(2 inserts per strip, 2 send buses, master), DS-10 FX / Midiverb / tape delay / distortion,
and KAOSS-pad automation.

## Shipping form

The app is distributed as ONE self-contained file: `arranger-st.html` in this folder (also copied to `/home/user/arranger-st.html` for publishing).
Never split it into several files or add runtime fetches; everything (engine, tables,
Midiverb programs, patch library, manual) is inlined by the build.

Build after every change:

    python3 build.py

## Layout

- `src/app.html` – page, UI (canvas-drawn 640x400 GEM screen), sequencer, mixer model, saving.
  Placeholders `@@ENGINE@@`, `@@MVNAMES@@`, `@@MANUAL@@` are filled by `build.py`.
- `src/engine.js` – AudioWorklet engine (DS-10 voice port, filters, effects, mixer). It is
  embedded as a `<script type="text/plain">` and loaded via blob:/data: URL.
- `src/manual.js` – the in-app manual (Desk > Manual, F9).
- `src/ds10_tables.js`, `src/midiverb_fx.js` – generated data; regenerate with `tools/`
  (needs the upstream repos ds10emu and midiverb_emulator cloned locally; paths are at the top of each script).

## Rules

- **Always update the manual (`src/manual.js`) in the same change whenever a user-visible
  function is added, changed or removed** – controls, menus, shortcuts, windows, behaviour.
  Also update the Desk > Keyboard Shortcuts dialog in `src/app.html` when shortcuts change.
- Keep the 1-bit look: black/white only, VT323, draw through the `clr`/`T`/`box` helpers so
  pixels snap to the device grid.
- Every control registers a hint (`reg(..., {hint:[title, text, key]})`) for the status line.
- Test with a headless browser (Playwright/Chromium) after changes: load the built file,
  check for page errors, exercise the changed feature.
