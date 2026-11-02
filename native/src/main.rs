//! Arranger ST desktop app: the page in a WebKitGTK window, its audio engine in V8 on the native
//! audio thread, and VST3 instruments on tracks.

mod audio;
mod js;
mod vst;

use std::borrow::Cow;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use gtk::prelude::*;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde_json::{json, Value};
use tao::dpi::{LogicalSize, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget};
use tao::platform::unix::WindowExtUnix;
use tao::window::{Window, WindowBuilder};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtUnix};

const PAGE: &str = include_str!("../../arranger-st.html");
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

enum UserEvent {
    Ipc(String),
}

/// The worklet source embedded in the page (`<script type="text/plain" id="wk">`).
fn engine_source(page: &str) -> String {
    let tag = "<script type=\"text/plain\" id=\"wk\">";
    let a = page.find(tag).expect("engine script missing from the page") + tag.len();
    let n = page[a..].find("</script>").unwrap();
    page[a..a + n].to_string()
}

fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
        });
    base.join("arranger-st")
}

struct App {
    window: Window,
    webview: WebView,
    cmd: rtrb::Producer<audio::Cmd>,
    out: rtrb::Consumer<audio::Out>,
    clock: Option<std::sync::Arc<audio::Clock>>,
    audio_err: Option<String>,
    modules: vst::Modules,
    plugins: Option<Vec<vst::PluginInfo>>,
    inst: [Option<vst::Instance>; 8],
    dying: Vec<vst::Instance>,
    pending: Vec<String>,
}

impl App {
    fn send(&mut self, v: Value) {
        self.pending.push(v.to_string());
    }

    fn flush(&mut self) {
        if let Some(c) = &self.clock {
            if c.running.load(std::sync::atomic::Ordering::Acquire) {
                let lat =
                    c.latency.load(std::sync::atomic::Ordering::Relaxed) as f64 / c.sample_rate;
                self.pending.push(
                    json!({"t": "clk", "f": c.now_frames(), "sr": c.sample_rate, "lat": lat})
                        .to_string(),
                );
            }
        }
        if self.pending.is_empty() {
            return;
        }
        let js = format!("window.__nat&&window.__nat([{}])", self.pending.join(","));
        self.pending.clear();
        let _ = self.webview.evaluate_script(&js);
    }

    /// Messages from the audio thread, released instruments, plugin edits.
    fn pump(&mut self) {
        while let Ok(o) = self.out.pop() {
            match o {
                audio::Out::Post(s) => self.pending.push(format!(r#"{{"t":"eng","m":{s}}}"#)),
                audio::Out::Release(p) => {
                    self.dying.retain(|i| !std::sync::Arc::ptr_eq(&i.proc, &p));
                }
                audio::Out::Error(e) => {
                    eprintln!("engine error: {e}");
                    self.send(json!({"t": "err", "msg": e}));
                }
            }
        }
        for t in 0..8 {
            if let Some(i) = &self.inst[t] {
                if i.dirty.swap(false, std::sync::atomic::Ordering::Relaxed) {
                    self.send(json!({"t": "vst-dirty", "tr": t}));
                }
            }
        }
        self.flush();
    }

    fn set_slot(&mut self, t: usize, i: Option<vst::Instance>) {
        let p = i.as_ref().map(|i| i.proc.clone());
        let audio_alive = self.clock.is_some();
        if let Some(old) = std::mem::replace(&mut self.inst[t], i) {
            if audio_alive {
                self.dying.push(old); // dropped once the audio thread hands its processor back
            }
        }
        if audio_alive {
            while self.cmd.push(audio::Cmd::Slot(t, p.clone())).is_err() {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }

    fn ipc(&mut self, s: &str, target: &EventLoopWindowTarget<UserEvent>) {
        let Ok(m) = serde_json::from_str::<Value>(s) else {
            return;
        };
        let n = self.pending.len();
        self.ipc_msg(&m, target);
        // replies carry the request's id, so the page can match them to its promise
        if m["id"].is_number() {
            for r in &mut self.pending[n..] {
                if let Ok(mut v) = serde_json::from_str::<Value>(r) {
                    v["id"] = m["id"].clone();
                    *r = v.to_string();
                }
            }
        }
        self.flush();
    }

    fn ipc_msg(&mut self, m: &Value, target: &EventLoopWindowTarget<UserEvent>) {
        let tr = m["tr"].as_u64().unwrap_or(99) as usize;
        match m["t"].as_str().unwrap_or("") {
            "eng" => {
                if self.clock.is_some() {
                    let _ = self.cmd.push(audio::Cmd::Msg(m["m"].to_string()));
                }
            }
            "hello" => {
                let sr = self.clock.as_ref().map(|c| c.sample_rate);
                let err = self.audio_err.clone();
                self.send(json!({"t": "hello", "sr": sr, "err": err}));
            }
            "vst-list" => {
                if self.plugins.is_none() || m["rescan"].as_bool() == Some(true) {
                    self.plugins = Some(self.modules.scan());
                }
                let list = self.plugins.clone().unwrap_or_default();
                self.send(json!({"t": "vst-list", "list": list}));
            }
            "vst-load" if tr < 8 => {
                let sr = self.clock.as_ref().map_or(48000.0, |c| c.sample_rate);
                let dec = |k: &str| m[k].as_str().and_then(|s| B64.decode(s).ok());
                let (st, ct) = (dec("st"), dec("ct"));
                let path = m["path"].as_str().unwrap_or("");
                let cid = m["cid"].as_str().unwrap_or("");
                self.set_slot(tr, None);
                match vst::Instance::new(
                    &mut self.modules,
                    path,
                    cid,
                    sr,
                    st.as_deref(),
                    ct.as_deref(),
                ) {
                    Ok(i) => {
                        let reply = json!({"t": "vst-loaded", "tr": tr, "ok": true, "name": i.info.name, "vendor": i.info.vendor, "editor": i.has_editor()});
                        self.set_slot(tr, Some(i));
                        self.send(reply);
                    }
                    Err(e) => {
                        self.send(json!({"t": "vst-loaded", "tr": tr, "ok": false, "err": e}))
                    }
                }
            }
            "vst-unload" if tr < 8 => self.set_slot(tr, None),
            "vst-state" if tr < 8 => {
                if let Some(i) = &self.inst[tr] {
                    let (st, ct) = i.state();
                    self.send(json!({"t": "vst-state", "tr": tr, "st": B64.encode(st), "ct": ct.map(|c| B64.encode(c))}));
                } else {
                    self.send(json!({"t": "vst-state", "tr": tr, "st": null}));
                }
            }
            "vst-edit" if tr < 8 => {
                let r = self.toggle_editor(tr, target);
                let open = self.inst[tr].as_ref().is_some_and(|i| i.editor.is_some());
                self.send(json!({"t": "vst-edit", "tr": tr, "open": open, "err": r.err()}));
            }
            "save" => {
                let r = save_dialog(
                    &self.window,
                    m["name"].as_str().unwrap_or("song.json"),
                    m["data"].as_str().unwrap_or(""),
                );
                self.send(json!({"t": "saved", "file": r.as_ref().ok(), "err": r.err()}));
            }
            "log" => eprintln!("page: {}", m["s"].as_str().unwrap_or("")),
            "title" => self
                .window
                .set_title(m["s"].as_str().unwrap_or("Arranger ST")),
            _ => {}
        }
    }

    fn toggle_editor(
        &mut self,
        tr: usize,
        target: &EventLoopWindowTarget<UserEvent>,
    ) -> Result<(), String> {
        let i = self.inst[tr].as_mut().ok_or("no plugin on this track")?;
        if i.editor.take().is_some() {
            return Ok(());
        }
        let (view, (w, h)) = i.create_view()?;
        let window = WindowBuilder::new()
            .with_title(format!("T{} {}", tr + 1, i.info.name))
            .with_inner_size(PhysicalSize::new(w as u32, h as u32))
            .with_resizable(false)
            .build(target)
            .map_err(|e| e.to_string())?;
        let xid = match window.window_handle().map_err(|e| e.to_string())?.as_raw() {
            RawWindowHandle::Xlib(h) => h.window as u64,
            RawWindowHandle::Xcb(h) => h.window.get() as u64,
            _ => return Err("plugin editors need X11 (run with GDK_BACKEND=x11)".into()),
        };
        i.editor = Some(vst::Editor::open(view, Rc::new(window), xid)?);
        Ok(())
    }
}

fn save_dialog(parent: &Window, name: &str, data: &str) -> Result<String, String> {
    let d = gtk::FileChooserDialog::with_buttons(
        Some("Save song"),
        Some(parent.gtk_window()),
        gtk::FileChooserAction::Save,
        &[
            ("Cancel", gtk::ResponseType::Cancel),
            ("Save", gtk::ResponseType::Accept),
        ],
    );
    d.set_do_overwrite_confirmation(true);
    d.set_current_name(name);
    let f = gtk::FileFilter::new();
    f.add_pattern("*.json");
    f.set_name(Some("Arranger ST songs"));
    d.add_filter(f);
    let r = d.run();
    let path = d.filename();
    d.close();
    match (r, path) {
        (gtk::ResponseType::Accept, Some(p)) => {
            std::fs::write(&p, data).map_err(|e| e.to_string())?;
            Ok(p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default())
        }
        _ => Err("cancelled".into()),
    }
}

/// `--probe <bundle.vst3>`: load each instrument in the bundle, play a chord and report the level.
fn probe(path: &str) {
    let mut modules = vst::Modules::default();
    let m = modules
        .get(std::path::Path::new(path))
        .unwrap_or_else(|e| panic!("{e}"));
    for c in m.classes(std::path::Path::new(path)) {
        println!(
            "{} / {} ({}) instrument={}",
            c.name, c.vendor, c.cid, c.instrument
        );
        let t = Instant::now();
        let i = match vst::Instance::new(&mut modules, path, &c.cid, 48000.0, None, None) {
            Ok(i) => i,
            Err(e) => {
                println!("  load failed: {e}");
                continue;
            }
        };
        println!("  loaded in {:?}", t.elapsed());
        let mut ctx: vst3::Steinberg::Vst::ProcessContext = unsafe { std::mem::zeroed() };
        ctx.sampleRate = 48000.0;
        ctx.tempo = 120.0;
        let (mut l, mut r) = (vec![0f32; 256], vec![0f32; 256]);
        let (mut peak, mut sum, mut n) = (0f32, 0f64, 0usize);
        let t = Instant::now();
        for b in 0..375 {
            let ev: Vec<(u8, u8, u8, u32)> = match b {
                0 => vec![(1, 48, 100, 0), (1, 55, 100, 0), (1, 60, 100, 10)],
                250 => vec![(2, 0, 0, 0)],
                _ => vec![],
            };
            i.proc.process(256, &ev, &mut ctx, &mut l, &mut r);
            for k in 0..256 {
                peak = peak.max(l[k].abs()).max(r[k].abs());
                sum += (l[k] as f64).powi(2);
                n += 1;
            }
        }
        println!(
            "  2 s rendered in {:?}: peak {peak:.3}, rms {:.4}",
            t.elapsed(),
            (sum / n as f64).sqrt()
        );
        let (st, ct) = i.state();
        println!(
            "  state {} bytes, controller state {:?} bytes, editor {}",
            st.len(),
            ct.map(|c| c.len()),
            i.has_editor()
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--probe" {
        return probe(&args[2]);
    }
    // plugin editors embed into X11 windows; under Wayland run the whole app through XWayland
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // WebKit's DMA-BUF renderer fails on some drivers and under XWayland; the page is a 2D canvas anyway
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let (clock, audio, audio_err, cmd_tx, out_rx) = match audio::start(engine_source(PAGE)) {
        Ok((a, c, o)) => (Some(a.clock.clone()), Some(a), None, c, o),
        Err(e) => {
            eprintln!("audio: {e}");
            let (c, _) = rtrb::RingBuffer::new(1);
            let (_, o) = rtrb::RingBuffer::new(1);
            (None, None, Some(e), c, o)
        }
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Arranger ST")
        .with_inner_size(LogicalSize::new(1100.0, 820.0))
        .with_min_inner_size(LogicalSize::new(660.0, 520.0))
        .build(&event_loop)
        .expect("cannot open a window");

    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut ctx = WebContext::new(Some(dir.join("webview")));
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_custom_protocol("arranger".into(), |_id, _req| {
            http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(Cow::Borrowed(PAGE.as_bytes()))
                .unwrap()
        })
        .with_url("arranger://app/index.html")
        .with_ipc_handler(move |req| {
            let _ = proxy.send_event(UserEvent::Ipc(req.into_body()));
        })
        .with_devtools(std::env::var_os("ARRANGER_DEVTOOLS").is_some())
        .with_initialization_script(if std::env::var_os("ARRANGER_EVAL").is_some() {
            "window.addEventListener('error',e=>window.ipc.postMessage(JSON.stringify({t:'log',s:'page error: '+e.message+' @'+e.lineno+':'+e.colno})));"
        } else {
            ""
        })
        .build_gtk(window.default_vbox().unwrap())
        .expect("cannot create the web view");

    let mut app = App {
        window,
        webview,
        cmd: cmd_tx,
        out: out_rx,
        clock,
        audio_err,
        modules: vst::Modules::default(),
        plugins: None,
        inst: Default::default(),
        dying: Vec::new(),
        pending: Vec::new(),
    };
    let mut audio = audio;
    // development: ARRANGER_EVAL=<file.js> runs a script in the page two seconds after start
    let mut eval = std::env::var_os("ARRANGER_EVAL").map(|p| {
        (
            Instant::now() + Duration::from_secs(2),
            std::fs::read_to_string(p).unwrap_or_default(),
        )
    });

    event_loop.run(move |event, target, flow| {
        match event {
            Event::NewEvents(StartCause::Init)
            | Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                app.pump();
                if eval.as_ref().is_some_and(|(t, _)| Instant::now() >= *t) {
                    let _ = app.webview.evaluate_script(&eval.take().unwrap().1);
                }
                *flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(15));
            }
            Event::UserEvent(UserEvent::Ipc(s)) => app.ipc(&s, target),
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if window_id == app.window.id() {
                    for t in 0..8 {
                        if let Some(i) = app.inst[t].as_mut() {
                            i.editor = None;
                        }
                    }
                    drop(audio.take()); // stop the stream before the instruments go
                    app.inst = Default::default();
                    app.dying.clear();
                    *flow = ControlFlow::Exit;
                } else {
                    for t in 0..8 {
                        if let Some(i) = app.inst[t].as_mut() {
                            if i.editor.as_ref().is_some_and(|e| e.window_id == window_id) {
                                i.editor = None;
                                app.send(json!({"t": "vst-edit", "tr": t, "open": false}));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    });
}
