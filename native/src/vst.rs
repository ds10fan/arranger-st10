//! A small VST3 host: finds instrument plugins, instantiates them, feeds them notes and parameter
//! edits on the audio thread and shows their editors in X11 windows.

use std::cell::{RefCell, UnsafeCell};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};
use std::ptr;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use vst3::Steinberg::Linux::*;
use vst3::Steinberg::Vst::IAttributeList_::AttrID;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComRef, ComWrapper, Interface};

use crate::js::MAX_BLOCK;

const CHUNK: usize = MAX_BLOCK;

// ---------------------------------------------------------------- strings

fn cstr(b: &[c_char]) -> String {
    let bytes: Vec<u8> = b
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn set_wstr(s: &str, dst: &mut [TChar]) {
    let mut i = 0;
    for c in s.encode_utf16() {
        if i + 1 >= dst.len() {
            break;
        }
        dst[i] = c as TChar;
        i += 1;
    }
    dst[i] = 0;
}

pub fn cid_hex(cid: &TUID) -> String {
    cid.iter().map(|b| format!("{:02X}", *b as u8)).collect()
}

fn cid_parse(s: &str) -> Option<TUID> {
    if s.len() != 32 {
        return None;
    }
    let mut t: TUID = [0; 16];
    for i in 0..16 {
        t[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()? as c_char;
    }
    Some(t)
}

fn iid_eq(a: *const TUID, b: &[u8; 16]) -> bool {
    !a.is_null() && unsafe { (*a).iter().zip(b.iter()).all(|(x, y)| *x as u8 == *y) }
}

// ---------------------------------------------------------------- modules

// fields drop in order: the factory is released before the library is closed
pub struct Module {
    factory: ComPtr<IPluginFactory>,
    _lib: libloading::os::unix::Library,
}

/// The shared object inside a `.vst3` bundle (or a bare `.so`).
fn binary_of(bundle: &Path) -> Option<PathBuf> {
    if bundle.is_file() {
        return Some(bundle.to_path_buf());
    }
    let dir = bundle
        .join("Contents")
        .join(format!("{}-linux", std::env::consts::ARCH));
    let stem = bundle.file_stem()?.to_string_lossy().into_owned();
    let p = dir.join(format!("{stem}.so"));
    if p.exists() {
        return Some(p);
    }
    std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "so"))
}

impl Module {
    pub fn load(bundle: &Path) -> Result<Module, String> {
        let so =
            binary_of(bundle).ok_or_else(|| format!("no Linux binary in {}", bundle.display()))?;
        unsafe {
            let lib = libloading::os::unix::Library::open(Some(&so), libc_rtld_now_local())
                .map_err(|e| format!("{}: {e}", so.display()))?;
            if let Ok(entry) = lib.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"ModuleEntry")
            {
                // ModuleEntry wants the dlopen handle; dlopen again to get it (reference counted)
                let raw = libloading::os::unix::Library::open(Some(&so), libc_rtld_now_local())
                    .unwrap()
                    .into_raw();
                if !entry(raw) {
                    return Err("ModuleEntry failed".into());
                }
            }
            let get: libloading::os::unix::Symbol<unsafe extern "C" fn() -> *mut IPluginFactory> =
                lib.get(b"GetPluginFactory")
                    .map_err(|e| format!("not a VST3 plugin: {e}"))?;
            let factory = ComPtr::from_raw(get()).ok_or("GetPluginFactory returned null")?;
            Ok(Module { factory, _lib: lib })
        }
    }

    pub fn classes(&self, path: &Path) -> Vec<PluginInfo> {
        let mut out = Vec::new();
        unsafe {
            let f = &self.factory;
            let f2 = f.cast::<IPluginFactory2>();
            let mut fi: PFactoryInfo = std::mem::zeroed();
            f.getFactoryInfo(&mut fi);
            let fvendor = cstr(&fi.vendor);
            for i in 0..f.countClasses() {
                let mut ci: PClassInfo = std::mem::zeroed();
                if f.getClassInfo(i, &mut ci) != kResultOk
                    || cstr(&ci.category) != "Audio Module Class"
                {
                    continue;
                }
                let (mut sub, mut vendor) = (String::new(), fvendor.clone());
                if let Some(f2) = &f2 {
                    let mut c2: PClassInfo2 = std::mem::zeroed();
                    if f2.getClassInfo2(i, &mut c2) == kResultOk {
                        sub = cstr(&c2.subCategories);
                        let v = cstr(&c2.vendor);
                        if !v.is_empty() {
                            vendor = v;
                        }
                    }
                }
                out.push(PluginInfo {
                    path: path.to_string_lossy().into_owned(),
                    cid: cid_hex(&ci.cid),
                    name: cstr(&ci.name),
                    vendor,
                    instrument: sub.contains("Instrument"),
                });
            }
        }
        out
    }
}

fn libc_rtld_now_local() -> std::ffi::c_int {
    libloading::os::unix::RTLD_NOW | libloading::os::unix::RTLD_LOCAL
}

#[derive(Clone, serde::Serialize)]
pub struct PluginInfo {
    pub path: String,
    pub cid: String,
    pub name: String,
    pub vendor: String,
    pub instrument: bool,
}

/// Loaded modules, kept for the life of the app (unloading u-he style plugins is not worth the risk).
#[derive(Default)]
pub struct Modules {
    map: HashMap<PathBuf, Rc<Module>>,
}

impl Modules {
    pub fn get(&mut self, bundle: &Path) -> Result<Rc<Module>, String> {
        if let Some(m) = self.map.get(bundle) {
            return Ok(m.clone());
        }
        let m = Rc::new(Module::load(bundle)?);
        self.map.insert(bundle.to_path_buf(), m.clone());
        Ok(m)
    }

    /// Search the standard VST3 folders (and $VST3_PATH) for plugins.
    pub fn scan(&mut self) -> Vec<PluginInfo> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Ok(p) = std::env::var("VST3_PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
        if let Some(h) = std::env::var_os("HOME") {
            dirs.push(Path::new(&h).join(".vst3"));
        }
        dirs.push("/usr/lib/vst3".into());
        dirs.push("/usr/local/lib/vst3".into());
        let mut bundles = Vec::new();
        for d in dirs {
            find_bundles(&d, 0, &mut bundles);
        }
        bundles.sort();
        bundles.dedup();
        let mut out = Vec::new();
        for b in bundles {
            match self.get(&b) {
                Ok(m) => out.extend(m.classes(&b)),
                Err(e) => eprintln!("vst3: {e}"),
            }
        }
        out
    }
}

fn find_bundles(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "vst3") {
            out.push(p);
        } else if depth < 4 && p.is_dir() {
            find_bundles(&p, depth + 1, out);
        }
    }
}

// ---------------------------------------------------------------- host objects

struct HostApp;
impl Class for HostApp {
    type Interfaces = (IHostApplication,);
}
impl IHostApplicationTrait for HostApp {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        set_wstr("Arranger ST", &mut *name);
        kResultOk
    }
    unsafe fn createInstance(
        &self,
        cid: *mut TUID,
        iid: *mut TUID,
        obj: *mut *mut c_void,
    ) -> tresult {
        let want_msg = iid_eq(cid, &IMessage::IID) || iid_eq(iid, &IMessage::IID);
        let want_attr = iid_eq(cid, &IAttributeList::IID) || iid_eq(iid, &IAttributeList::IID);
        if want_msg {
            let m = ComWrapper::new(Message::default());
            *obj = m.to_com_ptr::<IMessage>().unwrap().into_raw() as *mut c_void;
            return kResultOk;
        }
        if want_attr {
            let a = ComWrapper::new(Attributes::default());
            *obj = a.to_com_ptr::<IAttributeList>().unwrap().into_raw() as *mut c_void;
            return kResultOk;
        }
        *obj = ptr::null_mut();
        kNoInterface
    }
}

#[derive(Default)]
struct Message {
    id: Mutex<Option<std::ffi::CString>>,
    attrs: Mutex<Option<ComPtr<IAttributeList>>>,
}
unsafe impl Send for Message {}
unsafe impl Sync for Message {}
impl Class for Message {
    type Interfaces = (IMessage,);
}
impl IMessageTrait for Message {
    unsafe fn getMessageID(&self) -> FIDString {
        self.id
            .lock()
            .unwrap()
            .as_ref()
            .map_or(ptr::null(), |s| s.as_ptr())
    }
    unsafe fn setMessageID(&self, id: FIDString) {
        *self.id.lock().unwrap() = (!id.is_null()).then(|| CStr::from_ptr(id).to_owned());
    }
    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        let mut a = self.attrs.lock().unwrap();
        if a.is_none() {
            *a = ComWrapper::new(Attributes::default()).to_com_ptr::<IAttributeList>();
        }
        a.as_ref().unwrap().as_ptr()
    }
}

enum Attr {
    Int(i64),
    Float(f64),
    Str(Vec<TChar>),
    Bin(Vec<u8>),
}

#[derive(Default)]
struct Attributes {
    map: Mutex<HashMap<Vec<u8>, Attr>>,
}
impl Class for Attributes {
    type Interfaces = (IAttributeList,);
}
unsafe fn key(id: AttrID) -> Vec<u8> {
    if id.is_null() {
        Vec::new()
    } else {
        CStr::from_ptr(id).to_bytes().to_vec()
    }
}
impl IAttributeListTrait for Attributes {
    unsafe fn setInt(&self, id: AttrID, v: int64) -> tresult {
        self.map.lock().unwrap().insert(key(id), Attr::Int(v));
        kResultOk
    }
    unsafe fn getInt(&self, id: AttrID, v: *mut int64) -> tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Int(x)) => {
                *v = *x;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: AttrID, v: f64) -> tresult {
        self.map.lock().unwrap().insert(key(id), Attr::Float(v));
        kResultOk
    }
    unsafe fn getFloat(&self, id: AttrID, v: *mut f64) -> tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Float(x)) => {
                *v = *x;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setString(&self, id: AttrID, s: *const TChar) -> tresult {
        let mut v = Vec::new();
        let mut p = s;
        while !p.is_null() && *p != 0 {
            v.push(*p);
            p = p.add(1);
        }
        v.push(0);
        self.map.lock().unwrap().insert(key(id), Attr::Str(v));
        kResultOk
    }
    unsafe fn getString(&self, id: AttrID, s: *mut TChar, size: uint32) -> tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Str(x)) => {
                let n = (size as usize / std::mem::size_of::<TChar>()).min(x.len());
                if n == 0 {
                    return kResultFalse;
                }
                ptr::copy_nonoverlapping(x.as_ptr(), s, n);
                *s.add(n - 1) = 0;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setBinary(&self, id: AttrID, d: *const c_void, size: uint32) -> tresult {
        let v = std::slice::from_raw_parts(d as *const u8, size as usize).to_vec();
        self.map.lock().unwrap().insert(key(id), Attr::Bin(v));
        kResultOk
    }
    unsafe fn getBinary(&self, id: AttrID, d: *mut *const c_void, size: *mut uint32) -> tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Bin(x)) => {
                // the data stays valid while the attribute list lives and the key is not overwritten
                *d = x.as_ptr() as *const c_void;
                *size = x.len() as uint32;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
}

/// An in-memory IBStream for plugin state.
#[derive(Default)]
pub struct Stream {
    data: Mutex<(Vec<u8>, usize)>,
}
impl Class for Stream {
    type Interfaces = (IBStream,);
}
impl Stream {
    fn new(data: Vec<u8>) -> ComWrapper<Stream> {
        ComWrapper::new(Stream {
            data: Mutex::new((data, 0)),
        })
    }
}
impl IBStreamTrait for Stream {
    unsafe fn read(&self, buf: *mut c_void, n: int32, read: *mut int32) -> tresult {
        let mut d = self.data.lock().unwrap();
        let (v, pos) = &mut *d;
        let k = (n.max(0) as usize).min(v.len().saturating_sub(*pos));
        ptr::copy_nonoverlapping(v.as_ptr().add(*pos), buf as *mut u8, k);
        *pos += k;
        if !read.is_null() {
            *read = k as int32;
        }
        kResultOk
    }
    unsafe fn write(&self, buf: *mut c_void, n: int32, written: *mut int32) -> tresult {
        let mut d = self.data.lock().unwrap();
        let (v, pos) = &mut *d;
        let n = n.max(0) as usize;
        if v.len() < *pos + n {
            v.resize(*pos + n, 0);
        }
        ptr::copy_nonoverlapping(buf as *const u8, v.as_mut_ptr().add(*pos), n);
        *pos += n;
        if !written.is_null() {
            *written = n as int32;
        }
        kResultOk
    }
    unsafe fn seek(&self, p: int64, mode: int32, result: *mut int64) -> tresult {
        let mut d = self.data.lock().unwrap();
        let (v, pos) = &mut *d;
        let base = match mode as u32 {
            IBStream_::IStreamSeekMode_::kIBSeekSet => 0,
            IBStream_::IStreamSeekMode_::kIBSeekCur => *pos as i64,
            _ => v.len() as i64,
        };
        *pos = (base + p).clamp(0, v.len() as i64) as usize;
        if !result.is_null() {
            *result = *pos as int64;
        }
        kResultOk
    }
    unsafe fn tell(&self, p: *mut int64) -> tresult {
        if !p.is_null() {
            *p = self.data.lock().unwrap().1 as int64;
        }
        kResultOk
    }
}

/// Receives parameter edits from the plugin's editor and forwards them to the processor.
struct Handler {
    proc: Arc<Proc>,
    dirty: Arc<std::sync::atomic::AtomicBool>,
}
impl Class for Handler {
    type Interfaces = (IComponentHandler,);
}
impl IComponentHandlerTrait for Handler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn performEdit(&self, id: ParamID, v: ParamValue) -> tresult {
        self.proc.edits.lock().unwrap().push((id, v));
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        kResultOk
    }
    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn restartComponent(&self, _flags: int32) -> tresult {
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        kResultOk
    }
}

// ---------------------------------------------------------------- audio-thread side

struct EventList {
    ev: UnsafeCell<Vec<Event>>,
}
impl Class for EventList {
    type Interfaces = (IEventList,);
}
impl IEventListTrait for EventList {
    unsafe fn getEventCount(&self) -> int32 {
        (&*self.ev.get()).len() as int32
    }
    unsafe fn getEvent(&self, i: int32, e: *mut Event) -> tresult {
        match (&*self.ev.get()).get(i as usize) {
            Some(x) => {
                *e = *x;
                kResultOk
            }
            None => kInvalidArgument,
        }
    }
    unsafe fn addEvent(&self, _e: *mut Event) -> tresult {
        kResultFalse
    }
}

struct ParamQueue {
    id: UnsafeCell<ParamID>,
    pts: UnsafeCell<Vec<(int32, ParamValue)>>,
}
impl Class for ParamQueue {
    type Interfaces = (IParamValueQueue,);
}
impl IParamValueQueueTrait for ParamQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        *self.id.get()
    }
    unsafe fn getPointCount(&self) -> int32 {
        (&*self.pts.get()).len() as int32
    }
    unsafe fn getPoint(&self, i: int32, off: *mut int32, v: *mut ParamValue) -> tresult {
        match (&*self.pts.get()).get(i as usize) {
            Some(&(o, x)) => {
                *off = o;
                *v = x;
                kResultOk
            }
            None => kInvalidArgument,
        }
    }
    unsafe fn addPoint(&self, _off: int32, _v: ParamValue, _i: *mut int32) -> tresult {
        kResultFalse
    }
}

struct ParamChanges {
    queues: Vec<ComWrapper<ParamQueue>>,
    used: UnsafeCell<usize>,
}
impl Class for ParamChanges {
    type Interfaces = (IParameterChanges,);
}
impl IParameterChangesTrait for ParamChanges {
    unsafe fn getParameterCount(&self) -> int32 {
        *self.used.get() as int32
    }
    unsafe fn getParameterData(&self, i: int32) -> *mut IParamValueQueue {
        if (i as usize) < *self.used.get() {
            self.queues[i as usize]
                .as_com_ref::<IParamValueQueue>()
                .unwrap()
                .as_ptr()
        } else {
            ptr::null_mut()
        }
    }
    unsafe fn addParameterData(
        &self,
        _id: *const ParamID,
        _i: *mut int32,
    ) -> *mut IParamValueQueue {
        ptr::null_mut()
    }
}

/// The part of a plugin instance the audio thread uses.
pub struct Proc {
    processor: ComPtr<IAudioProcessor>,
    edits: Mutex<Vec<(ParamID, ParamValue)>>,
    events: ComWrapper<EventList>,
    params: ComWrapper<ParamChanges>,
    ins: Vec<i32>,
    outs: Vec<i32>,
    bufs: UnsafeCell<Vec<Vec<f32>>>,
    held: UnsafeCell<[bool; 128]>,
}
unsafe impl Send for Proc {}
unsafe impl Sync for Proc {}

impl Proc {
    /// Audio thread only. `ev`: (kind 1 on / 0 off / 2 all off, pitch, velocity, offset).
    pub fn process(
        &self,
        n: usize,
        ev: &[(u8, u8, u8, u32)],
        ctx: &mut ProcessContext,
        l: &mut [f32],
        r: &mut [f32],
    ) {
        unsafe {
            let list = &mut *self.events.ev.get();
            list.clear();
            let held = &mut *self.held.get();
            let note = |on: bool, p: u8, v: u8, off: u32| {
                let mut e: Event = std::mem::zeroed();
                e.sampleOffset = off as i32;
                if on {
                    e.r#type = Event_::EventTypes_::kNoteOnEvent as u16;
                    e.__field0.noteOn = NoteOnEvent {
                        channel: 0,
                        pitch: p as i16,
                        tuning: 0.0,
                        velocity: v as f32 / 127.0,
                        length: 0,
                        noteId: -1,
                    };
                } else {
                    e.r#type = Event_::EventTypes_::kNoteOffEvent as u16;
                    e.__field0.noteOff = NoteOffEvent {
                        channel: 0,
                        pitch: p as i16,
                        velocity: 0.0,
                        noteId: -1,
                        tuning: 0.0,
                    };
                }
                e
            };
            for &(k, p, v, off) in ev {
                let off = off.min(n as u32 - 1);
                match k {
                    1 => {
                        held[p as usize & 127] = true;
                        list.push(note(true, p, v, off));
                    }
                    0 => {
                        held[p as usize & 127] = false;
                        list.push(note(false, p, 0, off));
                    }
                    _ => {
                        for (i, h) in held.iter_mut().enumerate() {
                            if *h {
                                *h = false;
                                list.push(note(false, i as u8, 0, off));
                            }
                        }
                    }
                }
            }
            list.sort_by_key(|e| e.sampleOffset);

            *self.params.used.get() = 0;
            if let Ok(mut edits) = self.edits.try_lock() {
                for (id, v) in edits.drain(..) {
                    let used = &mut *self.params.used.get();
                    let qs = &self.params.queues;
                    let q = match (0..*used).find(|&i| *qs[i].id.get() == id) {
                        Some(i) => &qs[i],
                        None if *used < qs.len() => {
                            let q = &qs[*used];
                            *q.id.get() = id;
                            (*q.pts.get()).clear();
                            *used += 1;
                            q
                        }
                        None => continue,
                    };
                    let pts = &mut *q.pts.get();
                    pts.clear(); // only the latest value matters within a block
                    pts.push((0, v));
                }
            }

            let bufs = &mut *self.bufs.get();
            let nch: usize = self
                .ins
                .iter()
                .chain(self.outs.iter())
                .map(|&c| c as usize)
                .sum();
            let mut ptrs: Vec<*mut f32> = Vec::with_capacity(nch);
            for b in bufs.iter_mut().take(nch) {
                b[..n].fill(0.0);
                ptrs.push(b.as_mut_ptr());
            }
            let mut buses = Vec::with_capacity(self.ins.len() + self.outs.len());
            let mut k = 0;
            for &c in self.ins.iter().chain(self.outs.iter()) {
                buses.push(AudioBusBuffers {
                    numChannels: c,
                    silenceFlags: 0,
                    __field0: AudioBusBuffers__type0 {
                        channelBuffers32: ptrs.as_mut_ptr().add(k),
                    },
                });
                k += c as usize;
            }
            let (inb, outb) = buses.split_at_mut(self.ins.len());
            let mut data = ProcessData {
                processMode: ProcessModes_::kRealtime as i32,
                symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
                numSamples: n as i32,
                numInputs: inb.len() as i32,
                numOutputs: outb.len() as i32,
                inputs: if inb.is_empty() {
                    ptr::null_mut()
                } else {
                    inb.as_mut_ptr()
                },
                outputs: if outb.is_empty() {
                    ptr::null_mut()
                } else {
                    outb.as_mut_ptr()
                },
                inputParameterChanges: self
                    .params
                    .as_com_ref::<IParameterChanges>()
                    .unwrap()
                    .as_ptr(),
                outputParameterChanges: ptr::null_mut(),
                inputEvents: self.events.as_com_ref::<IEventList>().unwrap().as_ptr(),
                outputEvents: ptr::null_mut(),
                processContext: ctx,
            };
            self.processor.process(&mut data);
            // first output bus: mono goes to both sides
            let first: usize = self.ins.iter().map(|&c| c as usize).sum();
            match self.outs.first().copied().unwrap_or(0) {
                0 => {
                    l[..n].fill(0.0);
                    r[..n].fill(0.0);
                }
                1 => {
                    l[..n].copy_from_slice(&bufs[first][..n]);
                    r[..n].copy_from_slice(&bufs[first][..n]);
                }
                _ => {
                    l[..n].copy_from_slice(&bufs[first][..n]);
                    r[..n].copy_from_slice(&bufs[first + 1][..n]);
                }
            }
        }
    }
}

// ---------------------------------------------------------------- instances (main thread)

pub struct Instance {
    _module: Rc<Module>,
    pub info: PluginInfo,
    component: ComPtr<IComponent>,
    controller: Option<ComPtr<IEditController>>,
    separate: bool,
    _host: ComWrapper<HostApp>,
    _handler: Option<ComWrapper<Handler>>,
    pub proc: Arc<Proc>,
    pub dirty: Arc<std::sync::atomic::AtomicBool>,
    pub editor: Option<Editor>,
}

impl Instance {
    pub fn new(
        modules: &mut Modules,
        path: &str,
        cid: &str,
        sample_rate: f64,
        st: Option<&[u8]>,
        ct: Option<&[u8]>,
    ) -> Result<Instance, String> {
        let module = modules.get(Path::new(path))?;
        let info = module
            .classes(Path::new(path))
            .into_iter()
            .find(|c| c.cid == cid)
            .ok_or("the plugin does not contain that instrument")?;
        let tuid = cid_parse(cid).ok_or("bad class id")?;
        unsafe {
            let host = ComWrapper::new(HostApp);
            let host_unk = host.as_com_ref::<IHostApplication>().unwrap().as_ptr() as *mut FUnknown;
            let mut obj: *mut c_void = ptr::null_mut();
            let r = module.factory.createInstance(
                tuid.as_ptr(),
                IComponent::IID.as_ptr() as FIDString,
                &mut obj,
            );
            let component = ComPtr::from_raw(obj as *mut IComponent)
                .filter(|_| r == kResultOk)
                .ok_or("could not create the plugin")?;
            if component.initialize(host_unk) != kResultOk {
                return Err("the plugin failed to initialize".into());
            }
            let processor = component
                .cast::<IAudioProcessor>()
                .ok_or("not an audio processor")?;
            let (controller, separate) = match component.cast::<IEditController>() {
                Some(c) => (Some(c), false),
                None => {
                    let mut ccid: TUID = [0; 16];
                    let mut c = None;
                    if component.getControllerClassId(&mut ccid) == kResultOk {
                        let mut obj: *mut c_void = ptr::null_mut();
                        if module.factory.createInstance(
                            ccid.as_ptr(),
                            IEditController::IID.as_ptr() as FIDString,
                            &mut obj,
                        ) == kResultOk
                        {
                            if let Some(ec) = ComPtr::from_raw(obj as *mut IEditController) {
                                if ec.initialize(host_unk) == kResultOk {
                                    c = Some(ec);
                                }
                            }
                        }
                    }
                    (c, true)
                }
            };
            if separate {
                if let (Some(a), Some(b)) = (
                    component.cast::<IConnectionPoint>(),
                    controller
                        .as_ref()
                        .and_then(|c| c.cast::<IConnectionPoint>()),
                ) {
                    a.connect(b.as_ptr());
                    b.connect(a.as_ptr());
                }
            }

            // buses: the main stereo output and the first event input
            let count = |m: MediaTypes, d: BusDirections| {
                component.getBusCount(m as MediaType, d as BusDirection)
            };
            let (audio, event) = (MediaTypes_::kAudio, MediaTypes_::kEvent);
            let (input, output) = (BusDirections_::kInput, BusDirections_::kOutput);
            let n_in = count(audio, input);
            let n_out = count(audio, output);
            let mut in_arr: Vec<SpeakerArrangement> = vec![0; n_in as usize];
            let mut out_arr: Vec<SpeakerArrangement> = (0..n_out)
                .map(|i| if i == 0 { SpeakerArr::kStereo } else { 0 })
                .collect();
            for (i, a) in in_arr.iter_mut().enumerate() {
                processor.getBusArrangement(input as BusDirection, i as i32, a);
            }
            for (i, a) in out_arr.iter_mut().enumerate().skip(1) {
                processor.getBusArrangement(output as BusDirection, i as i32, a);
            }
            processor.setBusArrangements(in_arr.as_mut_ptr(), n_in, out_arr.as_mut_ptr(), n_out);
            let chans = |d: BusDirections, i: i32| {
                let mut a: SpeakerArrangement = 0;
                processor.getBusArrangement(d as BusDirection, i, &mut a);
                a.count_ones() as i32
            };
            for i in 0..n_out {
                component.activateBus(
                    audio as MediaType,
                    output as BusDirection,
                    i,
                    (i == 0) as TBool,
                );
            }
            for i in 0..n_in {
                component.activateBus(audio as MediaType, input as BusDirection, i, 0);
            }
            for i in 0..count(event, input) {
                component.activateBus(
                    event as MediaType,
                    input as BusDirection,
                    i,
                    (i == 0) as TBool,
                );
            }
            // inactive buses still get (silent) buffers with their channel count; that is what most hosts do
            let ins: Vec<i32> = (0..n_in).map(|i| chans(input, i)).collect();
            let outs: Vec<i32> = (0..n_out).map(|i| chans(output, i)).collect();

            if let Some(st) = st {
                component.setState(
                    Stream::new(st.to_vec())
                        .as_com_ref::<IBStream>()
                        .unwrap()
                        .as_ptr(),
                );
            }
            if let Some(c) = &controller {
                if separate {
                    let s = Stream::new(Vec::new());
                    let sp = s.as_com_ref::<IBStream>().unwrap().as_ptr();
                    if component.getState(sp) == kResultOk {
                        s.seek(
                            0,
                            IBStream_::IStreamSeekMode_::kIBSeekSet as i32,
                            ptr::null_mut(),
                        );
                        c.setComponentState(sp);
                    }
                }
                if let Some(ct) = ct {
                    c.setState(
                        Stream::new(ct.to_vec())
                            .as_com_ref::<IBStream>()
                            .unwrap()
                            .as_ptr(),
                    );
                }
            }

            let mut setup = ProcessSetup {
                processMode: ProcessModes_::kRealtime as i32,
                symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
                maxSamplesPerBlock: CHUNK as i32,
                sampleRate: sample_rate,
            };
            if processor.setupProcessing(&mut setup) != kResultOk {
                return Err("the plugin refused the audio setup".into());
            }
            component.setActive(1);
            processor.setProcessing(1);

            let nch: usize = ins.iter().chain(outs.iter()).map(|&c| c as usize).sum();
            let proc = Arc::new(Proc {
                processor,
                edits: Mutex::new(Vec::with_capacity(256)),
                events: ComWrapper::new(EventList {
                    ev: UnsafeCell::new(Vec::with_capacity(512)),
                }),
                params: ComWrapper::new(ParamChanges {
                    queues: (0..256)
                        .map(|_| {
                            ComWrapper::new(ParamQueue {
                                id: UnsafeCell::new(0),
                                pts: UnsafeCell::new(Vec::with_capacity(4)),
                            })
                        })
                        .collect(),
                    used: UnsafeCell::new(0),
                }),
                ins,
                outs,
                bufs: UnsafeCell::new((0..nch).map(|_| vec![0.0; CHUNK]).collect()),
                held: UnsafeCell::new([false; 128]),
            });
            let dirty = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let handler = controller.as_ref().map(|c| {
                let h = ComWrapper::new(Handler {
                    proc: proc.clone(),
                    dirty: dirty.clone(),
                });
                c.setComponentHandler(h.as_com_ref::<IComponentHandler>().unwrap().as_ptr());
                h
            });
            Ok(Instance {
                _module: module,
                info,
                component,
                controller,
                separate,
                _host: host,
                _handler: handler,
                proc,
                dirty,
                editor: None,
            })
        }
    }

    /// The processor and controller state (the controller's only for plugins with a separate one).
    pub fn state(&self) -> (Vec<u8>, Option<Vec<u8>>) {
        unsafe {
            let s = Stream::new(Vec::new());
            self.component
                .getState(s.as_com_ref::<IBStream>().unwrap().as_ptr());
            let st = std::mem::take(&mut s.data.lock().unwrap().0);
            let ct = self
                .controller
                .as_ref()
                .filter(|_| self.separate)
                .and_then(|c| {
                    let s = Stream::new(Vec::new());
                    (c.getState(s.as_com_ref::<IBStream>().unwrap().as_ptr()) == kResultOk)
                        .then(|| std::mem::take(&mut s.data.lock().unwrap().0))
                });
            (st, ct)
        }
    }

    pub fn has_editor(&self) -> bool {
        self.controller.is_some()
    }

    /// Creates the editor view. Returns it with its initial size.
    pub fn create_view(&self) -> Result<(ComPtr<IPlugView>, (i32, i32)), String> {
        unsafe {
            let c = self
                .controller
                .as_ref()
                .ok_or("this plugin has no editor")?;
            let v = ComPtr::from_raw(c.createView(b"editor\0".as_ptr() as FIDString))
                .ok_or("this plugin has no editor")?;
            if v.isPlatformTypeSupported(kPlatformTypeX11EmbedWindowID) != kResultOk {
                return Err("the editor does not support X11".into());
            }
            let mut r: ViewRect = std::mem::zeroed();
            v.getSize(&mut r);
            Ok((
                v,
                ((r.right - r.left).max(100), (r.bottom - r.top).max(100)),
            ))
        }
    }

    /// Stops processing. Call only once the audio thread no longer holds `proc`.
    fn shutdown(&mut self) {
        self.editor = None;
        unsafe {
            self.proc.processor.setProcessing(0);
            self.component.setActive(0);
            if self.separate {
                if let (Some(a), Some(b)) = (
                    self.component.cast::<IConnectionPoint>(),
                    self.controller
                        .as_ref()
                        .and_then(|c| c.cast::<IConnectionPoint>()),
                ) {
                    a.disconnect(b.as_ptr());
                    b.disconnect(a.as_ptr());
                }
            }
            if let Some(c) = &self.controller {
                c.setComponentHandler(ptr::null_mut());
                if self.separate {
                    c.terminate();
                }
            }
            self.component.terminate();
        }
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------- editor windows

/// Host side of an open editor: the plug frame (resizing) and the Linux run loop (fd watches and
/// timers on the GTK main loop).
pub struct Frame {
    resize: Box<dyn Fn(i32, i32)>,
    fds: RefCell<HashMap<usize, Vec<glib::SourceId>>>,
    timers: RefCell<HashMap<usize, Vec<glib::SourceId>>>,
}
impl Class for Frame {
    type Interfaces = (IPlugFrame, IRunLoop);
}
impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, view: *mut IPlugView, r: *mut ViewRect) -> tresult {
        let r = &mut *r;
        (self.resize)(r.right - r.left, r.bottom - r.top);
        if let Some(v) = ComRef::from_raw(view) {
            v.onSize(r);
        }
        kResultOk
    }
}
impl IRunLoopTrait for Frame {
    unsafe fn registerEventHandler(&self, h: *mut IEventHandler, fd: FileDescriptor) -> tresult {
        let Some(hp) = ComRef::from_raw(h).map(|r| r.to_com_ptr()) else {
            return kInvalidArgument;
        };
        let id = glib::source::unix_fd_add_local(
            fd,
            glib::IOCondition::IN | glib::IOCondition::HUP | glib::IOCondition::ERR,
            move |fd, _| {
                hp.onFDIsSet(fd);
                glib::ControlFlow::Continue
            },
        );
        self.fds
            .borrow_mut()
            .entry(h as usize)
            .or_default()
            .push(id);
        kResultOk
    }
    unsafe fn unregisterEventHandler(&self, h: *mut IEventHandler) -> tresult {
        let ids = self.fds.borrow_mut().remove(&(h as usize));
        for id in ids.into_iter().flatten() {
            id.remove();
        }
        kResultOk
    }
    unsafe fn registerTimer(&self, h: *mut ITimerHandler, ms: TimerInterval) -> tresult {
        let Some(hp) = ComRef::from_raw(h).map(|r| r.to_com_ptr()) else {
            return kInvalidArgument;
        };
        let id = glib::timeout_add_local(std::time::Duration::from_millis(ms.max(1)), move || {
            hp.onTimer();
            glib::ControlFlow::Continue
        });
        self.timers
            .borrow_mut()
            .entry(h as usize)
            .or_default()
            .push(id);
        kResultOk
    }
    unsafe fn unregisterTimer(&self, h: *mut ITimerHandler) -> tresult {
        let ids = self.timers.borrow_mut().remove(&(h as usize));
        for id in ids.into_iter().flatten() {
            id.remove();
        }
        kResultOk
    }
}

pub struct Editor {
    view: ComPtr<IPlugView>,
    frame: ComWrapper<Frame>,
    pub window_id: tao::window::WindowId,
    _window: Rc<tao::window::Window>,
}

impl Editor {
    /// Attaches `view` to the X11 window `xid`.
    pub fn open(
        view: ComPtr<IPlugView>,
        window: Rc<tao::window::Window>,
        xid: u64,
    ) -> Result<Editor, String> {
        let w = Rc::downgrade(&window);
        let frame = ComWrapper::new(Frame {
            resize: Box::new(move |wd, ht| {
                if let Some(w) = w.upgrade() {
                    w.set_inner_size(tao::dpi::PhysicalSize::new(wd as u32, ht as u32));
                }
            }),
            fds: RefCell::new(HashMap::new()),
            timers: RefCell::new(HashMap::new()),
        });
        unsafe {
            view.setFrame(frame.as_com_ref::<IPlugFrame>().unwrap().as_ptr());
            if view.attached(xid as usize as *mut c_void, kPlatformTypeX11EmbedWindowID)
                != kResultOk
            {
                view.setFrame(ptr::null_mut());
                return Err("the editor could not be opened".into());
            }
        }
        Ok(Editor {
            view,
            frame,
            window_id: window.id(),
            _window: window,
        })
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        unsafe {
            self.view.removed();
            self.view.setFrame(ptr::null_mut());
        }
        for (_, ids) in self.frame.fds.borrow_mut().drain() {
            ids.into_iter().for_each(|i| i.remove());
        }
        for (_, ids) in self.frame.timers.borrow_mut().drain() {
            ids.into_iter().for_each(|i| i.remove());
        }
    }
}
