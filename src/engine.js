// Arranger ST10 audio engine. Runs in the AudioWorkletGlobalScope; `T` (DS-10 ROM
// tables) and `MV_DEV` (Midiverb programs) are prepended at build time.
//
// The DS-10 voice is a port of ds10emu's reimplementation: control-rate logic
// (LFO, EG, portamento, pitch, VCF coefficient mapping, VCA) runs once per
// 512 Hz frame exactly as on the DS, in integer arithmetic. The audio path
// replaces the DS-10 oscillators with polyBLEP ones and its Chamberlin SVF with
// a TPT/ZDF SVF whose integrator states are clipped, and runs at host rate.

const SR = sampleRate;
const FR = SR / 512;            // host samples per DS-10 control frame
const RT = 32768 / SR;          // DS-10 sample rate / host rate
const I = Math.imul, fl = Math.floor;
const TWO32 = 4294967296;
const m15 = (a, b) => fl(a * b / 32768);
const m24 = (a, b) => fl(a * b / 16777216);
const clampi = (v, a, b) => v < a ? a : v > b ? b : v;

const MOD_ROUTE = [[4, 2], [2, 2], [1, 2], [3, 2], [0, 2], [4, 0], [4, 2]];
const NPARAM = 37;
const INIT_K = [0,0,0,0,0,0,1,1,0,0,0,127,0,0,0,0,0,0,0,100,0,127,127,0,50,1,0,0,0,0,0, 0,0,100,64,0,0];

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function blamp(t, dt) {
  if (t < dt) { t = t / dt - 1; return -t * t * t / 3; }
  if (t > 1 - dt) { t = (t - 1) / dt + 1; return t * t * t / 3; }
  return 0;
}
function lfsr(r) { return (r & 0x40000000) === 0 ? (((r ^ 0x1064) << 1) | 1) : (r << 1); }
function plook(v) {
  if (v < 0) v = 0; else if (v > 0x3C0000) v = 0x3C0000;
  const i = v >> 15, f = v & 0x7FFF, lo = T.pitch[i];
  return lo + m15(f, T.pitch[i + 1] - lo);
}
// naive waveform value at phase t (0..1), used for the hard-sync step size
function naive(w, t) {
  if (w === 0) return -1 + 2 * Math.abs(1 - 2 * t) + 0.13 * (1 - 2 * t);
  if (w === 1) { let u = t + 0.5; if (u >= 1) u -= 1; return 1 - 2 * u; }
  if (w === 2) return (t < 0.25 || t >= 0.75) ? 1 : -1;
  return 0;
}

class Voice {
  constructor() {
    // MG (LFO)
    this.lo = [0, 0, 0, 0, 0]; this.ld = 0x7FFFFFFF; this.lu = 0; this.linc = 0; this.lsr = 2;
    this.lbpm = true; this.bpm = 120; this.lknob = 50;
    // EG
    this.st = 3; this.lv = 0; this.ax = 0; this.rt = 1; this.ea = 0; this.ed = 0; this.es = 0; this.er = 0;
    // note / pitch control
    this.nT = 60 << 15; this.nC = 60 << 15; this.nR = 32767; this.nD = 0;
    this.peg = 64; this.pds = [64, 64, 64]; this.oct12 = 0; this.v2p = 64; this.pls = [4, 4, 4]; this.pes = [2, 2, 2];
    // VCO
    this.xm = 0; this.w1 = 1; this.w2 = 1; this.vo1 = 0; this.vo2 = 0; this.sync = 0; this.pin = [63, 63, 63];
    this.t1 = 0; this.t2 = 0; this.d1 = 0; this.d2 = 0; this.o1d = 0; this.o2d = 0; this.o2 = 0; this.h2 = 0;
    this.n1 = 13174; this.n2 = 13036;
    // VCF
    this.praw = T.peak[0]; this.q = 32767; this.cut = 127 << 15; this.typ = 0; this.treq = 0;
    this.feg = 64; this.fin = 64; this.fls = 4; this.fes = 2; this.fosc = 0;
    this.s1 = 0; this.s2 = 0; this.g = 0.1; this.gd = 0; this.gT = -1; this.k = 2; this.kd = 0; this.kT = 2; this.qg = 1;
    // VCA
    this.dist = 0; this.wet = 0; this.alk = 0; this.ain = 0; this.aeg = 0; this.als = 4; this.aes = 2;
    this.dr1 = 0; this.dr2 = 32767; this.lvl = 0; this.lvd = 0; this.lvT = 0;
    this.on = false; this.gate = false; this.note = -1; this.vg = 1; this.age = 0;
  }

  // ds10_patch_set_knob
  knob(k, v) {
    switch (k) {
      case 0: this.oct12 = v * 12; break;
      case 1: this.peg = v + 64; break;
      case 2: this.nR = T.porta[v]; break;
      case 3: case 4: case 5: this.pin[k - 3] = v + 63; this.pds[k - 3] = v + 64; break;
      case 6: this.w1 = v > 3 ? 3 : v; break;
      case 7: this.w2 = v > 3 ? 3 : v; break;
      case 8: this.v2p = v + 64; break;
      case 9: {
        const a = v * 258, b = 32766 - a;
        this.vo1 = I(32764 - (I(a, a) >> 15), 17476) >> 15;
        this.vo2 = I(32764 - (I(b, b) >> 15), 17476) >> 15;
        break;
      }
      case 10: this.sync = v; break;
      case 11: this.cut = v << 15; break;
      case 12: {
        this.praw = T.peak[v];
        let t2 = (0xFFFFFF - (this.praw >> 7)) * 64; if (t2 > 0xFFFFFF) t2 = 0xFFFFFF;
        this.q = ((t2 >> 1) + 0x800000) >> 9;
        break;
      }
      case 13: this.treq = v; break;
      case 14: this.feg = v + 64; break;
      case 15: this.fin = v + 64; break;
      case 16: this.aeg = v === 0 ? 0 : v === 1 ? 1 : 2; break;
      case 17: this.ain = v * 0x41041; this.wet = (v + 64) * 258; break;
      case 18: { const d = v * 258; this.dr1 = I(d, d) >> 15; this.dr2 = 32767 - v * 232; break; }
      case 19: this.alk = v * 0x20408; break;
      case 20: this.ea = T.env_rate[v]; break;
      case 21: this.ed = T.env_rate[v]; break;
      case 22: this.es = v << 17; break;
      case 23: this.er = T.env_rate[v]; break;
      case 24: this.lrate(v); break;
      case 25: if (this.lbpm !== (v !== 0)) { this.lbpm = v !== 0; this.lrate(this.lknob); } break;
      case 26: case 27: case 28: case 29: case 30: this.modsrc(k - 26, v); break;
    }
  }
  lrate(k) {
    k = clampi(k, 0, 127); this.lknob = k;
    if (this.lbpm) {
      const u = k < 0x7E ? T.lfo_bpm[k >> 3] : 0x4459A045;
      this.linc = (I(u >> 9, this.bpm) + (I(u & 0x1FF, this.bpm) >> 9)) | 0;
    } else this.linc = T.lfo_free[k] | 0;
  }
  modsrc(d, s) {
    if (s > 6) s = 6;
    const l = MOD_ROUTE[s][0], e = MOD_ROUTE[s][1];
    if (d < 3) {
      this.pls[d] = l; this.pes[d] = e;
      if (s === 6) this.xm = d + 1; else if (s === 0 && this.xm === d + 1) this.xm = 0;
    } else if (d === 3) { this.fls = l; this.fes = e; this.fosc = s === 6 ? 1 : 0; }
    else { this.als = l; this.aes = e; this.dist = s === 6 ? 1 : 0; }
  }
  setBpm(b) { this.bpm = b; this.lrate(this.lknob); }
  resetLfo() { this.ld = 0x7FFFFFFF; this.lu = 0; }

  noteOn(p, v) {
    const tgt = p << 15;
    this.nD = this.nC > tgt ? 0 : 1; this.nT = tgt;
    if (this.rt) this.st = 0;
    this.rt = 0; this.on = true; this.gate = true; this.note = p; this.vg = v / 127;
  }
  noteOff() { this.st = 3; this.rt = 1; this.gate = false; }

  // one 512 Hz control frame: render preamble of the DS-10 voice
  frame() {
    // LFO
    const ou = this.lu;
    this.ld = (this.ld - this.linc) | 0;
    const saw = this.ld >> 7;
    this.lu = (ou + this.linc) | 0;
    const ramp = saw + (this.lu >> 7);
    this.lsr = lfsr(this.lsr);
    if (((ou ^ this.lu) >> 31) !== 0) this.lo[0] = this.lsr >> 7;
    const fo = saw < 1 ? -saw : saw;
    this.lo[1] = saw; this.lo[2] = ((fo << 1) + 1 - 0x01000000) | 0; this.lo[3] = (ramp + 0x01000000) >> 1;
    if (!this.on) return;
    // EG
    switch (this.st) {
      case 0:
        this.ax += fl((0xB33333 - this.ax) * 0x70 / 128); if (this.ax > 0xB33333) this.ax = 0xB33333;
        this.lv += m24(0x014CCCCD - this.lv, this.ea);
        if (this.lv > 0xFFFFFF) { this.lv = 0xFFFFFF; this.st = 1; }
        break;
      case 1:
        this.lv += m24(this.ed, this.es - this.lv);
        if (this.lv < this.es) { this.lv = this.es; this.st = 2; }
        break;
      case 2: this.lv = this.es; break;
      case 3: this.ax = I(this.ax, 0x42) >> 7; this.lv = m24(this.lv, 0xFFFFFF - this.er); break;
    }
    const EO0 = this.lv, EO1 = this.ax, LO = this.lo;
    const eo = s => s === 0 ? EO0 : s === 1 ? EO1 : 0;
    // portamento
    this.nC += m15(this.nR, this.nT - this.nC);
    if (this.nD === 0) { if (this.nC < this.nT) this.nC = this.nT; } else if (this.nT < this.nC) this.nC = this.nT;
    // pitch
    const D = T.depth;
    const mt = (ds, l, e) => I(D[ds], (l + e) >> 9) >> 15;
    const common = mt(this.pds[0], LO[this.pls[0]], eo(this.pes[0])) + (I(D[this.peg], EO0 >> 9) >> 15);
    const base = this.nC + this.oct12 * 0x8000;
    const inc1 = plook((common + mt(this.pds[1], LO[this.pls[1]], eo(this.pes[1]))) * 0x30 + base);
    const inc2 = plook((common + mt(this.pds[2], LO[this.pls[2]], eo(this.pes[2]))) * 0x30 + base + D[this.v2p] * 0x30);
    this.d1 = inc1 / TWO32 * RT; this.d2 = inc2 / TWO32 * RT;
    // VCF coefficient mapping
    const MA = T.mod_a, MB = T.mod_b;
    const o2i = Math.round(this.o2 * 32767);
    let mod = (I(MA[this.fin], (eo(this.fes) + LO[this.fls]) >> 9) >> 15) + (I(MA[this.feg], EO0 >> 9) >> 15)
      + (I(MB[this.fin], this.fosc * o2i) >> 15);
    let v = clampi(mod * 0x7F + this.cut, -0xB8000, 0x3F8000) + 0xB8000;
    const ci = v >> 15, cf = v & 0x7FFF, coef = T.coef[ci] + m15(cf, T.coef[ci + 1] - T.coef[ci]);
    let res = coef - 1367566549; if (res < 1) res = 0;
    const sq = fl(res * res / 2147483648);
    const damped = m24(this.praw >> 7, 0x1000000 - m24(sq >> 7, 0x01800000));
    const dT = m24(0x1000000 - damped, 0x1000000 - (coef >> 8));
    // the DS-10 lets PEAK pull the frequency term up too; this voice takes the frequency as at PEAK 0, so CUTOFF alone sets it
    const damped0 = m24(T.peak[0] >> 7, 0x1000000 - m24(sq >> 7, 0x01800000));
    const fT = m24((damped0 >> 1) + 0x800000, coef >> 7);
    let fc = 32768 / Math.PI * Math.asin(Math.min(fT / 16777216, 1));
    if (fc > SR * 0.45) fc = SR * 0.45; else if (fc < 8) fc = 8;
    const gT = Math.tan(Math.PI * fc / SR), kT = dT / 8388608;
    if (this.gT < 0) { this.gT = gT; this.kT = kT; }
    this.g = this.gT; this.gd = (gT - this.gT) / FR; this.gT = gT;
    this.k = this.kT; this.kd = (kT - this.kT) / FR; this.kT = kT;
    this.qg = this.q / 32768;
    if (this.typ !== this.treq) { this.typ = this.treq; this.s1 = 0; this.s2 = 0; }
    // VCA level
    let shaped;
    if (this.als === 4) shaped = 0x1000000;
    else {
      const l = LO[this.als];
      const t = this.als === 3 ? m24(l, this.ain) : m24((l + 0xFFFFFF) >> 1, this.ain);
      shaped = this.ain > 0 ? (t + 0xFFFFFF) - this.ain : t + 0xFFFFFF;
    }
    const scaled = m24(shaped, this.alk);
    const operand = eo(this.aeg) + fl(this.ain * eo(this.aes) / 16777216);
    const target = fl(operand * scaled / 16777216);
    this.lvl = this.lvT; this.lvd = (target - this.lvT) / FR; this.lvT = target;
    if (this.st === 3 && this.lv < 4000 && Math.abs(this.lvT) < 4000 && Math.abs(this.lvl) < 4000) {
      this.on = false; this.s1 = this.s2 = 0; this.lvl = this.lvT = this.lvd = 0;
    }
  }

  osc(w, t, dt, which) {
    switch (w) {
      case 0: {
        let v = -1 + 2 * Math.abs(1 - 2 * t) - 8 * dt * blamp(t, dt);
        let u = t + 0.5; if (u >= 1) u -= 1;
        return v + 8 * dt * blamp(u, dt) + 0.13 * (1 - 2 * t) + 0.13 * blep(t, dt);
      }
      case 1: { let u = t + 0.5; if (u >= 1) u -= 1; return 1 - 2 * u + blep(u, dt); }
      case 2: {
        let v = (t < 0.25 || t >= 0.75) ? 1 : -1;
        let u = t + 0.75; if (u >= 1) u -= 1; v -= blep(u, dt);
        u = t + 0.25; if (u >= 1) u -= 1; return v + blep(u, dt);
      }
      default:
        if (which === 1) { this.n1 = lfsr(this.n1); return (this.n1 >> 16) / 32768; }
        return 0;
    }
  }

  sample() {
    let d1 = this.d1, d2 = this.d2;
    const o2p = this.o2;
    if (this.xm) {
      const xm = this.xm;
      if (xm === 1) { const g = this.pin[0]; d1 += 2 * g * g * o2p * 32767 / TWO32 * RT; d2 += g * o2p * 32767 / 4194304 * this.d2; }
      else if (xm === 2) { const g = this.pin[1]; d1 += 2 * g * g * o2p * 32767 / TWO32 * RT; }
      else { const g = this.pin[2]; d2 += g * o2p * 32767 / 4194304 * this.d2; }
    }
    let t1 = this.t1 + d1, wrapped = false, x = 0;
    if (t1 >= 1) { t1 -= fl(t1); wrapped = true; x = d1 > 0 ? t1 / d1 : 0; } else if (t1 < 0) t1 -= fl(t1);
    const t2o = this.t2;
    let t2 = t2o + d2, J = 0;
    if (this.sync && wrapped) {
      let tb = t2o + d2 * (1 - x); tb -= fl(tb);
      t2 = x * Math.abs(d2); J = naive(this.w2, 0) - naive(this.w2, tb);
    } else t2 -= fl(t2);
    this.t1 = t1; this.t2 = t2;
    const a1 = Math.min(Math.abs(d1), 0.5) || 1e-9, a2 = Math.min(Math.abs(d2), 0.5) || 1e-9;
    let o1n = this.osc(this.w1, t1, a1, 1), o2n;
    if (this.w2 === 3) {
      this.n2 = lfsr(this.n2);
      if ((t2 < 0.5) !== (t2o < 0.5) || t2 < t2o) this.h2 = (this.n2 >> 16) / 32768;
      o2n = this.h2;
    } else o2n = this.osc(this.w2, t2, a2, 2);
    if (J !== 0 && this.w2 !== 3) { this.o2d += J * 0.5 * x * x; o2n += J * 0.5 * (2 * x - x * x - 1); }
    const o1 = this.o1d, o2 = this.o2d; this.o1d = o1n; this.o2d = o2n; this.o2 = o2;
    const mix = (o1 * this.vo1 + o2 * this.vo2) / 32768;
    // TPT state-variable filter with clipped integrator states
    const g = this.g, k = this.k, xin = mix * this.qg;
    const A1 = 1 / (1 + g * (g + k)), A2 = g * A1, A3 = g * A2;
    const v3 = xin - this.s2, v1 = A1 * this.s1 + A2 * v3, v2 = this.s2 + A2 * this.s1 + A3 * v3;
    let s1 = 2 * v1 - this.s1, s2 = 2 * v2 - this.s2;
    this.s1 = s1 > 1 ? 1 : s1 < -1 ? -1 : s1; this.s2 = s2 > 1 ? 1 : s2 < -1 ? -1 : s2;
    let f;
    if (this.typ === 0) f = v2; else if (this.typ === 1) { f = xin - k * v1 - v2; f = f > 1 ? 1 : f < -1 ? -1 : f; } else f = v1;
    this.g += this.gd; this.k += this.kd;
    // VCA: drive, optional ring-mod against VCO2, level
    let c = f * this.dr1 / 2048; c = c < -1 ? -1 : c > 1 ? 1 : c;
    let o = (c * 0.5 + f * this.dr2 / 32768) * 0.5 * this.lvl / 16777216;
    if (this.dist) o = o2 * o * this.wet / 32768 + o * (32767 - this.wet) / 32768;
    o = o < -0.5 ? -0.5 : o > 0.5 ? 0.5 : o;
    this.lvl += this.lvd;
    return o * 2 * this.vg;
  }
}

// ---- exact DS-10 voice (ds10emu port, integer, 32768 Hz) -------------------------------------
// Same knobs and control logic as Voice, but the oscillators, Chamberlin filter, amp and every
// per-frame ramp are the integer code of ds10emu (vco.c, vcf.c, amp.c, voice.c), started from the
// constructor state in the ROM table. It renders at 32768 Hz in 64-sample frames; only its output
// is resampled to the host rate.
// exact ((int64)a * b) >> n for int32 a, b (the double product alone loses bits above 2^53)
function mulsh(a, b, n) {
  const bh = b >> 16, bl = b & 0xFFFF, p1 = a * bh, p0 = a * bl;
  if (n >= 16) return Math.floor((p1 + Math.floor(p0 / 65536)) / Math.pow(2, n - 16));
  return p1 * Math.pow(2, 16 - n) + Math.floor(p0 / Math.pow(2, n));
}
const x15 = (a, b) => mulsh(a, b, 15) | 0, x23 = (a, b) => mulsh(a, b, 23) | 0, x24 = (a, b) => mulsh(a, b, 24) | 0;
const cl24 = v => v >= 0x1000000 ? 0xFFFFFF : v < -0xFFFFFF ? -0xFFFFFF : v;
const RECIP_NUM = 0x007FFFFFFF000000n;
const recip = inc => inc < 0x01000000 ? 0x7FFFFFFF : Number(RECIP_NUM / BigInt(inc >>> 0)) | 0;

class VoiceX extends Voice {
  constructor() {
    super();
    this.exact = true;
    const f = T.voice_init; let i = 0;   // ds10_voice_state_load order
    for (let k = 0; k < 5; k++) this.lo[k] = f[i++];
    this.ld = f[i++]; this.linc = f[i++]; this.lu = f[i++]; this.lsr = f[i++];
    this.st = f[i++]; this.rt = f[i++]; this.lv = f[i++]; this.ax = f[i++];
    this.ea = f[i++]; this.ed = f[i++]; this.es = f[i++]; this.er = f[i++];
    this.nT = f[i++]; this.nC = f[i++]; this.nR = f[i++]; this.nD = f[i++];
    this.peg = f[i++]; for (let k = 0; k < 3; k++) this.pds[k] = f[i++];
    this.oct12 = f[i++]; this.v2p = f[i++]; this.pinc1 = f[i++]; this.pinc2 = f[i++];
    for (let k = 0; k < 3; k++) this.pls[k] = f[i++];
    for (let k = 0; k < 3; k++) this.pes[k] = f[i++];
    this.xm = f[i++]; this.ph1 = f[i++]; this.ph2 = f[i++]; this.inc1 = f[i++]; this.inc2 = f[i++];
    this.sh1 = f[i++]; this.sh2 = f[i++]; this.w1 = f[i++]; this.w2 = f[i++]; this.vo1 = f[i++]; this.vo2 = f[i++];
    this.n1 = f[i++]; this.n2 = f[i++]; this.sync = f[i++]; this.prev2 = f[i++]; this.hold2 = f[i++];
    this.xm60 = f[i++]; this.xm64 = f[i++]; this.xm68 = f[i++]; this.xm6c = f[i++];
    for (let k = 0; k < 3; k++) this.pin[k] = f[i++];
    this.q = f[i++]; this.band = f[i++]; this.low = f[i++]; this.typ = f[i++];
    this.ff = f[i++]; this.ffd = f[i++]; this.dmp = f[i++]; this.dmpd = f[i++];
    this.fls = f[i++]; this.fes = f[i++]; this.fosc = f[i++]; this.praw = f[i++]; this.cut = f[i++]; this.coef = f[i++];
    this.treq = f[i++]; this.feg = f[i++]; this.fin = f[i++]; this.fft = f[i++]; this.dmpt = f[i++];
    this.dist = f[i++]; this.wet = f[i++]; this.lev = f[i++]; this.levd = f[i++]; this.clipped = f[i++];
    this.dr1 = f[i++]; this.dr2 = f[i++]; this.als = f[i++]; this.aes = f[i++]; this.alk = f[i++]; this.ain = f[i++];
    this.aeg = f[i++]; this.levt = f[i++]; this.lbpm = !!f[i++]; this.bpm = f[i++]; this.lknob = f[i++];
    this.fc = 0; this.acc = 0; this.h0 = this.h1 = this.h2 = this.h3 = 0;
  }
  frame() {}          // the voice frames itself on its own 32768 Hz clock
  dsFrame() {
    // LFO and envelope: identical to Voice
    const ou = this.lu;
    this.ld = (this.ld - this.linc) | 0;
    const saw = this.ld >> 7;
    this.lu = (ou + this.linc) | 0;
    const ramp = saw + (this.lu >> 7);
    this.lsr = lfsr(this.lsr);
    if (((ou ^ this.lu) >> 31) !== 0) this.lo[0] = this.lsr >> 7;
    const fo = saw < 1 ? -saw : saw;
    this.lo[1] = saw; this.lo[2] = ((fo << 1) + 1 - 0x01000000) | 0; this.lo[3] = (ramp + 0x01000000) >> 1;
    switch (this.st) {
      case 0:
        this.ax += mulsh(0xB33333 - this.ax, 0x70, 7); if (this.ax > 0xB33333) this.ax = 0xB33333;
        this.lv += x24(0x014CCCCD - this.lv, this.ea);
        if (this.lv > 0xFFFFFF) { this.lv = 0xFFFFFF; this.st = 1; }
        break;
      case 1: this.lv += x24(this.ed, this.es - this.lv); if (this.lv < this.es) { this.lv = this.es; this.st = 2; } break;
      case 2: this.lv = this.es; break;
      case 3: this.ax = I(this.ax, 0x42) >> 7; this.lv = x24(this.lv, 0xFFFFFF - this.er); break;
    }
    const EO0 = this.lv, EO1 = this.ax, LO = this.lo, eo = s => s === 0 ? EO0 : s === 1 ? EO1 : 0;
    // note control and pitch
    this.nC = (this.nC + x15(this.nR, this.nT - this.nC)) | 0;
    if (this.nD === 0) { if (this.nC < this.nT) this.nC = this.nT; } else if (this.nT < this.nC) this.nC = this.nT;
    const D = T.depth, mt = (ds, l, e) => I(D[ds], (l + e) >> 9) >> 15;
    const common = mt(this.pds[0], LO[this.pls[0]], eo(this.pes[0])) + (I(D[this.peg], EO0 >> 9) >> 15);
    const base = this.nC + this.oct12 * 0x8000;
    const pl = v => { if (v < 0) v = 0; else if (v > 0x3C0000) v = 0x3C0000; const i = v >> 15, fr = v & 0x7FFF, lo = T.pitch[i]; return (lo + x15(fr, T.pitch[i + 1] - lo)) | 0; };
    const inc1 = pl((common + mt(this.pds[1], LO[this.pls[1]], eo(this.pes[1]))) * 0x30 + base);
    const inc2 = pl((common + mt(this.pds[2], LO[this.pls[2]], eo(this.pes[2]))) * 0x30 + base + D[this.v2p] * 0x30);
    // ds10_vco_update
    this.inc1 = inc1; this.inc2 = inc2; this.sh1 = recip(inc1); this.sh2 = recip(inc2);
    this.xm60 = this.pin[0]; this.xm68 = this.pin[1];
    this.xm64 = mulsh(inc2, this.pin[0], 7) | 0; this.xm6c = mulsh(inc2, this.pin[2], 7) | 0;
    // ds10_vcf_update
    const MA = T.mod_a, MB = T.mod_b;
    const mod = (I(MA[this.fin], (eo(this.fes) + LO[this.fls]) >> 9) >> 15) + (I(MA[this.feg], EO0 >> 9) >> 15)
      + (I(MB[this.fin], I(this.fosc, this.prev2) >> 9) >> 15);
    let v = mod * 0x7F + this.cut;
    if (v < -0xB8000) v = -0xB8000; else if (v > 0x3F8000) v = 0x3F8000;
    v += 0xB8000;
    const ci = v >> 15, cf = v & 0x7FFF;
    this.coef = (T.coef[ci] + x15(cf, T.coef[ci + 1] - T.coef[ci])) | 0;
    let res = (this.coef - 1367566549) | 0; if (res < 1) res = 0;
    const sq = mulsh(res, res, 31) | 0;
    const damped = x24(this.praw >> 7, 0x1000000 - x24(sq >> 7, 0x01800000));
    let tg = x24(0x1000000 - damped, 0x1000000 - (this.coef >> 8));
    this.dmpd = (tg - this.dmpt) >> 6; this.dmp = this.dmpt; this.dmpt = tg;
    tg = x24((damped >> 1) + 0x800000, this.coef >> 7);
    this.ffd = (tg - this.fft) >> 6; this.ff = this.fft; this.fft = tg;
    if (this.typ !== this.treq) { this.typ = this.treq; this.band = 0; this.low = 0; }
    // ds10_amp_update
    let shaped;
    if (this.als === 4) shaped = 0x1000000;
    else {
      const l = LO[this.als], t = this.als === 3 ? x24(l, this.ain) : x24((l + 0xFFFFFF) >> 1, this.ain);
      shaped = this.ain > 0 ? (t + 0xFFFFFF) - this.ain : t + 0xFFFFFF;
    }
    const scaled = x24(shaped, this.alk);
    const operand = eo(this.aeg) + mulsh(this.ain, eo(this.aes), 24);
    const target = mulsh(operand | 0, scaled, 24) | 0;
    this.levd = (target - this.levt) >> 6; this.lev = this.levt; this.levt = target;
    this.on = this.gate || !(this.st === 3 && this.lv < 4000 && Math.abs(this.levt) < 4000 && Math.abs(this.lev) < 4000);
  }
  dsSample() {
    // ds10_vco_step
    const old1 = this.ph1, old2 = this.ph2;
    this.ph1 = (old1 - this.inc1) | 0; this.ph2 = (old2 - this.inc2) | 0;
    switch (this.xm) {
      case 1: { const g = this.xm60, t = I(g, I(this.prev2, g) >> 7); this.ph1 = (this.ph1 - (t >> 1)) | 0; this.ph2 = (this.ph2 - x24(this.prev2, this.xm64)) | 0; break; }
      case 2: { const g = this.xm68, t = I(g, I(this.prev2, g) >> 7); this.ph1 = (this.ph1 - (t >> 1)) | 0; break; }
      case 3: this.ph2 = (this.ph2 - x24(this.prev2, this.xm6c)) | 0; break;
    }
    if (this.sync === 1 && this.ph1 > old1) this.ph2 = 0x7FFFFFFF;
    const wave = (w, ph, sh) => {
      const p = ph >> 16;
      if (w === 0) { const a = p <= 0 ? -p : p; return -32767 + (a << 1) + (I(p, 4259) >> 15); }
      if (w === 1) { let s = I(p, sh >> 16) >> 8; if (s > 32767) s = 32767; else if (s < -32767) s = -32767; return p - s; }
      const a = p <= 0 ? -p : p, prod = I(-32767 + (a << 1), sh >> 16);
      if ((prod >> 8) < -32767) return -32767;
      const o = prod >> 8; return o > 32767 ? 32767 : o;
    };
    let out1, out2;
    if (this.w1 === 3) { this.n1 = lfsr(this.n1); out1 = this.n1 >> 16; } else out1 = wave(this.w1, this.ph1, this.sh1);
    if (this.w2 === 3) { this.n2 = lfsr(this.n2); if (((this.ph2 ^ old2) >> 31) !== 0) this.hold2 = this.n2 >> 16; out2 = this.hold2; }
    else out2 = wave(this.w2, this.ph2, this.sh2);
    this.prev2 = out2 << 9;
    const mix = (I(out1, this.vo1) + I(out2, this.vo2)) >> 15;
    // ds10_vcf_step
    let hp = I(mix, this.q) >> 6;
    hp = cl24(hp - (this.low + x23(this.band, this.dmp)));
    let out = mix << 9;
    if (this.typ === 1) out = hp;
    this.band = cl24(this.band + x23(hp, this.ff));
    if (this.typ === 2) out = this.band;
    this.low = cl24(this.low + x23(this.band, this.ff));
    if (this.typ === 0) out = this.low;
    this.ff = (this.ff + this.ffd) | 0; this.dmp = (this.dmp + this.dmpd) | 0;
    const fin = out >> 9;
    // ds10_amp_step
    let clipped = I(fin, this.dr1) >> 11;
    if (clipped < -32767) clipped = -32767; else if (clipped > 32767) clipped = 32767;
    this.clipped = clipped;
    let m = ((clipped >> 1) + (I(fin, this.dr2) >> 15)) >> 1;
    let o = I(m, this.lev >> 9) >> 15;
    if (this.dist !== 0) o = (I(I(this.prev2 >> 9, o) >> 15, this.wet) >> 15) + (I(o, 32767 - this.wet) >> 15);
    if (o < -16383) o = -16383; else if (o > 16383) o = 16383;
    let d = o << 1; if (d < -32767) d = -32767; else if (d > 32767) d = 32767;
    this.lev = (this.lev + this.levd) | 0;
    return d;
  }
  sample() {
    this.acc += RT;
    while (this.acc >= 1) {
      this.acc -= 1;
      if (this.fc === 0) { this.dsFrame(); this.fc = 64; }
      this.fc--;
      this.h0 = this.h1; this.h1 = this.h2; this.h2 = this.h3; this.h3 = this.dsSample() / 32768;
    }
    const f = this.acc, xm1 = this.h0, x0 = this.h1, x1 = this.h2, x2 = this.h3;
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return (((c3 * f + c2) * f + c1) * f + x0) * this.vg;
  }
}

// 4-pole highpass: two TPT SVF sections, resonance on the second
class HP4 {
  constructor() { this.a = [0, 0, 0, 0]; this.set(0, 0); }
  set(c, r) {
    this.byp = c === 0 && r === 0;
    const fc = 20 * Math.pow(400, c / 127), rr = r / 127;
    this.g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR);
    this.k1 = 1.8478 * (1 - 0.3 * rr); this.k2 = 0.7654 * (1 - 0.97 * rr);
  }
  sec(x, k, i) {
    const g = this.g, s = this.a;
    const A1 = 1 / (1 + g * (g + k)), A2 = g * A1, A3 = g * A2;
    const v3 = x - s[i + 1], v1 = A1 * s[i] + A2 * v3, v2 = s[i + 1] + A2 * s[i] + A3 * v3;
    s[i] = 2 * v1 - s[i]; s[i + 1] = 2 * v2 - s[i + 1];
    if (s[i] > 2) s[i] = 2; else if (s[i] < -2) s[i] = -2;
    return x - k * v1 - v2;
  }
  p(x) { return this.byp ? x : this.sec(this.sec(x, this.k1, 0), this.k2, 2); }
}

// sample interpolation for drum playback: 0 linear, 1 4-point Hermite, 2 windowed sinc that
// lowers its cutoff when the sample is played faster than recorded, so pitched-up drums do not alias
function hermite(A, i, f, n) {
  const xm1 = i > 0 ? A[i - 1] : 0, x0 = A[i], x1 = A[i + 1], x2 = i + 2 < n ? A[i + 2] : 0;
  const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}
const SINC_N = 8, SINC_RES = 256, SINC_T = new Float32Array(SINC_N * SINC_RES + 2);
for (let i = 0; i < SINC_T.length; i++) {
  const x = i / SINC_RES, w = x >= SINC_N ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x / SINC_N) + 0.08 * Math.cos(2 * Math.PI * x / SINC_N);
  SINC_T[i] = x === 0 ? 1 : w * Math.sin(Math.PI * x) / (Math.PI * x);
}
function kern(x) { x = x < 0 ? -x : x; if (x >= SINC_N) return 0; const p = x * SINC_RES, j = p | 0; return SINC_T[j] + (SINC_T[j + 1] - SINC_T[j]) * (p - j); }
function sincRead(A, i, f, n, rate) {
  const c = rate > 1 ? Math.max(0.25, 1 / rate) : 1, half = Math.ceil(SINC_N / c);
  let acc = 0;
  for (let j = i - half + 1; j <= i + half; j++) { if (j < 0 || j >= n) continue; acc += A[j] * kern((j - i - f) * c); }
  return acc * c;
}
const LIVE_AHEAD = 4 * SINC_N + 4;   // samples a live drum recording is rendered ahead of its read position (widest sinc reach)
const DRUM_FADE = 1 / (0.005 * SR);   // 5 ms release when a drum note ends or is choked
const holdSec = k => 0.01 * Math.pow(200, k / 127);   // drum HOLD knob: 10 ms .. 2 s

// Record a drum the way the DS-10 does: its own voice, at its note (C3 = 60 by default), into a buffer - here 2 s
// of stereo at host rate - through its highpass and its two effects.
// a drum's voice: the ZDF voice, or with def.exact the ds10emu integer voice (which runs continuously, as on the DS)
const drumVoice = d => d.exact ? new VoiceX() : new Voice();
function renderDrum(d, tempo) {
  const v = drumVoice(d); v.setBpm(tempo);
  for (let id = 0; id < 31; id++) v.knob(id, d.k[id]);
  const hp = new HP4(); hp.set(d.k[31] || 0, d.k[32] || 0);
  const fx = (d.ins || []).map(mkFx).filter(x => x && x.on);
  for (const x of fx) if (x.setTempo) x.setTempo(Math.round(tempo));
  const N = 2 * SR, L = new Float32Array(N), R = new Float32Array(N), hold = Math.round(holdSec(d.hold) * SR);
  v.resetLfo(); v.rt = 1; v.noteOn(d.note || 60, 127);
  let fc = 0;
  for (let i = 0; i < N; i++) {
    if (i === hold) v.noteOff();
    if (--fc <= 0) { fc += FR; v.frame(); for (const x of fx) if (x.frame) x.frame(); }
    let x0 = hp.p(v.on || v.exact ? v.sample() : 0), l = x0, r = x0;
    for (const x of fx) { x.proc(l, r); l = x.l; r = x.r; }
    L[i] = l; R[i] = r;
  }
  const fl = Math.round(0.02 * SR);
  for (let i = 0; i < fl; i++) { const g = i / fl; L[N - 1 - i] *= g; R[N - 1 - i] *= g; }
  return { L, R };
}
function wavePeaks(smp, n) {
  const w = [], step = smp.L.length / n;
  for (let b = 0; b < n; b++) { let m = 0; for (let i = Math.floor(b * step); i < Math.floor((b + 1) * step); i += 4) { const a = Math.max(Math.abs(smp.L[i]), Math.abs(smp.R[i])); if (a > m) m = a; } w.push(Math.round(m * 1000) / 1000); }
  return w;
}

const volGain = v => (v * v * 0x10404 / 32768) / 32768;

class Track {
  constructor() {
    this.k = INIT_K.slice(); this.vs = []; this.nv = 1; this.stack = []; this.ageC = 0;
    for (let i = 0; i < 8; i++) this.vs.push(new Voice());
    this.hp = new HP4(); this.ins = [null, null]; this.mute = 0; this.solo = 0; this.peak = 0;
    // drum tracks play rendered samples instead of the voices: kit[d] = {L, R}, sv = sample voices
    this.drum = false; this.kit = []; this.sv = []; this.sl = 0; this.sr = 0; this.interp = 1;
    for (let i = 0; i < 16; i++) this.sv.push({ on: false, age: 0 });
    // defs: how each drum is made; dirty: changed since its sample was recorded; lr: the live recording in progress
    this.defs = []; this.dirty = []; this.lrs = []; this.eng = null;
    for (let i = 0; i < NPARAM; i++) this.set(i, this.k[i]);
  }
  setExact(x, tempo) {
    x = !!x; if (!!this.exact === x) return;
    this.exact = x; this.stack = [];
    this.vs = []; for (let i = 0; i < 8; i++) this.vs.push(x ? new VoiceX() : new Voice());
    for (const vo of this.vs) { for (let id = 0; id < 31; id++) vo.knob(id, this.k[id]); vo.setBpm(tempo || 120); }
  }
  setKind(drum) { if (this.drum !== !!drum) { this.allOff(); for (const v of this.sv) v.on = false; } this.drum = !!drum; }
  // e: p = drum index, v velocity, pt pitch in semitones, pn pan 0..127, st sample start 0..127
  // a drum edited since its last recording is played live from its voice and effects and recorded as it plays
  setDef(d, def) {
    const old = this.defs[d]; this.defs[d] = def; this.dirty[d] = true;
    const lr = this.liveOf(d); if (!lr) return;
    for (let id = 0; id < 31; id++) if (!old || old.k[id] !== def.k[id]) lr.v.knob(id, def.k[id]);
    lr.hp.set(def.k[31] || 0, def.k[32] || 0);
    lr.hold = Math.round(holdSec(def.hold) * SR);
    for (let s = 0; s < 2; s++) {
      const a = (def.ins || [])[s], o = old && (old.ins || [])[s], cur = lr.fx[s];
      if (!a) { lr.fx[s] = null; continue; }
      if (!cur || cur.type_ !== a.type) { lr.fx[s] = mkFx(a); if (lr.fx[s] && lr.fx[s].setTempo) lr.fx[s].setTempo(Math.round(this.eng.tempo)); continue; }
      cur.on = a.on !== false;
      for (const k in a.p) if (!o || !o.p || o.p[k] !== a.p[k]) cur.set(k, a.p[k]);
    }
  }
  liveOf(d) { for (const x of this.lrs) if (x.d === d && !x.stale) return x; return null; }
  // the hit plays the recording through an ordinary sample voice (pitch, pan, start, interpolation);
  // the recording is rendered just ahead of where that voice reads, so a lower pitch renders slower
  startLive(d, v) {
    const def = this.defs[d], tempo = this.eng ? this.eng.tempo : 120;
    const vo = drumVoice(def); vo.setBpm(tempo);
    for (let id = 0; id < 31; id++) vo.knob(id, def.k[id]);
    const hp = new HP4(); hp.set(def.k[31] || 0, def.k[32] || 0);
    const fx = [0, 1].map(s => mkFx((def.ins || [])[s]));
    for (const x of fx) if (x && x.setTempo) x.setTempo(Math.round(tempo));
    vo.resetLfo(); vo.rt = 1; vo.noteOn(def.note || 60, 127);
    const old = this.liveOf(d); if (old) old.stale = true;   // a new hit starts a new recording; the old one only feeds its fading voice
    const N = 2 * SR;
    const lr = { d, v: vo, hp, fx, L: new Float32Array(N), R: new Float32Array(N), pos: 0, hold: Math.round(holdSec(def.hold) * SR), fc: 0, sv: v, stale: false };
    v.lr = lr; this.lrs.push(lr);
    if (this.eng && this.eng.post) this.eng.post({ t: 'drec', tr: this.eng.tr.indexOf(this), d });
    return { L: lr.L, R: lr.R };
  }
  liveStep(lr) {
    if (lr.pos === lr.hold) lr.v.noteOff();
    if (--lr.fc <= 0) { lr.fc += FR; lr.v.frame(); for (const x of lr.fx) if (x && x.on && x.frame) x.frame(); }
    let l = lr.hp.p(lr.v.on || lr.v.exact ? lr.v.sample() : 0), r = l;
    for (const x of lr.fx) if (x && x.on) { x.proc(l, r); l = x.l; r = x.r; }
    lr.L[lr.pos] = l; lr.R[lr.pos] = r; lr.pos++;
    if (lr.pos < lr.L.length) return;
    const N = lr.L.length, fl = Math.round(0.02 * SR);
    for (let i = 0; i < fl; i++) { const k = i / fl; lr.L[N - 1 - i] *= k; lr.R[N - 1 - i] *= k; }
    this.lrs.splice(this.lrs.indexOf(lr), 1);
    if (lr.sv.lr === lr) lr.sv.lr = null;
    if (lr.stale) return;
    this.kit[lr.d] = { L: lr.L, R: lr.R }; this.dirty[lr.d] = false;
    if (this.eng && this.eng.post) this.eng.post({ t: 'dw', tr: this.eng.tr.indexOf(this), d: lr.d, w: wavePeaks(this.kit[lr.d], 160) });
  }
  // render each recording up to just past where its voice reads next; once the voice is gone, carry on in real time
  liveRun() {
    for (const lr of this.lrs.slice()) {
      const v = lr.sv, alive = v.on && v.lr === lr;
      if (!alive && lr.stale) { this.lrs.splice(this.lrs.indexOf(lr), 1); continue; }
      const need = alive ? Math.min(lr.L.length, Math.floor(v.pos + v.rate) + LIVE_AHEAD) : lr.pos + 1;
      while (lr.pos < need && this.lrs.includes(lr)) this.liveStep(lr);
    }
  }
  drumOn(e) {
    const live = this.dirty[e.p] && this.defs[e.p];
    if (!live && !this.kit[e.p]) return;
    for (const v of this.sv) if (v.on && v.d === e.p) v.rel = true;            // a drum chokes itself, like a DS-10 drum part
    let v = this.sv.find(x => !x.on);
    if (!v) v = this.sv.reduce((a, b) => (a.age < b.age ? a : b));
    const pn = (e.pn === undefined ? 64 : e.pn) * 258 / 32767;
    v.lr = null;
    const smp = live ? this.startLive(e.p, v) : this.kit[e.p];
    v.on = true; v.d = e.p; v.L = smp.L; v.R = smp.R; v.n = smp.L.length; v.pos = (e.st || 0) / 128 * v.n;
    v.rate = Math.pow(2, (e.pt || 0) / 12); v.g = e.v / 127; v.pl = 1 - pn; v.pr = pn; v.rel = false; v.fade = 1; v.age = ++this.ageC; v.id = e.id;
  }
  // a note-off releases only the hit its note-on started (by id); without an id, every hit of that drum
  drumOff(p, id) { for (const v of this.sv) if (v.on && v.d === p && (id === undefined || v.id === id)) v.rel = true; }   // a live recording carries on to its 2 s; HOLD ends its note
  stereo() {
    let l = 0, r = 0;
    if (this.lrs.length) this.liveRun();
    for (const v of this.sv) {
      if (!v.on) continue;
      const i = v.pos | 0;
      if (i + 1 >= v.n) { v.on = false; continue; }
      const f = v.pos - i;
      let g = v.g;
      if (v.rel) { v.fade -= DRUM_FADE; if (v.fade <= 0) { v.on = false; continue; } g *= v.fade; }
      let a, b;
      if (this.interp === 0) { a = v.L[i] + (v.L[i + 1] - v.L[i]) * f; b = v.R[i] + (v.R[i + 1] - v.R[i]) * f; }
      else if (this.interp === 1) { a = hermite(v.L, i, f, v.n); b = hermite(v.R, i, f, v.n); }
      else { a = sincRead(v.L, i, f, v.n, v.rate); b = sincRead(v.R, i, f, v.n, v.rate); }
      l += a * g * v.pl; r += b * g * v.pr;
      v.pos += v.rate;
    }
    this.sl = l; this.sr = r;
  }
  set(id, v) {
    if (id >= NPARAM) {
      // 37..52: knob j of insert slot s, id = 37 + s*8 + j, in the order of that effect's controls
      const s = (id - NPARAM) >> 3, fx = this.ins[s];
      if (fx) { const key = FXKEYS[fx.type_][(id - NPARAM) & 7]; if (key) fx.set(key, Math.round(v)); }
      return;
    }
    this.k[id] = v;
    if (id < 31) { for (const vo of this.vs) vo.knob(id, v); return; }
    if (id <= 32) this.hp.set(this.k[31], this.k[32]);
    this.g = volGain(this.k[33]); this.pr = this.k[34] * 258 / 32767; this.pl = 1 - this.pr;
    this.ga = volGain(this.k[35]); this.gb = volGain(this.k[36]);
  }
  setNv(n) {
    n = clampi(n | 0, 1, 8);
    for (const vo of this.vs) if (vo.gate) vo.noteOff();
    this.nv = n; this.stack = [];
  }
  noteOn(p, v) {
    if (this.nv === 1) {
      this.stack = this.stack.filter(x => x !== p); this.stack.push(p);
      this.vs[0].noteOn(p, v); return;
    }
    let best = null;
    for (let i = 0; i < this.nv; i++) { const vo = this.vs[i]; if (vo.on && vo.note === p) { best = vo; break; } }
    if (!best) for (let i = 0; i < this.nv; i++) if (!this.vs[i].on) { best = this.vs[i]; break; }
    if (!best) {
      let rel = null, old = null;
      for (let i = 0; i < this.nv; i++) {
        const vo = this.vs[i];
        if (!vo.gate && (!rel || vo.age < rel.age)) rel = vo;
        if (!old || vo.age < old.age) old = vo;
      }
      best = rel || old;
    }
    best.rt = 1; best.noteOn(p, v); best.age = ++this.ageC;
  }
  noteOff(p) {
    if (this.nv === 1) {
      const vo = this.vs[0], top = this.stack[this.stack.length - 1];
      this.stack = this.stack.filter(x => x !== p);
      if (!this.stack.length) { if (vo.gate) vo.noteOff(); }
      else if (top === p) vo.noteOn(this.stack[this.stack.length - 1], vo.vg * 127);
      return;
    }
    for (let i = 0; i < this.nv; i++) { const vo = this.vs[i]; if (vo.gate && vo.note === p) vo.noteOff(); }
  }
  allOff() { this.stack = []; for (const vo of this.vs) if (vo.gate) vo.noteOff(); if (this.sv) for (const v of this.sv) if (v.on) v.rel = true; }
  frame() { for (let i = 0; i < this.nv; i++) this.vs[i].frame(); for (let i = this.nv; i < 8; i++) if (this.vs[i].on) this.vs[i].frame(); }
  sample() {
    let m = 0;
    if (this.exact) { for (let i = 0; i < this.nv; i++) m += this.vs[i].sample(); }   // exact voices run continuously, as on the DS
    else for (let i = 0; i < 8; i++) { const vo = this.vs[i]; if (vo.on) m += vo.sample(); }
    return this.hp.p(m);
  }
}

/* ---------------- effects ---------------- */

// DS-10 delay / chorus / flanger: one fractional delay line, three mappings
class FxDS10 {
  constructor() {
    this.N = 1 << 17; this.M = this.N - 1; this.bl = new Float32Array(this.N); this.br = new Float32Array(this.N); this.w = 0;
    this.type = 0; this.sync = 0; this.tempo = 120;
    this.kt = 64; this.kr = 0; this.kl = 64; this.kd = 64; this.kf = 0; this.kw = 64; this.fbOn = 1;
    this.ll = [0, 0, 0]; this.lr = [0, 0, 0]; this.lph = 0; this.linc = 0; this.depth = 0; this.fb = 0; this.time = 0x8000;
    this.sml = 0x8000; this.smr = 0x8000; this.rl = 1; this.rlT = 1; this.rlD = 0; this.rr = 1; this.rrT = 1; this.rrD = 0;
    this.fbv = 0; this.fbT = 0; this.fbD = 0; this.dry = 1; this.wet = 0; this.ratL = 32767; this.ratR = 32767;
    this.l = 0; this.r = 0; this.reapply();
  }
  mapTime(v) {
    if (this.type === 1) { this.time = 0x728C49; return; }
    if (this.type === 2) { this.time = 0x25050; return; }
    const div = this.sync ? this.tempo : 0;
    if (div === 0) { this.time = v !== 0 ? I(I(v, v), 0x103BA) : 0x8000; return; }
    let idx = 11;
    for (let i = 11; i >= 0; i--) if ((T.fx_delay_div[i] >>> 15) < (div << 16)) { idx = i; break; }
    if ((v >> 3) < 0) idx = 0; else if ((v >> 3) <= idx) idx = v >> 3;
    let q = fl(T.fx_delay_div[idx] / div); const r = T.fx_delay_div[idx] % div;
    if (q > 0xFFFF) q = 0xFFFF;
    this.time = (r >> 16) + (q << 15);
  }
  mapRatio(v) {
    if (this.type === 0) { if (v > 0) { this.ratL = 32767; this.ratR = 32767 - v * 0x1C7; } else { this.ratL = v * 0x1C7 + 32767; this.ratR = 32767; } }
    else if (this.type === 1) { this.ratL = 0x5B6D; this.ratR = 32767; }
    else { this.ratL = 32767; this.ratR = 32767; }
  }
  mapDepth(v) { this.depth = this.type === 0 ? 0 : fl(T.fx_depth[v] * 0x0105D2F1 / 32768); }
  mapFb(v) {
    if (this.type === 0) this.fb = v >= 0x3F ? 32767 : (v + 0x3F) * 0x105;
    else if (this.type === 1) this.fb = 0;
    else this.fb = -T.fx_flanger_fb[63 + v];
  }
  mapMix(v) {
    const a = v * 258, b = 32766 - a;
    this.dry = (32764 - (I(a, a) >> 15)) / 32768; this.wet = (32764 - (I(b, b) >> 15)) / 32768;
  }
  reapply() {
    this.fbOn = this.type === 1 ? 0 : 1;
    this.mapTime(this.kt); this.mapRatio(this.kr); this.linc = T.fx_lfo_rate[this.kl] | 0;
    this.mapDepth(this.kd); this.mapFb(this.kf); this.mapMix(this.kw);
  }
  set(k, v) {
    switch (k) {
      case 'type': v = clampi(v, 0, 2); if (v !== this.type) { this.type = v; this.reapply(); } break;
      case 'time': this.kt = v; this.mapTime(v); break;
      case 'ratio': this.kr = v; this.mapRatio(v); break;
      case 'lfo': this.kl = v; this.linc = T.fx_lfo_rate[v] | 0; break;
      case 'depth': this.kd = v; this.mapDepth(v); break;
      case 'sync': this.sync = v; this.mapTime(this.kt); break;
      case 'fb': this.kf = v; this.mapFb(v); break;
      case 'mix': this.kw = v; this.mapMix(v); break;
    }
  }
  setTempo(b) { this.tempo = b | 0; this.mapTime(this.kt); }
  tap3(ph, out) {
    let a = ph >> 16; if (a < 1) a = -a;
    const c = I(I(a, a) >> 15, a) >> 15;
    out[1] = a; out[2] = c === 0 ? 1 : c;
  }
  frame() {
    const sm = (c, t) => fl((30439 * c + 2329 * t) / 32768);
    this.lph = (this.lph - this.linc) | 0;
    this.tap3(this.lph, this.ll); this.tap3((this.lph + T.fx_lfo_phase[this.type]) | 0, this.lr);
    const toHost = SR / (32768 * 32768);
    let base = m15(this.time, this.ratL); if (base < 0x8001) base = 0x8000;
    this.sml = sm(this.sml, base + m15(this.depth, this.ll[this.type]));
    const tl = Math.max(1, this.sml * toHost);
    this.rl = this.rlT; this.rlD = (tl - this.rlT) / FR; this.rlT = tl;
    base = m15(this.time, this.ratR); if (base < 0x8001) base = 0x8000;
    this.smr = sm(this.smr, base + m15(this.depth, this.lr[this.type]));
    const tr = Math.max(1, this.smr * toHost);
    this.rr = this.rrT; this.rrD = (tr - this.rrT) / FR; this.rrT = tr;
    const ft = this.fb * this.fbOn / 32768;
    this.fbv = this.fbT; this.fbD = (ft - this.fbT) / FR; this.fbT = ft;
  }
  tap(b, w, d) {
    const di = fl(d), f = d - di, i = (w - di) & this.M, a = b[i];
    return a + f * (b[(i - 1) & this.M] - a);
  }
  proc(l, r) {
    const w = this.w, dl = this.tap(this.bl, w, this.rl), dr = this.tap(this.br, w, this.rr);
    let x = l + dl * this.fbv; this.bl[w] = x > 1 ? 1 : x < -1 ? -1 : x;
    x = r + dr * this.fbv; this.br[w] = x > 1 ? 1 : x < -1 ? -1 : x;
    this.w = (w + 1) & this.M;
    this.l = l * this.dry + dl * this.wet; this.r = r * this.dry + dr * this.wet;
    this.fbv += this.fbD; this.rl += this.rlD; this.rr += this.rrD;
  }
}

// Midiverb / Midifex / Midiverb II, run at 24 kHz like the VST3 port
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  lp(sr, fc, Q) {
    const w = 2 * Math.PI * fc / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  p(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
class LP8 {
  constructor(fc) { this.s = [0.5097956518, 0.6013448869, 0.8999197654, 2.5629154478].map(q => { const b = new Biquad(); b.lp(SR, fc, q); return b; }); }
  p(x) { for (let i = 0; i < 4; i++) x = this.s[i].p(x); return x; }
}
// LFO patches of the Midiverb II flangers/choruses (programs 50-69): [prog, sine?, max, top1, top2, rate1, rate2]
const MV_LFO = [
  [50, 0, 0x3fff, 0, 0, 3, 3], [51, 0, 0x3fff, 0, 0, 3, 5], [52, 0, 0x3fff, 0, 0, 5, 5], [53, 0, 0x7fff, 0, 0, 6, 7],
  [54, 0, 0x7fff, 0, 0, 5, 5], [55, 0, 0x7fff, 0, 0, 12, 12], [56, 0, 0x7fff, 0, 0, 17, 17], [57, 0, 0xffff, 0, 0, 19, 23],
  [58, 0, 0xffff, 0, 0, 13, 14], [59, 0, 0xffff, 0, 0, 23, 17], [60, 1, 0x7eff, 1, 3, 0x27, 0x1b], [61, 1, 0x3eff, 2, 3, 0x2e, 0x3d],
  [62, 1, 0x7eff, 2, 1, 0x2d, 0x3a], [63, 1, 0x7eff, 3, 2, 0x40, 0x45], [64, 1, 0x3eff, 2, 3, 0x4f, 0x79], [65, 1, 0x3eff, 2, 1, 0x94, 0x7a],
  [66, 1, 0x7eff, 2, 1, 0x4f, 0x41], [67, 1, 0x3eff, 1, 2, 0x70, 0x8e], [68, 1, 0x1eff, 1, 1, 0xea * 4, 0xd9 * 4], [69, 1, 0x1eff, 1, 1, 0xff * 4, 0xff * 4]];
class MvLfo {
  constructor(sine, max, rate) {
    this.sine = sine; this.max = max; this.rate = rate;
    if (sine) { this.x = 0; this.y = max & 0xff00; } else { this.v = 0; this.dir = 1; }
  }
  update() {
    if (!this.sine) {
      if (this.dir) { this.v += this.rate; if (this.v > this.max) { this.v = this.max; this.dir = 0; } }
      else { this.v -= this.rate; if (this.v < 0) { this.v = 0; this.dir = 1; } }
      return this.v;
    }
    const cp = (this.max << 16) >> 16, cn = -cp, r = (this.rate << 16) >> 16;
    this.y += (this.x * r) >> 16; if (this.y > cp) this.y = cp; if (this.y < cn) this.y = cn;
    this.x -= (this.y * r) >> 16; if (this.x > cp) this.x = cp; if (this.x < cn) this.x = cn;
    return (this.x ^ 0x8000) & 0xffff;
  }
}
class FxMverb {
  constructor() {
    this.D = new Int16Array(16384); this.ptr = 0; this.ph = 0; this.inc = 24000 / SR;
    this.aa = new LP8(10000); this.rcL = new LP8(10000); this.rcR = new LP8(10000);
    this.i0 = 0; this.i1 = 0; this.l0 = 0; this.l1 = 0; this.r0 = 0; this.r1 = 0; this.wl = 0; this.wr = 0;
    this.o = [0, 0]; this.dev = 2; this.prog = 15; this.fb = 0; this.l = 0; this.r = 0;
    this.v1 = 0; this.v2 = 0; this.lc = 0; this.mapMix(64); this.setProg();
  }
  setProg() {
    const d = MV_DEV[this.dev];
    this.prog = clampi(this.prog, 0, d.fx.length - 1);
    this.fn = d.fx[this.prog];
    this.lp = null; this.v1 = 0; this.v2 = 0;
    if (this.dev === 2) {
      const e = MV_LFO.find(x => x[0] === this.prog);
      if (e) { this.lp = e; this.la = new MvLfo(e[1], e[2], e[5]); this.lb = new MvLfo(e[1], e[2], e[6]); this.stepLfo(); }
    }
  }
  stepLfo() { this.v1 = this.la.update() | (this.lp[3] << 16); this.v2 = this.lb.update() | (this.lp[4] << 16); }
  mapMix(v) { const a = v / 127 * Math.PI / 2; this.dg = Math.cos(a); this.wg = Math.sin(a); }
  set(k, v) {
    if (k === 'dev') { this.dev = clampi(v, 0, 2); this.setProg(); }
    else if (k === 'prog') { this.prog = v; this.setProg(); }
    else if (k === 'fb') this.fb = v / 127;
    else if (k === 'mix') this.mapMix(v);
  }
  proc(l, r) {
    const mono = (l + r) * 0.5 + (this.wl + this.wr) * 0.5 * this.fb;
    this.i0 = this.i1; this.i1 = this.aa.p(mono);
    this.ph += this.inc;
    while (this.ph >= 1) {
      this.ph -= 1;
      const fr = 1 - this.ph / this.inc;
      let x = this.i0 + fr * (this.i1 - this.i0); x = x > 1 ? 1 : x < -1 ? -1 : x;
      this.fn((x * 0x0fff) | 0, this.D, this.ptr, this.v1, this.v2, this.o);
      this.ptr = (this.ptr + 1) & 16383;
      if (this.lp && ++this.lc >= 8) { this.lc = 0; this.stepLfo(); }
      this.l0 = this.l1; this.l1 = this.o[0] / 0x0fff; this.r0 = this.r1; this.r1 = this.o[1] / 0x0fff;
    }
    this.wl = this.rcL.p(this.l0 + this.ph * (this.l1 - this.l0));
    this.wr = this.rcR.p(this.r0 + this.ph * (this.r1 - this.r0));
    this.l = l * this.dg + this.wl * this.wg; this.r = r * this.dg + this.wr * this.wg;
  }
}

// camouflage FakeTapeDelay: fixed tape length, variable speed
class TapeLine {
  constructor(ms) { this.n = Math.max(64, fl(ms / 1000 * SR)); this.b = new Float32Array(this.n); this.tp = 0; this.lf = 0; this.s = [0, 0, 0, 0]; this.del = 0; }
  proc(x, speed, fb) {
    const n = this.n, rp = (this.tp + 50) % n, ir = rp | 0, ir1 = (ir + 1) % n, f = rp - ir;
    const del = (1 - f) * this.b[ir] + f * this.b[ir1];
    const mix = x + fb * del;
    const fc = (speed < 1 ? speed : 1) * SR * 0.5, RC = 1 / (2 * Math.PI * fc), dt = 1 / SR, al = dt / (RC + dt);
    let y = mix; const s = this.s;
    for (let i = 0; i < 4; i++) { s[i] = al * y + (1 - al) * s[i]; y = s[i]; }
    const ntp = this.tp + speed, it = this.tp | 0, nit = ntp | 0;
    for (let ip = it + 1; ip <= nit; ip++) { const p = (ip - this.tp) / speed; this.b[ip % n] = this.lf * (1 - p) + y * p; }
    this.lf = y; this.tp = ntp % n; this.del = del;
    return del;
  }
}
const TAPE_MS = [30, 100, 300, 1000];
class FxTape {
  constructor() { this.speed = 1; this.fb = 0.7; this.len = 2; this.mk(); this.mapMix(64); this.l = 0; this.r = 0; }
  mk() { this.a = new TapeLine(TAPE_MS[this.len]); this.b = new TapeLine(TAPE_MS[this.len]); }
  mapMix(v) { const a = v * 258, b = 32766 - a; this.dry = (32764 - (I(a, a) >> 15)) / 32768; this.wet = (32764 - (I(b, b) >> 15)) / 32768; }
  set(k, v) {
    if (k === 'speed') this.speed = 0.1 + 1.9 * v / 127;
    else if (k === 'fb') this.fb = v / 127;
    else if (k === 'len') { v = clampi(v, 0, 3); if (v !== this.len) { this.len = v; this.mk(); } }
    else if (k === 'mix') this.mapMix(v);
  }
  proc(l, r) {
    const dl = this.a.proc(l, this.speed, this.fb), dr = this.b.proc(r, this.speed, this.fb);
    this.l = l * this.dry + dl * this.wet; this.r = r * this.dry + dr * this.wet;
  }
}

// simple asymmetric soft-clip distortion with a tone low-pass
class FxDist {
  constructor() { this.zl = 0; this.zr = 0; this.set('drive', 64); this.set('tone', 90); this.set('level', 80); this.set('mix', 127); this.l = 0; this.r = 0; }
  set(k, v) {
    if (k === 'drive') this.g = Math.pow(10, (v / 127) * 40 / 20);
    else if (k === 'tone') { const fc = 400 * Math.pow(40, v / 127); this.a = 1 - Math.exp(-2 * Math.PI * Math.min(fc, SR * 0.45) / SR); }
    else if (k === 'level') this.lv = (v / 127) * (v / 127) * 1.5;
    else if (k === 'mix') this.m = v / 127;
  }
  sh(x) { return Math.tanh(x + 0.2) - 0.19738; }
  proc(l, r) {
    this.zl += this.a * (this.sh(l * this.g) - this.zl); this.zr += this.a * (this.sh(r * this.g) - this.zr);
    this.l = l * (1 - this.m) + this.zl * this.lv * this.m; this.r = r * (1 - this.m) + this.zr * this.lv * this.m;
  }
}

const FXC = { ds10: FxDS10, mverb: FxMverb, tape: FxTape, dist: FxDist };
const FXKEYS = { ds10: ['type', 'time', 'ratio', 'lfo', 'depth', 'sync', 'fb', 'mix'], mverb: ['dev', 'prog', 'fb', 'mix'], tape: ['speed', 'fb', 'len', 'mix'], dist: ['drive', 'tone', 'level', 'mix'] };
function mkFx(d) {
  if (!d || !FXC[d.type]) return null;
  const fx = new FXC[d.type](); fx.type_ = d.type; fx.on = d.on !== false;
  for (const k in (d.p || {})) fx.set(k, d.p[k]);
  return fx;
}

/* ---------------- engine ---------------- */
class Engine {
  constructor() {
    this.tr = []; for (let i = 0; i < 8; i++) { const t = new Track(); t.eng = this; this.tr.push(t); }
    this.bus = [{ ins: [null, null], g: volGain(100) }, { ins: [null, null], g: volGain(100) }];
    this.mst = { ins: [null, null], g: volGain(100), shp: 0 };
    this.q = []; this.qs = false; this.fcnt = 0; this.tempo = 120; this.solo = false;
    this.mcnt = 0; this.ml = 0; this.mr = 0; this.post = null;
  }
  slot(w) { return w.s === 't' ? this.tr[w.i].ins : w.s === 'b' ? this.bus[w.i].ins : this.mst.ins; }
  allFx(f) {
    for (const t of this.tr) for (const x of t.ins) if (x) f(x);
    for (const b of this.bus) for (const x of b.ins) if (x) f(x);
    for (const x of this.mst.ins) if (x) f(x);
  }
  setTempo(b) {
    this.tempo = b; for (const t of this.tr) for (const v of t.vs) v.setBpm(b);
    this.allFx(x => x.setTempo && x.setTempo(Math.round(b)));
  }
  cfg(c) {
    c.tracks.forEach((t, i) => {
      const tr = this.tr[i]; if (!tr) return;
      tr.setExact(t.exact, this.tempo); tr.setNv(t.nv || 1); t.k.forEach((v, id) => { if (id < NPARAM) tr.set(id, v); });
      tr.mute = t.mute ? 1 : 0; tr.solo = t.solo ? 1 : 0;
      tr.ins = (t.ins || [null, null]).map(mkFx);
      tr.setKind(t.kind === 'drum'); tr.interp = t.interp ?? 1;
      if (tr.drum) this.renderKit(i, t.drums || []);
    });
    c.buses.forEach((b, i) => { this.bus[i].ins = (b.ins || []).map(mkFx); this.bus[i].g = volGain(b.ret); });
    this.mst.ins = (c.master.ins || []).map(mkFx); this.mst.g = volGain(c.master.vol); this.mst.shp = c.master.shp ? 1 : 0;
    this.updSolo(); this.setTempo(c.tempo || 120);
  }
  renderKit(ti, drums) { drums.forEach((d, j) => this.renderOne(ti, j, d)); }
  renderOne(ti, j, d) {
    const tr = this.tr[ti];
    if (tr.liveOf(j)) { if (d) tr.setDef(j, d); return; }   // a live recording of this drum finishes it instead
    tr.defs[j] = d; tr.dirty[j] = false;
    tr.kit[j] = d ? renderDrum(d, this.tempo || 120) : null;
    if (this.post) this.post({ t: 'dw', tr: ti, d: j, w: tr.kit[j] ? wavePeaks(tr.kit[j], 160) : null });
  }
  updSolo() { this.solo = this.tr.some(t => t.solo); }
  msg(m) {
    switch (m.t) {
      case 'cfg': this.cfg(m.c); break;
      case 'ev':
        for (const e of m.ev) { e.f = e.time > 0 ? Math.round(e.time * SR) : 0; this.q.push(e); }
        this.qs = true; break;
      case 'nv': this.tr[m.tr].setNv(m.n); break;
      case 'kind': this.tr[m.tr].setKind(m.kind === 'drum'); if (m.kind === 'drum') this.renderKit(m.tr, m.drums || []); break;
      case 'drum': this.renderOne(m.tr, m.d, m.def); break;
      case 'drumdef': this.tr[m.tr].setDef(m.d, m.def); break;
      case 'interp': this.tr[m.tr].interp = m.v; break;
      case 'exact': this.tr[m.tr].setExact(m.v, this.tempo); break;
      case 'mute': this.tr[m.tr].mute = m.m ? 1 : 0; this.tr[m.tr].solo = m.s ? 1 : 0; this.updSolo(); break;
      case 'fx': { const s = this.slot(m.w); s[m.slot] = mkFx(m.fx); if (s[m.slot] && s[m.slot].setTempo) s[m.slot].setTempo(Math.round(this.tempo)); break; }
      case 'fxp': { const x = this.slot(m.w)[m.slot]; if (x) { if (m.k === 'on') x.on = !!m.v; else x.set(m.k, m.v); } break; }
      case 'bus': this.bus[m.i].g = volGain(m.ret); break;
      case 'mst': this.mst.g = volGain(m.vol); this.mst.shp = m.shp ? 1 : 0; break;
      case 'panic': this.q = []; for (const t of this.tr) { t.allOff(); for (const v of t.vs) { v.on = false; v.lvl = v.lvT = v.lvd = 0; } } break;
    }
  }
  apply(e) {
    const t = this.tr[e.tr];
    switch (e.k) {
      case 'on': if (t.drum) t.drumOn(e); else t.noteOn(e.p, e.v); break;
      case 'off': if (t.drum) t.drumOff(e.p, e.id); else t.noteOff(e.p); break;
      case 'knob': t.set(e.id, e.v); break;
      case 'tempo': this.setTempo(e.v); break;
      case 'play': for (const tr of this.tr) for (const v of tr.vs) v.resetLfo(); break;
      case 'alloff': for (const tr of this.tr) tr.allOff(); break;
    }
  }
  render(L, R, n, f0) {
    if (this.qs) { this.q.sort((a, b) => a.f - b.f); this.qs = false; }
    const q = this.q; let qi = 0;
    const tr = this.tr, bus = this.bus, mst = this.mst;
    for (let i = 0; i < n; i++) {
      const f = f0 + i;
      while (qi < q.length && q[qi].f <= f) this.apply(q[qi++]);
      if (--this.fcnt <= 0) {
        this.fcnt += FR;
        for (let t = 0; t < 8; t++) tr[t].frame();
        this.allFx(x => x.frame && x.frame());
      }
      let ml = 0, mr = 0, al = 0, ar = 0, bl = 0, br = 0;
      for (let t = 0; t < 8; t++) {
        const T_ = tr[t];
        let l, r;
        if (T_.drum) { T_.stereo(); l = T_.sl * T_.pl * 2; r = T_.sr * T_.pr * 2; }   // pan acts as balance on the stereo samples
        else { const m = T_.sample(); l = m * T_.pl; r = m * T_.pr; }
        for (let s = 0; s < 2; s++) { const x = T_.ins[s]; if (x && x.on) { x.proc(l, r); l = x.l; r = x.r; } }
        const audible = !T_.mute && (!this.solo || T_.solo);
        l *= T_.g; r *= T_.g;
        if (!audible) continue;
        const a = l > 0 ? l : -l; if (a > T_.peak) T_.peak = a;
        const b = r > 0 ? r : -r; if (b > T_.peak) T_.peak = b;
        ml += l; mr += r; al += l * T_.ga; ar += r * T_.ga; bl += l * T_.gb; br += r * T_.gb;
      }
      for (let b = 0; b < 2; b++) {
        let l = b ? bl : al, r = b ? br : ar; const B = bus[b];
        for (let s = 0; s < 2; s++) { const x = B.ins[s]; if (x && x.on) { x.proc(l, r); l = x.l; r = x.r; } }
        ml += l * B.g; mr += r * B.g;
      }
      for (let s = 0; s < 2; s++) { const x = mst.ins[s]; if (x && x.on) { x.proc(ml, mr); ml = x.l; mr = x.r; } }
      ml *= mst.g; mr *= mst.g;
      if (mst.shp) {
        // DS-10 master soft-knee shaper
        const sh = x => { x = x > 1 ? 1 : x < -1 ? -1 : x; const ref = x < 0 ? -1 : 1, d = x - ref; return ref + d * Math.abs(d); };
        ml = sh(ml); mr = sh(mr);
      }
      ml = ml > 1 ? 1 : ml < -1 ? -1 : ml; mr = mr > 1 ? 1 : mr < -1 ? -1 : mr;
      if (ml !== ml || mr !== mr) { ml = mr = 0; }
      L[i] = ml; if (R) R[i] = mr;
      const a = ml > 0 ? ml : -ml, b = mr > 0 ? mr : -mr;
      if (a > this.ml) this.ml = a; if (b > this.mr) this.mr = b;
    }
    if (qi) q.splice(0, qi);
    this.mcnt += n;
    if (this.mcnt >= 2048 && this.post) {
      this.mcnt = 0;
      this.post({ t: 'm', tr: tr.map(t => t.peak), l: this.ml, r: this.mr, v: tr.map(t => t.drum ? t.sv.reduce((s, v) => s + (v.on && !v.rel ? 1 : 0), 0) : t.vs.reduce((s, v) => s + (v.gate ? 1 : 0), 0)) });
      for (const t of tr) t.peak = 0; this.ml = this.mr = 0;
    }
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('arranger-st10', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.e = new Engine();
      this.e.post = m => this.port.postMessage(m);
      this.port.onmessage = ev => this.e.msg(ev.data);
    }
    process(inputs, outputs) {
      const o = outputs[0];
      this.e.render(o[0], o[1], o[0].length, currentFrame);
      return true;
    }
  });
}
