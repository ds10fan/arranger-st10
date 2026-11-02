# Arranger ST desktop app (Linux)

The same page as `arranger-st.html`, as a desktop application that can put **VST3 instruments**
on tracks.

- The UI is the built `arranger-st.html` (embedded into the binary at compile time) shown in a
  WebKitGTK window (wry/tao).
- The audio engine is the unchanged `src/engine.js`, run in an embedded V8 isolate inside the
  native audio callback (cpal: PipeWire, PulseAudio, JACK or ALSA, the first that works). The page
  talks to it over the webview's IPC with the same messages it posts to its AudioWorklet in the
  browser; the page's clock follows the audio frames the app reports.
- VST3 instruments run in the same callback. The engine hands each VST track's notes (with sample
  offsets) to the host before it mixes a block, and mixes the plugin's stereo output into the
  track's strip, so inserts, sends, mute/solo and the master apply as on any track.
- Plugin editors open in their own X11 windows (on Wayland the app runs through XWayland). The host
  implements the Linux `IRunLoop` on the GTK main loop.
- Plugin state is saved inside the song (`tracks[i].vst.st`, base64).

## Build and run

    nix build            # from the repository root
    ./result/bin/arranger-st

or `nix run`. The package wraps the binary with the libraries Linux plugin binaries usually link
to without bundling them (xcb-util, cairo, freetype, …), because a nix-built process does not see
the distribution's `/usr/lib`.

Development build: `nix develop` then `python3 build.py && cd native && cargo build --release`
(the binary needs the nix library paths at run time, so run it from the shell or use `nix build`).

## Plugins

Searched in `~/.vst3` (with subfolders), `/usr/lib/vst3`, `/usr/local/lib/vst3` and `$VST3_PATH`.
Only classes whose subcategories contain `Instrument` are offered.

u-he TyrellN6 (Linux): run its `install.sh`; it puts the plugin into `~/.u-he/TyrellN6` and links
the VST3 bundle into `~/.vst3/u-he/`.

`arranger-st --probe <bundle.vst3>` loads every instrument of a bundle without a window, plays a
chord and prints the level, load time and state size.

## Environment

- `ARRANGER_AUDIO=pipewire|pulseaudio|jack|alsa` picks the audio system.
- `ARRANGER_DEVTOOLS=1` enables the web inspector.
- `ARRANGER_EVAL=<file.js>` runs a script in the page two seconds after start (for tests); page
  errors and `{t:'log'}` IPC messages are printed to stderr.

The autosave and webview data live in `~/.local/share/arranger-st`.

## Limits

- No MIDI input (WebKitGTK has no Web MIDI).
- Plugin effects are not hosted, only instruments; one stereo output (the first bus) per plugin.
- Plugin parameters cannot be automated from the arranger.
