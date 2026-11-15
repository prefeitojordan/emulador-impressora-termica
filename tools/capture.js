'use strict';
/**
 * Gera as imagens do README usando o renderer real do emulador.
 *   npx electron tools/capture.js
 * Saída: docs/*.png e docs/imprimindo.gif
 * Não abre portas nem mexe na configuração do usuário.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { EscPosParser } = require('../src/escpos');
const { buildTestReceipt } = require('../src/sample');
const { buildNfce, buildComanda } = require('../exemplos/amostras');

const OUT = path.join(__dirname, '..', 'docs');
app.setPath('userData', path.join(app.getPath('temp'), 'emu-capture'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geometry(paper) {
  return paper === 58 ? { printableDots: 384, paperDots: 464, cols: 32 } : { printableDots: 576, paperDots: 640, cols: 48 };
}

async function openPrinter({ paper, scale, speed, height }) {
  const g = geometry(paper);
  const width = Math.round(g.paperDots * scale) + 48;
  const win = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true, backgroundColor: '#00000000', enableLargerThanScreen: true,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '..', 'src', 'preload.js') },
  });
  win.setContentSize(width, height); // permite janela mais alta que a tela
  win.webContents.setFrameRate(30);
  const ready = new Promise((r) => ipcMain.once('ready', r));
  const page = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  for (let tentativa = 0; ; tentativa++) {
    try { await win.loadFile(page); break; } catch (e) { if (tentativa >= 3) throw e; await sleep(500); }
  }
  await ready;
  win.webContents.send('config', { ...g, paper, scale, speed, sound: false, maxReceipts: 30 });
  win.webContents.send('status', { tcp: 'ok', http: 'ok', jobs: 1, tcpPort: 9100, httpPort: 9101 });
  await sleep(300);
  return win;
}

function parse(data, paper) {
  const p = new EscPosParser(() => ({ printableDots: geometry(paper).printableDots, encoding: 'auto' }));
  const { ops } = p.feed(data);
  return [...ops, ...p.end()];
}

/** Recorta as linhas totalmente transparentes do topo, deixando uma margem. */
function trimTop(img, margin = 16) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  let top = 0;
  outer: for (; top < height; top++) {
    for (let x = 0; x < width; x++) if (bmp[(top * width + x) * 4 + 3] > 8) break outer;
  }
  const y = Math.max(0, top - margin);
  return img.crop({ x: 0, y, width, height: height - y });
}

async function still(name, data, opts) {
  const win = await openPrinter({ speed: 0, ...opts });
  win.webContents.send('ops', parse(data, opts.paper));
  await sleep(1500);
  const img = trimTop(await win.webContents.capturePage());
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('ok', name, img.getSize());
  win.destroy();
}

/** GIF do papel subindo: captura quadros enquanto imprime, sobre um fundo escuro. */
async function gif(name, data, opts) {
  const win = await openPrinter(opts);
  const frames = [];
  win.webContents.send('ops', parse(data, opts.paper));
  const t0 = Date.now();
  let still = 0, last = null;
  while (Date.now() - t0 < 20000) {
    const img = await win.webContents.capturePage();
    const bmp = img.toBitmap();
    if (last && Buffer.compare(bmp, last) === 0) { if (++still > 12) break; } else still = 0;
    last = bmp;
    frames.push({ bmp, size: img.getSize() });
    await sleep(70);
  }
  win.destroy();

  const { width, height } = frames[0].size;
  const enc = GIFEncoder();
  const bg = (y) => { const t = y / height; return [24 + 14 * t, 27 + 14 * t, 36 + 20 * t]; };
  for (let i = 0; i < frames.length; i++) {
    const src = frames[i].bmp; // BGRA pré-multiplicado
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const [br, bgc, bb] = bg(y);
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4, a = src[o + 3] / 255;
        rgba[o] = src[o + 2] + br * (1 - a);
        rgba[o + 1] = src[o + 1] + bgc * (1 - a);
        rgba[o + 2] = src[o] + bb * (1 - a);
        rgba[o + 3] = 255;
      }
    }
    const palette = quantize(rgba, 128);
    enc.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay: i === frames.length - 1 ? 2500 : 80 });
  }
  if (process.env.FRAME_DEBUG) {
    const mid = frames[Math.floor(frames.length * 0.6)];
    fs.writeFileSync(process.env.FRAME_DEBUG, require('electron').nativeImage.createFromBitmap(mid.bmp, mid.size).toPNG());
  }
  enc.finish();
  fs.writeFileSync(path.join(OUT, name), enc.bytes());
  console.log('ok', name, frames.length, 'quadros', width, 'x', height);
}

/** Imagem de capa: os três cupons lado a lado sobre um gradiente. */
async function hero() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1600px;height:900px;overflow:hidden}
    body{background:radial-gradient(1200px 700px at 20% 10%,#33415c 0%,#1b2131 55%,#121620 100%);
      font-family:"Segoe UI",system-ui,sans-serif;color:#fff;position:relative}
    .copy{position:absolute;left:90px;top:250px;width:560px}
    h1{font-size:64px;line-height:1.05;margin:0 0 22px;font-weight:800;letter-spacing:-1px}
    h1 span{color:#3ddc84}
    p{font-size:24px;line-height:1.45;color:#c4cad6;margin:0 0 28px}
    .tags{display:flex;flex-wrap:wrap;gap:10px}
    .tags b{font-weight:600;font-size:16px;padding:7px 14px;border-radius:20px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e6e9ef}
    img{position:absolute;bottom:0}
    .a{right:440px;height:640px}.b{right:60px;height:860px}
  </style></head><body>
    <div class="copy"><h1>Sua impressora térmica, <span>na tela.</span></h1>
    <p>Emulador ESC/POS para testar PDV, NFC-e, delivery e comandas sem gastar bobina.</p>
    <div class="tags"><b>TCP 9100</b><b>HTTP</b><b>QR Code</b><b>Código de barras</b><b>58 / 80 mm</b></div></div>
    <img class="a" src="comanda-58mm.png"><img class="b" src="nfce-80mm.png">
  </body></html>`;
  const file = path.join(OUT, '_hero.html');
  fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await sleep(800);
  fs.writeFileSync(path.join(OUT, 'capa.png'), (await win.webContents.capturePage()).toPNG());
  fs.unlinkSync(file);
  win.destroy();
  console.log('ok capa.png');
}

app.on('window-all-closed', () => {}); // não encerra entre uma captura e outra

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    await still('teste-80mm.png', buildTestReceipt(48), { paper: 80, scale: 0.8, height: 1700 });
    await still('nfce-80mm.png', buildNfce(48), { paper: 80, scale: 0.8, height: 1500 });
    await still('comanda-58mm.png', buildComanda(32), { paper: 58, scale: 0.8, height: 1100 });
    await gif('imprimindo.gif', buildComanda(32), { paper: 58, scale: 0.6, speed: 45, height: 560 });
    await hero();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
