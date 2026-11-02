//! The browser build's AudioWorklet engine (`src/engine.js`), run unchanged in an embedded V8
//! isolate on the audio thread. A small glue script replaces the worklet's message port and
//! hands the engine the audio of the VST3 instrument tracks.

use std::ffi::c_void;

/// Largest block `render` accepts, in frames.
pub const MAX_BLOCK: usize = 4096;

/// Called by the engine once per block, before it mixes: render the VST3 tracks.
/// `ev` holds the note events of this block for VST tracks, 5 numbers each:
/// track, kind (1 on, 0 off, 2 all notes off), pitch, velocity, frame offset.
pub trait Host {
    fn ext(&mut self, n: usize, ev: &[f64], tempo: f64, out: &mut [f32]);
    fn post(&mut self, msg: String);
}

const GLUE: &str = r#"
globalThis.console = { log: (...a) => __log(a.join(' ')), warn: (...a) => __log(a.join(' ')), error: (...a) => __log(a.join(' ')) };
const __E = new Engine();
__E.post = m => __post(JSON.stringify(m));
const __OUT = new Float32Array(2 * MAXB);
const __L = __OUT.subarray(0, MAXB), __R = __OUT.subarray(MAXB);
const __XB = new Float32Array(16 * MAXB);
__E.tr.forEach((t, i) => { t.xl = __XB.subarray(2 * i * MAXB, (2 * i + 1) * MAXB); t.xr = __XB.subarray((2 * i + 1) * MAXB, (2 * i + 2) * MAXB); });
__E.extHook = (n, ev, tempo) => __ext(n, ev, tempo);
function __msg(s) { __E.msg(JSON.parse(s)); }
function __render(n, f0) { __E.render(__L, __R, n, f0); }
"#;

struct Ctx {
    host: *mut dyn Host,
    xb: *mut f32,
}

pub struct Js {
    isolate: v8::OwnedIsolate,
    context: v8::Global<v8::Context>,
    msg_fn: v8::Global<v8::Function>,
    render_fn: v8::Global<v8::Function>,
    out: *const f32,
    _stores: Vec<v8::SharedRef<v8::BackingStore>>,
    _ctx: Box<Ctx>,
}

fn init_v8() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

unsafe fn ctx_of(args: &v8::FunctionCallbackArguments) -> *mut Ctx {
    let ext: v8::Local<v8::External> = args.data().try_into().unwrap();
    ext.value() as *mut Ctx
}

fn cb_log(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let s = args.get(0).to_rust_string_lossy(scope);
    eprintln!("engine: {s}");
}

fn cb_post(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let s = args.get(0).to_rust_string_lossy(scope);
    unsafe { (*(*ctx_of(&args)).host).post(s) };
}

fn cb_ext(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let n = (args.get(0).number_value(scope).unwrap_or(0.0) as usize).min(MAX_BLOCK);
    let tempo = args.get(2).number_value(scope).unwrap_or(120.0);
    let mut ev = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..arr.length() {
            let v = arr.get_index(scope, i).and_then(|v| v.number_value(scope));
            ev.push(v.unwrap_or(0.0));
        }
    }
    unsafe {
        let c = ctx_of(&args);
        let out = std::slice::from_raw_parts_mut((*c).xb, 16 * MAX_BLOCK);
        (*(*c).host).ext(n, &ev, tempo, out);
    }
}

fn exception(tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>) -> String {
    match tc.exception() {
        Some(e) => {
            let msg = e.to_rust_string_lossy(tc);
            let stack = tc
                .stack_trace()
                .map(|s| s.to_rust_string_lossy(tc))
                .unwrap_or_default();
            format!("{msg}\n{stack}")
        }
        None => "unknown error".into(),
    }
}

impl Js {
    /// Compiles the engine. `host` must outlive the returned value.
    pub fn new(engine_src: &str, sample_rate: f64, host: *mut dyn Host) -> Result<Js, String> {
        init_v8();
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        let mut ctx = Box::new(Ctx {
            host,
            xb: std::ptr::null_mut(),
        });
        let ctx_ptr = &mut *ctx as *mut Ctx as *mut c_void;
        let (context, msg_fn, render_fn, out, stores);
        {
            v8::scope!(let hs, &mut isolate);
            let c = v8::Context::new(hs, Default::default());
            let scope = &mut v8::ContextScope::new(hs, c);
            let global = c.global(scope);
            let ext = v8::External::new(scope, ctx_ptr);
            macro_rules! native {
                ($name:expr, $f:expr) => {{
                    let func = v8::Function::builder($f)
                        .data(ext.into())
                        .build(scope)
                        .unwrap();
                    let key = v8::String::new(scope, $name).unwrap();
                    global.set(scope, key.into(), func.into());
                }};
            }
            native!("__log", cb_log);
            native!("__post", cb_post);
            native!("__ext", cb_ext);
            let src = format!(
                "globalThis.sampleRate = {sample_rate};\nconst MAXB = {MAX_BLOCK};\n{engine_src}\n{GLUE}"
            );
            v8::tc_scope!(let tc, scope);
            let code = v8::String::new(tc, &src).ok_or("engine source too large")?;
            let script = match v8::Script::compile(tc, code, None) {
                Some(s) => s,
                None => return Err(exception(tc)),
            };
            if script.run(tc).is_none() {
                return Err(exception(tc));
            }
            macro_rules! getf {
                ($name:expr) => {{
                    let key = v8::String::new(tc, $name).unwrap();
                    let v = c.global(tc).get(tc, key.into()).unwrap();
                    let f: v8::Local<v8::Function> = v.try_into().unwrap();
                    v8::Global::new(tc, f)
                }};
            }
            msg_fn = getf!("__msg");
            render_fn = getf!("__render");
            // const declarations are not properties of the global object: read them by evaluating
            macro_rules! eval {
                ($s:expr) => {{
                    let code = v8::String::new(tc, $s).unwrap();
                    let v = v8::Script::compile(tc, code, None)
                        .unwrap()
                        .run(tc)
                        .unwrap();
                    let a: v8::Local<v8::Float32Array> = v.try_into().unwrap();
                    let bs = a.buffer(tc).unwrap().get_backing_store();
                    let p = bs.data().unwrap().as_ptr() as *mut f32;
                    (p, bs)
                }};
            }
            let (o, s1) = eval!("__OUT");
            let (x, s2) = eval!("__XB");
            out = o as *const f32;
            ctx.xb = x;
            stores = vec![s1, s2];
            context = v8::Global::new(tc, c);
        }
        Ok(Js {
            isolate,
            context,
            msg_fn,
            render_fn,
            out,
            _stores: stores,
            _ctx: ctx,
        })
    }

    fn call(&mut self, f: &v8::Global<v8::Function>, args: Args) -> Result<(), String> {
        v8::scope!(let hs, &mut self.isolate);
        let c = v8::Local::new(hs, &self.context);
        let scope = &mut v8::ContextScope::new(hs, c);
        v8::tc_scope!(let tc, scope);
        let f = v8::Local::new(tc, f);
        let recv = v8::undefined(tc).into();
        let argv: Vec<v8::Local<v8::Value>> = match args {
            Args::Msg(s) => vec![v8::String::new(tc, s).unwrap().into()],
            Args::Render(n, f0) => vec![
                v8::Number::new(tc, n as f64).into(),
                v8::Number::new(tc, f0 as f64).into(),
            ],
        };
        if f.call(tc, recv, &argv).is_none() {
            return Err(exception(tc));
        }
        Ok(())
    }

    /// Delivers one message of the page's worklet protocol (JSON).
    pub fn msg(&mut self, json: &str) -> Result<(), String> {
        let f = self.msg_fn.clone();
        self.call(&f, Args::Msg(json))
    }

    /// Renders `n` frames starting at frame `f0`; returns the left and right outputs.
    pub fn render(&mut self, n: usize, f0: u64) -> Result<(&[f32], &[f32]), String> {
        let n = n.min(MAX_BLOCK);
        let f = self.render_fn.clone();
        self.call(&f, Args::Render(n, f0))?;
        unsafe {
            Ok((
                std::slice::from_raw_parts(self.out, n),
                std::slice::from_raw_parts(self.out.add(MAX_BLOCK), n),
            ))
        }
    }
}

enum Args<'a> {
    Msg(&'a str),
    Render(usize, u64),
}
