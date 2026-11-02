//! The audio thread: runs the JS engine and the VST3 instruments in the device callback.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use vst3::Steinberg::Vst::ProcessContext;
use vst3::Steinberg::Vst::ProcessContext_::StatesAndFlags_::*;

use crate::js::{self, Js, MAX_BLOCK};
use crate::vst::Proc;

/// Frames rendered per engine call: the callback's buffer is cut into blocks of at most this.
const BLOCK: usize = 256;

pub enum Cmd {
    /// A message of the page's worklet protocol, as JSON.
    Msg(String),
    /// Puts a VST3 instrument on a track (or removes it).
    Slot(usize, Option<Arc<Proc>>),
}

pub enum Out {
    Post(String),
    /// An instrument the audio thread no longer uses; drop it on the main thread.
    Release(Arc<Proc>),
    Error(String),
}

/// Clock shared with the main thread, which tells the page the current audio time.
pub struct Clock {
    pub sample_rate: f64,
    start: Instant,
    frames: AtomicU64,
    at_ns: AtomicU64,
    pub latency: AtomicU64,
    pub running: AtomicBool,
}

impl Clock {
    /// The engine frame that is being rendered now, extrapolated from the last callback.
    pub fn now_frames(&self) -> f64 {
        let f = self.frames.load(Ordering::Acquire) as f64;
        let at = self.at_ns.load(Ordering::Acquire) as f64;
        let now = self.start.elapsed().as_nanos() as f64;
        f + ((now - at).max(0.0) * 1e-9 * self.sample_rate).min(self.sample_rate * 0.1)
    }
}

struct Host {
    slots: [Option<Arc<Proc>>; 8],
    out: rtrb::Producer<Out>,
    ctx: ProcessContext,
    evs: Vec<Vec<(u8, u8, u8, u32)>>,
    frame: u64,
}

impl js::Host for Host {
    fn ext(&mut self, n: usize, ev: &[f64], tempo: f64, out: &mut [f32]) {
        for e in self.evs.iter_mut() {
            e.clear();
        }
        for e in ev.chunks_exact(5) {
            let t = e[0] as usize;
            if t < 8 {
                self.evs[t].push((
                    e[1] as u8,
                    e[2].clamp(0.0, 127.0) as u8,
                    e[3].clamp(0.0, 127.0) as u8,
                    e[4].max(0.0) as u32,
                ));
            }
        }
        self.ctx.tempo = tempo;
        self.ctx.projectTimeSamples = self.frame as i64;
        self.ctx.continousTimeSamples = self.frame as i64;
        self.ctx.projectTimeMusic = self.frame as f64 / self.ctx.sampleRate * tempo / 60.0;
        for t in 0..8 {
            let (l, r) = out[2 * t * MAX_BLOCK..(2 * t + 2) * MAX_BLOCK].split_at_mut(MAX_BLOCK);
            match &self.slots[t] {
                Some(p) => p.process(n, &self.evs[t], &mut self.ctx, &mut l[..n], &mut r[..n]),
                None => {
                    l[..n].fill(0.0);
                    r[..n].fill(0.0);
                }
            }
        }
    }

    fn post(&mut self, msg: String) {
        let _ = self.out.push(Out::Post(msg));
    }
}

pub struct Audio {
    _stream: cpal::Stream,
    pub clock: Arc<Clock>,
}

/// Audio systems to try, in order. ARRANGER_AUDIO=pipewire|pulseaudio|jack|alsa picks one.
fn hosts() -> Vec<cpal::HostId> {
    use cpal::HostId as H;
    let all = [H::PipeWire, H::PulseAudio, H::Jack, H::Alsa];
    match std::env::var("ARRANGER_AUDIO").ok().as_deref() {
        Some(w) => all
            .into_iter()
            .filter(|h| h.name().to_lowercase().contains(&w.to_lowercase()))
            .collect(),
        None => all.to_vec(),
    }
}

/// Opens the first audio system that works. Returns the stream and the main thread's ends of the
/// command and output queues.
pub fn start(
    engine_src: String,
) -> Result<(Audio, rtrb::Producer<Cmd>, rtrb::Consumer<Out>), String> {
    let mut errs = Vec::new();
    for id in hosts() {
        let host = match cpal::host_from_id(id) {
            Ok(h) => h,
            Err(e) => {
                errs.push(format!("{}: {e}", id.name()));
                continue;
            }
        };
        let Some(device) = host.default_output_device() else {
            errs.push(format!("{}: no output device", id.name()));
            continue;
        };
        let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(8192);
        let (out_tx, out_rx) = rtrb::RingBuffer::new(8192);
        match open(&device, engine_src.clone(), cmd_rx, out_tx) {
            Ok(a) => {
                eprintln!("audio: using {}", id.name());
                return Ok((a, cmd_tx, out_rx));
            }
            Err(e) => errs.push(format!("{}: {e}", id.name())),
        }
    }
    Err(errs.join("; "))
}

fn open(
    device: &cpal::Device,
    engine_src: String,
    cmd: rtrb::Consumer<Cmd>,
    out: rtrb::Producer<Out>,
) -> Result<Audio, String> {
    let cfg = device.default_output_config().map_err(|e| e.to_string())?;
    let sc: cpal::StreamConfig = cfg.clone().into();
    let clock = Arc::new(Clock {
        sample_rate: sc.sample_rate as f64,
        start: Instant::now(),
        frames: AtomicU64::new(0),
        at_ns: AtomicU64::new(0),
        latency: AtomicU64::new(0),
        running: AtomicBool::new(false),
    });
    use cpal::SampleFormat as F;
    let f = cfg.sample_format();
    if ![F::F32, F::I16, F::I32, F::F64].contains(&f) {
        return Err(format!("unsupported sample format {f}"));
    }
    let (c, o) = (cmd, out);
    let stream = match f {
        F::F32 => build::<f32>(device, &sc, engine_src, c, o, clock.clone()),
        F::I16 => build::<i16>(device, &sc, engine_src, c, o, clock.clone()),
        F::I32 => build::<i32>(device, &sc, engine_src, c, o, clock.clone()),
        _ => build::<f64>(device, &sc, engine_src, c, o, clock.clone()),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    eprintln!(
        "audio: {} Hz, {} channels, {:?}",
        sc.sample_rate, sc.channels, sc.buffer_size
    );
    Ok(Audio {
        _stream: stream,
        clock,
    })
}

fn build<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    sc: &cpal::StreamConfig,
    engine_src: String,
    mut cmd: rtrb::Consumer<Cmd>,
    out: rtrb::Producer<Out>,
    clock: Arc<Clock>,
) -> Result<cpal::Stream, String> {
    let ch = sc.channels as usize;
    let sr = sc.sample_rate as f64;
    let mut ctx: ProcessContext = unsafe { std::mem::zeroed() };
    ctx.sampleRate = sr;
    ctx.state = (kTempoValid | kProjectTimeMusicValid | kContTimeValid | kPlaying) as u32;
    ctx.timeSigNumerator = 4;
    ctx.timeSigDenominator = 4;
    let mut host = Box::new(Host {
        slots: Default::default(),
        out,
        ctx,
        evs: vec![Vec::with_capacity(64); 8],
        frame: 0,
    });
    struct SendJs(Option<Js>);
    unsafe impl Send for SendJs {}
    let mut js = SendJs(None);
    let mut failed = false;
    let mut frame: u64 = 0;
    let cb = move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
        let js = &mut js; // capture the Send wrapper, not its field
        let ts = info.timestamp();
        // some backends report no playback time; the buffer length is the least the latency can be
        let d = ts.playback.duration_since(ts.callback).as_secs_f64() * sr;
        clock
            .latency
            .store(d.max((data.len() / ch) as f64) as u64, Ordering::Relaxed);
        clock.frames.store(frame, Ordering::Release);
        clock
            .at_ns
            .store(clock.start.elapsed().as_nanos() as u64, Ordering::Release);
        let hp: *mut Host = &mut *host;
        if js.0.is_none() && !failed {
            match Js::new(&engine_src, sr, hp as *mut dyn js::Host) {
                Ok(j) => {
                    js.0 = Some(j);
                    clock.running.store(true, Ordering::Release);
                }
                Err(e) => {
                    failed = true;
                    let _ = host.out.push(Out::Error(e));
                }
            }
        }
        while let Ok(c) = cmd.pop() {
            match c {
                Cmd::Msg(m) => {
                    if let Some(j) = js.0.as_mut() {
                        if let Err(e) = j.msg(&m) {
                            let _ = host.out.push(Out::Error(e));
                        }
                    }
                }
                Cmd::Slot(t, p) => {
                    if let Some(old) = std::mem::replace(&mut host.slots[t], p) {
                        let _ = host.out.push(Out::Release(old));
                    }
                }
            }
        }
        let frames = data.len() / ch;
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(BLOCK);
            host.frame = frame;
            let res = js.0.as_mut().map(|j| j.render(n, frame));
            let o = &mut data[done * ch..(done + n) * ch];
            match res {
                Some(Ok((l, r))) => {
                    for (i, f) in o.chunks_exact_mut(ch).enumerate() {
                        f[0] = T::from_sample(l[i]);
                        if ch > 1 {
                            f[1] = T::from_sample(r[i]);
                        }
                        for x in f.iter_mut().skip(2) {
                            *x = T::EQUILIBRIUM;
                        }
                    }
                }
                other => {
                    if let Some(Err(e)) = other {
                        let _ = host.out.push(Out::Error(e));
                    }
                    o.fill(T::EQUILIBRIUM);
                }
            }
            frame += n as u64;
            done += n;
        }
    };
    device
        .build_output_stream(sc.clone(), cb, |e| eprintln!("audio: {e}"), None)
        .map_err(|e| e.to_string())
}
