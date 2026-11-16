'use strict';
/* global JsBarcode */
const api = window.thermal;

const INK = '#18181c';
const PAPER = '#fbfaf6';
const FONTS = { A: { w: 12, h: 24, px: 22 }, B: { w: 9, h: 17, px: 16 } };
const FONT_FAMILY = 'Consolas, "Courier New", monospace';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const feedEl = $('feed');
const led = $('led');

let cfg = { printableDots: 576, paperDots: 640, scale: 0.6, speed: 120, sound: true, maxReceipts: 30, paper: 80 };
const receipts = []; // { el, win, paper, content, h, cut, text: [] }
let current = null;
let stick = true;
let lastOpAt = 0;

// ------------------------------------------------------------------ medidas de fonte

const measureCtx = document.createElement('canvas').getContext('2d');
const hScale = {};
function fontSpec(f, bold) { return `${bold ? 700 : 400} ${FONTS[f].px}px ${FONT_FAMILY}`; }
function squeeze(f, bold) {
  const key = f + bold;
  if (!(key in hScale)) {
    measureCtx.font = fontSpec(f, bold);
    const adv = measureCtx.measureText('MMMMMMMMMM').width / 10;
    hScale[key] = FONTS[f].w / adv;
  }
  return hScale[key];
}

// ------------------------------------------------------------------ canvas util

function dotCanvas(wDots, hDots) {
  const q = cfg.scale * (window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cfg.printableDots * q));
  c.height = Math.max(1, Math.round(hDots * q));
  const ctx = c.getContext('2d');
  ctx.scale(c.width / cfg.printableDots, c.height / hDots);
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

function bitmap(w, h, px) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  if (!w || !h) return c; // imagem vazia (largura/altura 0) não pode derrubar o cupom
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const ink = [0x18, 0x18, 0x1c];
  for (let i = 0; i < w * h; i++) {
    if (px[i]) { const o = i * 4; img.data[o] = ink[0]; img.data[o + 1] = ink[1]; img.data[o + 2] = ink[2]; img.data[o + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function alignX(align, width) {
  if (align === 1) return Math.max(0, (cfg.printableDots - width) / 2);
  if (align === 2) return Math.max(0, cfg.printableDots - width);
  return 0;
}

// ------------------------------------------------------------------ desenho das operações

function drawLine(op) {
  const { c, ctx } = dotCanvas(cfg.printableDots, op.height);
  let x = alignX(op.align, op.width);
  const base = op.contentH;
  let text = '';
  for (const it of op.items) {
    if (it.k === 's') { x += it.cw; text += ' '.repeat(Math.max(1, Math.round(it.cw / 12))); continue; }
    if (it.k === 'img') {
      ctx.drawImage(bitmap(it.w, it.h, it.px), x, base - it.h);
      x += it.w; text += '▒';
      continue;
    }
    const f = FONTS[it.f];
    const cw = it.cw, ch = f.h * it.h, top = base - ch;
    if (it.i) { ctx.fillStyle = INK; ctx.fillRect(x, top, cw, ch); }
    ctx.save();
    ctx.translate(x + cw / 2, top + ch / 2);
    ctx.scale(squeeze(it.f, it.b) * it.w, it.h);
    ctx.font = fontSpec(it.f, it.b);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = it.i ? PAPER : INK;
    ctx.fillText(it.ch, 0, 1);
    if (it.b) ctx.fillText(it.ch, 0.7, 1);
    ctx.restore();
    if (it.u) { ctx.fillStyle = it.i ? PAPER : INK; ctx.fillRect(x, top + ch - it.u - 1, cw, it.u); }
    x += cw;
    text += it.ch;
  }
  return { el: c, text: text.replace(/\s+$/, '') };
}

function drawImage(op) {
  const w = op.w * op.sx, h = op.h * op.sy;
  const { c, ctx } = dotCanvas(cfg.printableDots, h);
  ctx.drawImage(bitmap(op.w, op.h, op.px), alignX(op.align, w), 0, w, h);
  return { el: c, text: '[imagem]' };
}

function drawQr(op) {
  const dim = op.size * op.module;
  const pad = 8;
  const { c, ctx } = dotCanvas(cfg.printableDots, dim + pad * 2);
  const x0 = alignX(op.align, dim);
  ctx.fillStyle = INK;
  for (let y = 0; y < op.size; y++) {
    for (let x = 0; x < op.size; x++) {
      if (op.bits[y * op.size + x]) ctx.fillRect(x0 + x * op.module, pad + y * op.module, op.module, op.module);
    }
  }
  return { el: c, text: `[QR: ${op.text}]` };
}

function drawBarcode(op) {
  const tmp = document.createElement('canvas');
  try {
    JsBarcode(tmp, op.data, {
      format: op.format, width: op.width, height: op.height, margin: 0,
      displayValue: op.hri > 0, textPosition: op.hri === 1 ? 'top' : 'bottom',
      font: 'Consolas', fontSize: 22, textMargin: 4,
      background: 'rgba(0,0,0,0)', lineColor: INK,
    });
  } catch (e) {
    return notice(`[código de barras ${op.format} inválido: "${op.data}"]`);
  }
  const pad = 6;
  const w = Math.min(tmp.width, cfg.printableDots);
  const { c, ctx } = dotCanvas(cfg.printableDots, tmp.height + pad * 2);
  ctx.drawImage(tmp, alignX(op.align, w), pad, w, tmp.height);
  return { el: c, text: `[${op.format}: ${op.data}]` };
}

function notice(text) {
  const d = document.createElement('div');
  d.className = 'notice';
  d.textContent = text;
  return { el: d, text };
}

function feedSpacer(dots) {
  const d = document.createElement('div');
  d.style.height = `calc(${dots}px * var(--scale))`;
  return { el: d, text: '' };
}

// ------------------------------------------------------------------ papel

function newReceipt() {
  const el = document.createElement('div');
  el.className = 'receipt';
  el.innerHTML = '<div class="win"><div class="paper torn-top"><div class="content"></div></div></div>';
  const r = { el, win: el.firstChild, paper: el.querySelector('.paper'), content: el.querySelector('.content'), h: 0, cut: false, text: [] };
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.receiptMenu({ text: r.text.join('\n'), png: exportPng(r) }); });
  feedEl.appendChild(el);
  receipts.push(r);
  while (receipts.length > cfg.maxReceipts) receipts.shift().el.remove();
  return r;
}

function append({ el, text }) {
  if (!current) current = newReceipt();
  current.content.appendChild(el);
  if (text !== undefined && text !== '' || el.tagName === 'CANVAS') current.text.push(text);
}

function handleOp(op) {
  switch (op.type) {
    case 'line': append(drawLine(op)); break;
    case 'feed': append(feedSpacer(op.dots)); break;
    case 'image': append(drawImage(op)); break;
    case 'qr': append(drawQr(op)); break;
    case 'barcode': append(drawBarcode(op)); break;
    case 'notice': append(notice(op.text)); break;
    case 'cut':
      if (current) { current.paper.classList.add('torn-bottom'); current.cut = true; current = null; }
      break;
    case 'drawer': toast('💰 Gaveta de dinheiro acionada'); sound.click(); break;
    case 'beep': toast('🔔 Bip'); sound.beep(); break;
    default: break;
  }
}

function clearAll() {
  for (const r of receipts) r.el.remove();
  receipts.length = 0;
  current = null;
}

function exportPng(r) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(r.paper.offsetWidth * dpr);
  const H = Math.round(r.paper.offsetHeight * dpr);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const base = r.paper.getBoundingClientRect();
  for (const child of r.content.children) {
    const b = child.getBoundingClientRect();
    const x = (b.left - base.left) * dpr, y = (b.top - base.top) * dpr;
    if (child.tagName === 'CANVAS') ctx.drawImage(child, x, y, b.width * dpr, b.height * dpr);
    else if (child.classList.contains('notice')) {
      ctx.fillStyle = '#a33'; ctx.font = `${11 * dpr}px Consolas`; ctx.fillText(child.textContent, x, y + 14 * dpr, b.width * dpr);
    }
  }
  return c.toDataURL('image/png');
}

// ------------------------------------------------------------------ animação do papel subindo

let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  let moving = false;
  for (const r of receipts) {
    const target = r.paper.offsetHeight;
    if (r.h >= target) {
      if (r.cut && !r.el.classList.contains('cut')) { r.el.classList.add('cut'); sound.click(); }
      continue;
    }
    const pxPerSec = cfg.speed > 0 ? cfg.speed * 8 * cfg.scale : Infinity;
    r.h = Math.min(target, r.h + pxPerSec * dt);
    r.win.style.height = `${r.h}px`;
    moving = true;
    break; // um pedaço de papel por vez, em ordem
  }
  if (moving && stick) feedEl.scrollTop = feedEl.scrollHeight;
  led.classList.toggle('busy', moving);
  sound.motor(moving && cfg.sound);
}
// Timer em vez de requestAnimationFrame: o rAF para quando o Windows considera a janela
// encoberta, e o papel ficava "preso" com altura 0. O timer continua avançando.
setInterval(() => tick(performance.now()), 16);

feedEl.addEventListener('wheel', (e) => { if (e.deltaY < 0) stick = false; });
feedEl.addEventListener('scroll', () => {
  if (feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 4) stick = true;
});

// ------------------------------------------------------------------ som (sintetizado)

const sound = {
  ctx: null, gain: null, on: false,
  ensure() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.9;
    const am = ctx.createGain(); am.gain.value = 0.55;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 95;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.45;
    lfo.connect(lfoAmt).connect(am.gain);
    const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 190;
    const humLp = ctx.createBiquadFilter(); humLp.type = 'lowpass'; humLp.frequency.value = 700;
    const humG = ctx.createGain(); humG.gain.value = 0.25;
    const gain = ctx.createGain(); gain.gain.value = 0;
    noise.connect(bp).connect(am).connect(gain);
    hum.connect(humLp).connect(humG).connect(gain);
    gain.connect(ctx.destination);
    noise.start(); lfo.start(); hum.start();
    this.ctx = ctx; this.gain = gain;
  },
  motor(on) {
    if (on === this.on) return;
    this.on = on;
    if (on) this.ensure();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.gain.gain.setTargetAtTime(on ? 0.07 : 0, this.ctx.currentTime, 0.015);
  },
  tone(freq, dur, type = 'square', vol = 0.06) {
    if (!cfg.sound) return;
    this.ensure();
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(); o.stop(this.ctx.currentTime + dur);
  },
  beep() { this.tone(2400, 0.18); },
  click() { this.tone(120, 0.12, 'triangle', 0.2); },
};

// ------------------------------------------------------------------ UI

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// cliques passam através das áreas transparentes da janela
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  const hit = !!e.target.closest('.receipt, #printer');
  if (hit === !ignoring) return;
  ignoring = !hit;
  api.setIgnoreMouse(ignoring);
});
document.addEventListener('mouseleave', () => { if (!ignoring) { ignoring = true; api.setIgnoreMouse(true); } });

$('btnMenu').onclick = () => api.openMenu();
$('btnClear').onclick = () => clearAll();
$('btnFeed').onclick = () => { stick = true; append(feedSpacer(60)); };
$('btnCollapse').onclick = () => stage.classList.toggle('collapsed');

function applyConfig(c) {
  const widthChanged = c.printableDots !== cfg.printableDots;
  cfg = c;
  const root = document.documentElement.style;
  root.setProperty('--scale', c.scale);
  root.setProperty('--paper-dots', c.paperDots);
  root.setProperty('--printable-dots', c.printableDots);
  $('meta').textContent = `${c.paper}mm · ${c.cols} col`;
  if (widthChanged) clearAll();
  // recalcula altura visível de papéis já impressos (zoom mudou)
  for (const r of receipts) { r.h = r.paper.offsetHeight; r.win.style.height = `${r.h}px`; }
}

api.onConfig(applyConfig);
api.onCommand((cmd) => { if (cmd === 'clear') clearAll(); });
api.onStatus((s) => {
  const part = (label, port, st) => (st === 'ok' ? `${label} :${port}` : `<span class="bad">${label} :${port} ${st}</span>`);
  $('status').innerHTML = `${part('TCP', s.tcpPort, s.tcp)} · ${part('HTTP', s.httpPort, s.http)} · ${s.jobs} job(s)`;
  led.classList.toggle('error', s.tcp !== 'ok' && s.tcp !== 'iniciando');
});
api.onOps((ops) => {
  const now = Date.now();
  if (now - lastOpAt > 1500) stick = true;
  lastOpAt = now;
  stage.classList.remove('collapsed');
  for (const op of ops) {
    try { handleOp(op); } catch (e) {
      console.error(e);
      try { append(notice(`[erro ao desenhar ${op.type}: ${e.message}]`)); } catch { /* ignora */ }
    }
  }
});
api.ready();
