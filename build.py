#!/usr/bin/env python3
"""Build the single-file app: inlines the engine, ROM tables and Midiverb programs
into src/app.html and writes arranger-st.html (the distributable file)."""
import json, os, re
here = os.path.dirname(os.path.abspath(__file__))
src = lambda f: open(os.path.join(here, 'src', f), encoding='utf-8').read()
app = src('app.html')
eng = src('ds10_tables.js') + src('midiverb_fx.js') + src('engine.js')
assert '</script' not in eng
names = [json.loads(m) for m in re.findall(r'names:(\[.*?\]),fx:', src('midiverb_fx.js'))]
app = app.replace('@@ENGINE@@', eng).replace('@@MVNAMES@@', json.dumps(names))
assert '@@' not in app
out = os.path.join(here, 'arranger-st.html')
open(out, 'w', encoding='utf-8').write(app)
print(os.path.normpath(out), len(app), 'bytes')
