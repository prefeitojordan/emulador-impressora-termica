'use strict';
/**
 * Interpretador ESC/POS incremental.
 * Recebe bytes (em pedaços, como chegam pelo socket) e produz "operações de desenho"
 * que o renderer transforma em papel. Comandos incompletos ficam guardados até chegar o resto.
 */
const iconv = require('iconv-lite');
const QRCode = require('qrcode');

const CODEPAGES = {
  0: 'cp437', 1: 'shift_jis', 2: 'cp850', 3: 'cp860', 4: 'cp863', 5: 'cp865',
  16: 'win1252', 17: 'cp866', 18: 'cp852', 19: 'cp858', 45: 'win1250', 46: 'win1251',
};

const FONTS = { A: { w: 12, h: 24 }, B: { w: 9, h: 17 } };

const BARCODES = {
  0: 'UPC', 65: 'UPC', 1: 'UPCE', 66: 'UPCE', 2: 'EAN13', 67: 'EAN13', 3: 'EAN8', 68: 'EAN8',
  4: 'CODE39', 69: 'CODE39', 5: 'ITF', 70: 'ITF', 6: 'codabar', 71: 'codabar',
  72: 'CODE93', 73: 'CODE128',
};

function isValidUtf8(bytes) {
  let i = 0, multi = false;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c < 0x80) { i++; continue; }
    let n;
    if ((c & 0xe0) === 0xc0) n = 1;
    else if ((c & 0xf0) === 0xe0) n = 2;
    else if ((c & 0xf8) === 0xf0) n = 3;
    else return false;
    if (i + n >= bytes.length) return false; // sequência incompleta
    for (let k = 1; k <= n; k++) if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    multi = true;
    i += n + 1;
  }
  return multi;
}

class EscPosParser {
  /** @param {() => {printableDots:number, encoding:string}} getOptions */
  constructor(getOptions) {
    this.getOptions = getOptions;
    this.buf = Buffer.alloc(0);
    this.downloaded = null; // GS *
    this.graphics = null; // GS ( L fn 112
    this.init();
  }

  init() {
    this.mode = { bold: false, underline: 0, invert: false, w: 1, h: 1, font: 'A' };
    this.align = 0;
    this.lineSpacing = 30;
    this.codepage = null; // null = não definido via ESC t
    this.bc = { height: 162, width: 3, hri: 0 };
    this.qr = { module: 3, ec: 'M', data: null };
    this.pdf417 = null;
    this.text = [];
    this.line = [];
    this.lineW = 0;
  }

  get printable() { return this.getOptions().printableDots; }

  /** Alimenta bytes. Retorna operações prontas e bytes de resposta (status) para devolver ao cliente. */
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    this.ops = [];
    this.resp = [];
    const b = this.buf;
    let i = 0;
    while (i < b.length) {
      const c = b[i];
      if (c >= 0x20) { this.text.push(c); i++; continue; }
      this.flushText();
      const n = this.control(b, i);
      if (n < 0) break; // comando incompleto: espera mais dados
      i += n;
    }
    this.buf = Buffer.from(b.subarray(i));
    return { ops: this.ops, responses: this.resp };
  }

  /** Fim do job (conexão fechada): imprime o que sobrou no buffer de linha. */
  end() {
    this.ops = [];
    this.resp = [];
    this.flushText();
    if (this.line.length) this.flushLine();
    this.buf = Buffer.alloc(0);
    return this.ops;
  }

  // ---------------------------------------------------------------- texto

  decode(bytes) {
    const enc = this.getOptions().encoding || 'auto';
    if (enc !== 'auto') return enc === 'utf8' ? bytes.toString('utf8') : iconv.decode(bytes, enc);
    if (this.codepage) return iconv.decode(bytes, this.codepage);
    if (isValidUtf8(bytes)) return bytes.toString('utf8');
    return iconv.decode(bytes, 'cp850');
  }

  flushText() {
    if (!this.text.length) return;
    const bytes = Buffer.from(this.text);
    this.text = [];
    for (const ch of this.decode(bytes)) {
      if (ch === '\x7f') continue;
      this.pushChar(ch);
    }
  }

  pushChar(ch) {
    const f = FONTS[this.mode.font];
    const cw = f.w * this.mode.w;
    if (this.lineW + cw > this.printable && this.line.length) this.flushLine();
    const m = this.mode;
    this.line.push({ k: 'c', ch, b: m.bold, u: m.underline, i: m.invert, w: m.w, h: m.h, f: m.font, cw, hh: f.h * m.h });
    this.lineW += cw;
  }

  pushSpace(dots) {
    if (dots <= 0) return;
    if (this.lineW + dots > this.printable) { this.flushLine(); return; }
    this.line.push({ k: 's', cw: dots, hh: 0 });
    this.lineW += dots;
  }

  tab() {
    const fw = FONTS[this.mode.font].w * this.mode.w;
    const col = Math.floor(this.lineW / fw);
    const next = (Math.floor(col / 8) + 1) * 8;
    this.pushSpace(next * fw - this.lineW);
  }

  flushLine() {
    let maxH = 0;
    for (const it of this.line) maxH = Math.max(maxH, it.hh);
    const height = this.line.length
      ? Math.max(this.lineSpacing, maxH + Math.max(0, this.lineSpacing - 24))
      : this.lineSpacing;
    this.ops.push({ type: 'line', items: this.line, align: this.align, width: this.lineW, height, contentH: maxH });
    this.line = [];
    this.lineW = 0;
  }

  flushIfPending() {
    this.flushText();
    if (this.line.length) this.flushLine();
  }

  feedDots(n) {
    this.flushIfPending();
    if (n > 0) this.ops.push({ type: 'feed', dots: n });
  }

  feedLines(n) {
    if (this.line.length) { this.flushLine(); n -= 1; }
    if (n > 0) this.ops.push({ type: 'feed', dots: n * this.lineSpacing });
  }

  block(op) {
    this.flushIfPending();
    op.align = this.align;
    this.ops.push(op);
  }

  notice(text) { this.block({ type: 'notice', text }); }

  // ---------------------------------------------------------------- imagens

  /** ESC * — imagem em colunas (8 ou 24 pontos), entra na linha atual */
  bitImage(m, n, data) {
    const rows = m >= 32 ? 24 : 8;
    const bpc = rows / 8;
    const sx = (m === 0 || m === 32) ? 2 : 1;
    const sy = m < 32 ? 3 : 1;
    const w = n * sx, h = rows * sy;
    const px = new Uint8Array(w * h);
    for (let col = 0; col < n; col++) {
      for (let r = 0; r < rows; r++) {
        const byte = data[col * bpc + (r >> 3)];
        if (byte & (0x80 >> (r & 7))) {
          for (let dx = 0; dx < sx; dx++) for (let dy = 0; dy < sy; dy++) px[(r * sy + dy) * w + col * sx + dx] = 1;
        }
      }
    }
    if (this.lineW + w > this.printable && this.line.length) this.flushLine();
    this.line.push({ k: 'img', w, h, px, cw: w, hh: h });
    this.lineW += w;
  }

  /** Bitmap em linhas (GS v 0 / GS ( L) */
  rasterImage(bytesPerRow, height, data, sx, sy, widthDots) {
    const w = widthDots || bytesPerRow * 8;
    const px = new Uint8Array(w * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        const byte = data[y * bytesPerRow + (x >> 3)];
        if (byte & (0x80 >> (x & 7))) px[y * w + x] = 1;
      }
    }
    this.block({ type: 'image', w, h: height, px, sx, sy });
  }

  qrPrint(data, ec, module) {
    if (!data || !data.length) return;
    const text = isValidUtf8(data) ? data.toString('utf8') : data.toString('latin1');
    try {
      const q = QRCode.create([{ data: new Uint8Array(data), mode: 'byte' }], { errorCorrectionLevel: ec || 'M' });
      this.block({
        type: 'qr', size: q.modules.size, module: Math.max(1, Math.min(16, module || 3)),
        bits: new Uint8Array(q.modules.data), text,
      });
    } catch (e) {
      this.notice(`[QR CODE inválido: ${e.message}]`);
    }
  }

  barcode(m, data) {
    const format = BARCODES[m];
    let text = data.toString('latin1');
    if (!format) { this.notice(`[código de barras tipo ${m} não suportado]`); return; }
    if (format === 'CODE128') {
      let out = '', set = 'B';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{' && i + 1 < text.length) {
          const nx = text[i + 1];
          if ('ABC'.includes(nx)) { set = nx; i++; continue; }
          if (nx === '{') { out += '{'; i++; continue; }
          i++; continue; // FNC1..4 e afins: ignorados
        }
        out += set === 'C' ? String(ch.charCodeAt(0)).padStart(2, '0') : ch;
      }
      text = out;
    }
    this.block({ type: 'barcode', format, data: text, height: this.bc.height, width: this.bc.width, hri: this.bc.hri });
  }

  // ---------------------------------------------------------------- comandos

  control(b, i) {
    switch (b[i]) {
      case 0x0a: this.flushLine(); return 1; // LF
      case 0x0d: return 1; // CR
      case 0x09: this.tab(); return 1; // HT
      case 0x0c: // FF (driver "Generic / Text Only" manda no fim da página)
        this.flushIfPending();
        this.ops.push({ type: 'cut', partial: false });
        return 1;
      case 0x10: return this.dle(b, i);
      case 0x1b: return this.esc(b, i);
      case 0x1c: return this.fs(b, i);
      case 0x1d: return this.gs(b, i);
      default: return 1;
    }
  }

  dle(b, i) {
    if (i + 2 > b.length) return -1;
    const cmd = b[i + 1];
    if (cmd === 0x04) { // DLE EOT n — status em tempo real: "online, sem erro, com papel"
      if (i + 3 > b.length) return -1;
      this.resp.push(0x12);
      return 3;
    }
    if (cmd === 0x05) return i + 3 > b.length ? -1 : 3;
    if (cmd === 0x14) {
      if (i + 3 > b.length) return -1;
      const fn = b[i + 2];
      const len = fn === 8 ? 10 : fn === 7 ? 4 : (fn === 1 || fn === 2) ? 5 : 3;
      if (i + len > b.length) return -1;
      if (fn === 1) this.ops.push({ type: 'drawer', pin: b[i + 3] });
      return len;
    }
    return 2;
  }

  esc(b, i) {
    const need = (n) => i + n <= b.length;
    if (!need(2)) return -1;
    const p = (k) => b[i + k];
    const m = this.mode;
    const cmd = p(1);
    const oneParam = [0x20, 0x52, 0x7b, 0x56, 0x55, 0x72, 0x3d, 0x25, 0x54, 0x3f, 0x4b, 0x65, 0x6e, 0x75, 0x7a, 0x47];

    switch (cmd) {
      case 0x40: this.init(); return 2; // ESC @
      case 0x21: { // ESC ! n
        if (!need(3)) return -1;
        const n = p(2);
        m.font = n & 1 ? 'B' : 'A';
        m.bold = !!(n & 8);
        m.h = n & 16 ? 2 : 1;
        m.w = n & 32 ? 2 : 1;
        m.underline = n & 128 ? 1 : 0;
        return 3;
      }
      case 0x45: case 0x47: if (!need(3)) return -1; m.bold = !!(p(2) & 1); return 3;
      case 0x2d: { if (!need(3)) return -1; const n = p(2); m.underline = (n === 1 || n === 49) ? 1 : (n === 2 || n === 50) ? 2 : 0; return 3; }
      case 0x61: { if (!need(3)) return -1; const n = p(2); this.align = Math.min(2, n >= 48 ? n - 48 : n); return 3; }
      case 0x64: if (!need(3)) return -1; this.flushText(); this.feedLines(p(2)); return 3;
      case 0x4a: if (!need(3)) return -1; this.feedDots(p(2)); return 3;
      case 0x4d: if (!need(3)) return -1; m.font = (p(2) & 3) ? 'B' : 'A'; return 3;
      case 0x74: if (!need(3)) return -1; this.codepage = CODEPAGES[p(2)] || 'cp437'; return 3;
      case 0x32: this.lineSpacing = 30; return 2;
      case 0x33: if (!need(3)) return -1; this.lineSpacing = p(2); return 3;
      case 0x24: { // ESC $ posição absoluta
        if (!need(4)) return -1;
        const pos = p(2) + p(3) * 256;
        if (pos > this.lineW) this.pushSpace(Math.min(pos, this.printable) - this.lineW);
        return 4;
      }
      case 0x5c: { // ESC \ posição relativa
        if (!need(4)) return -1;
        const rel = (p(2) + p(3) * 256) << 16 >> 16;
        if (rel > 0) this.pushSpace(rel);
        return 4;
      }
      case 0x44: { // ESC D tabulações (termina em NUL)
        for (let k = i + 2; k < b.length; k++) if (b[k] === 0) return k - i + 1;
        return -1;
      }
      case 0x70: if (!need(5)) return -1; this.flushIfPending(); this.ops.push({ type: 'drawer', pin: p(2) & 1 }); return 5;
      case 0x69: case 0x6d: this.flushIfPending(); this.ops.push({ type: 'cut', partial: true }); return 2;
      case 0x63: return need(4) ? 4 : -1;
      case 0x2a: { // ESC * imagem em colunas
        if (!need(5)) return -1;
        const mm = p(2), n = p(3) + p(4) * 256;
        const len = n * (mm >= 32 ? 3 : 1);
        if (!need(5 + len)) return -1;
        this.flushText();
        this.bitImage(mm, n, b.subarray(i + 5, i + 5 + len));
        return 5 + len;
      }
      case 0x42: if (!need(4)) return -1; this.ops.push({ type: 'beep' }); return 4; // ESC B n t (bip)
      case 0x28: { // ESC ( fn pL pH ...
        if (!need(5)) return -1;
        const len = p(3) + p(4) * 256;
        if (!need(5 + len)) return -1;
        if (p(2) === 0x41) this.ops.push({ type: 'beep' });
        return 5 + len;
      }
      case 0x26: { // ESC & y c1 c2 [x d1..d(y*x)]...
        if (!need(5)) return -1;
        const y = p(2), c1 = p(3), c2 = p(4);
        let k = i + 5;
        for (let c = c1; c <= c2; c++) { if (k >= b.length) return -1; k += 1 + y * b[k]; }
        return k > b.length ? -1 : k - i;
      }
      case 0x57: return need(10) ? 10 : -1;
      case 0x5a: { // ESC Z m n k dL dH d — QR code (variante usada por alguns modelos)
        if (!need(7)) return -1;
        const len = p(5) + p(6) * 256;
        if (!need(7 + len)) return -1;
        const ec = { 0: 'L', 1: 'M', 2: 'Q', 3: 'H', 76: 'L', 77: 'M', 81: 'Q', 72: 'H' }[p(3)] || 'M';
        this.qrPrint(Buffer.from(b.subarray(i + 7, i + 7 + len)), ec, p(4) || 3);
        return 7 + len;
      }
      default:
        if (oneParam.includes(cmd)) return need(3) ? 3 : -1;
        return 2;
    }
  }

  fs(b, i) {
    const need = (n) => i + n <= b.length;
    if (!need(2)) return -1;
    const p = (k) => b[i + k];
    switch (p(1)) {
      case 0x70: if (!need(4)) return -1; this.notice(`[LOGO NV #${p(2)} — gravado na memória da impressora]`); return 4;
      case 0x21: case 0x2d: case 0x43: case 0x57: return need(3) ? 3 : -1;
      case 0x53: return need(4) ? 4 : -1;
      case 0x32: return need(76) ? 76 : -1;
      case 0x28: { if (!need(5)) return -1; const len = p(3) + p(4) * 256; return need(5 + len) ? 5 + len : -1; }
      case 0x71: { // FS q — grava logos NV
        if (!need(3)) return -1;
        let k = i + 3;
        for (let j = 0; j < p(2); j++) {
          if (k + 4 > b.length) return -1;
          const x = b[k] + b[k + 1] * 256, y = b[k + 2] + b[k + 3] * 256;
          k += 4 + x * y * 8;
        }
        return k > b.length ? -1 : k - i;
      }
      default: return 2;
    }
  }

  gs(b, i) {
    const need = (n) => i + n <= b.length;
    if (!need(2)) return -1;
    const p = (k) => b[i + k];
    const m = this.mode;
    switch (p(1)) {
      case 0x21: { if (!need(3)) return -1; const n = p(2); m.w = ((n >> 4) & 7) + 1; m.h = (n & 7) + 1; return 3; }
      case 0x42: if (!need(3)) return -1; m.invert = !!(p(2) & 1); return 3;
      case 0x56: { // GS V corte
        if (!need(3)) return -1;
        const mm = p(2);
        if ([65, 66, 97, 98, 103, 104].includes(mm)) {
          if (!need(4)) return -1;
          this.feedDots(p(3));
          this.ops.push({ type: 'cut', partial: mm % 2 === 0 });
          return 4;
        }
        this.flushIfPending();
        this.ops.push({ type: 'cut', partial: mm === 1 || mm === 49 });
        return 3;
      }
      case 0x6b: { // GS k código de barras
        if (!need(3)) return -1;
        const mm = p(2);
        if (mm <= 6) {
          for (let k = i + 3; k < b.length; k++) {
            if (b[k] === 0) { this.barcode(mm, Buffer.from(b.subarray(i + 3, k))); return k - i + 1; }
          }
          return -1;
        }
        if (!need(4)) return -1;
        const n = p(3);
        if (!need(4 + n)) return -1;
        this.barcode(mm, Buffer.from(b.subarray(i + 4, i + 4 + n)));
        return 4 + n;
      }
      case 0x68: if (!need(3)) return -1; this.bc.height = p(2) || 162; return 3;
      case 0x77: if (!need(3)) return -1; this.bc.width = Math.max(1, Math.min(6, p(2))); return 3;
      case 0x48: { if (!need(3)) return -1; const n = p(2); this.bc.hri = (n >= 48 ? n - 48 : n) & 3; return 3; }
      case 0x28: { // GS ( fn pL pH ...
        if (!need(5)) return -1;
        const len = p(3) + p(4) * 256;
        if (!need(5 + len)) return -1;
        const d = Buffer.from(b.subarray(i + 5, i + 5 + len));
        if (p(2) === 0x6b) this.gsk(d);
        else if (p(2) === 0x4c) this.gsL(d);
        return 5 + len;
      }
      case 0x38: { // GS 8 L p1 p2 p3 p4 ...
        if (!need(7)) return -1;
        const len = p(3) + p(4) * 256 + p(5) * 65536 + p(6) * 16777216;
        if (!need(7 + len)) return -1;
        if (p(2) === 0x4c) this.gsL(Buffer.from(b.subarray(i + 7, i + 7 + len)));
        return 7 + len;
      }
      case 0x76: { // GS v 0 m xL xH yL yH d — bitmap raster
        if (!need(8)) return -1;
        const mm = p(3), xb = p(4) + p(5) * 256, y = p(6) + p(7) * 256;
        const len = xb * y;
        if (!need(8 + len)) return -1;
        this.rasterImage(xb, y, Buffer.from(b.subarray(i + 8, i + 8 + len)), (mm & 1) ? 2 : 1, (mm & 2) ? 2 : 1);
        return 8 + len;
      }
      case 0x2a: { // GS * x y d — imagem "download"
        if (!need(4)) return -1;
        const x = p(2), y = p(3), len = x * y * 8;
        if (!need(4 + len)) return -1;
        const w = x * 8, h = y * 8;
        const d = b.subarray(i + 4, i + 4 + len);
        const px = new Uint8Array(w * h);
        for (let col = 0; col < w; col++) {
          for (let r = 0; r < h; r++) if (d[col * y + (r >> 3)] & (0x80 >> (r & 7))) px[r * w + col] = 1;
        }
        this.downloaded = { w, h, px };
        return 4 + len;
      }
      case 0x2f: { // GS / m — imprime imagem "download"
        if (!need(3)) return -1;
        if (this.downloaded) {
          const mm = p(2);
          this.block({ type: 'image', ...this.downloaded, sx: (mm & 1) ? 2 : 1, sy: (mm & 2) ? 2 : 1 });
        }
        return 3;
      }
      case 0x72: if (!need(3)) return -1; this.resp.push(0x00); return 3; // GS r status
      case 0x49: { // GS I — ID da impressora
        if (!need(3)) return -1;
        const n = p(2);
        if (n === 1 || n === 49) this.resp.push(0x20);
        else if (n === 2 || n === 50) this.resp.push(0x02);
        else if (n === 3 || n === 51) this.resp.push(0x00);
        else if (n >= 65) this.resp.push(0x5f, ...Buffer.from('EMULADOR'), 0x00);
        return 3;
      }
      case 0x4c: case 0x57: case 0x50: case 0x24: case 0x5c: return need(4) ? 4 : -1;
      case 0x61: case 0x62: case 0x54: case 0x45: case 0x5a: case 0x66: return need(3) ? 3 : -1;
      default: return 2;
    }
  }

  /** GS ( k — QR code / PDF417 */
  gsk(d) {
    const cn = d[0], fn = d[1];
    if (cn === 49) {
      if (fn === 67) this.qr.module = d[2] || 3;
      else if (fn === 69) this.qr.ec = { 48: 'L', 49: 'M', 50: 'Q', 51: 'H' }[d[2]] || 'M';
      else if (fn === 80) this.qr.data = Buffer.from(d.subarray(3));
      else if (fn === 81) this.qrPrint(this.qr.data, this.qr.ec, this.qr.module);
    } else if (cn === 48) {
      if (fn === 80) this.pdf417 = d.subarray(3).toString('latin1');
      else if (fn === 81 && this.pdf417) this.notice(`[PDF417: ${this.pdf417}]`);
    }
  }

  /** GS ( L / GS 8 L — gráficos */
  gsL(d) {
    const fn = d[1];
    if (fn === 112) { // grava raster no buffer de gráficos
      const bx = d[3] === 2 ? 2 : 1, by = d[4] === 2 ? 2 : 1;
      const x = d[6] + d[7] * 256, y = d[8] + d[9] * 256;
      this.graphics = { x, y, data: d.subarray(10), bx, by };
    } else if (fn === 50 || fn === 2) {
      const g = this.graphics;
      if (g) this.rasterImage(Math.ceil(g.x / 8), g.y, g.data, g.bx, g.by, g.x);
    } else if (fn === 69) {
      this.notice('[logo NV (GS ( L) — gravado na memória da impressora]');
    }
  }
}

module.exports = { EscPosParser, isValidUtf8 };
