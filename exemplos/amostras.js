'use strict';
/**
 * Cupons de exemplo em ESC/POS (dados 100% fictícios).
 * Usados pelos prints do README e úteis como referência de como montar os bytes.
 */
const iconv = require('iconv-lite');

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

class Escpos {
  constructor(cols) { this.cols = cols; this.parts = []; this.raw(ESC, 0x40).raw(ESC, 0x74, 2); }
  raw(...b) { this.parts.push(Buffer.from(b)); return this; }
  text(s) { this.parts.push(iconv.encode(s, 'cp850')); return this; }
  line(s = '') { return this.text(s).raw(LF); }
  align(n) { return this.raw(ESC, 0x61, n); }
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  size(w, h) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
  invert(on) { return this.raw(GS, 0x42, on ? 1 : 0); }
  fontB(on) { return this.raw(ESC, 0x4d, on ? 1 : 0); }
  sep(ch = '-') { return this.line(ch.repeat(this.cols)); }
  lr(l, r, cols = this.cols) { return this.line(l.slice(0, cols - r.length - 1).padEnd(cols - r.length) + r); }
  qr(data, module = 5) {
    const d = Buffer.from(data, 'utf8'), len = d.length + 3;
    this.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0).raw(GS, 0x28, 0x6b, 3, 0, 49, 67, module).raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 49);
    this.raw(GS, 0x28, 0x6b, len & 255, len >> 8, 49, 80, 48); this.parts.push(d);
    return this.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48);
  }
  code128(data, h = 60) {
    const d = Buffer.from('{B' + data);
    this.raw(GS, 0x68, h, GS, 0x77, 2, GS, 0x48, 2, GS, 0x6b, 73, d.length); this.parts.push(d);
    return this;
  }
  cut() { return this.raw(GS, 0x56, 66, 40); }
  build() { return Buffer.concat(this.parts); }
}

function chaveNfce() {
  // chave fictícia: UF 35, 11/2026, CNPJ zerado, modelo 65, série 1, nº 123
  const base = '35' + '2611' + '00000000000000' + '65' + '001' + '000000123' + '1' + '12345678';
  let s = 0, w = 2;
  for (let i = base.length - 1; i >= 0; i--) { s += +base[i] * w; w = w === 9 ? 2 : w + 1; }
  const r = s % 11;
  return base + (r < 2 ? 0 : 11 - r);
}

/** DANFE NFC-e fictício (ambiente de homologação). */
function buildNfce(cols = 48) {
  const p = new Escpos(cols);
  const chave = chaveNfce();
  p.align(1).bold(true).line('MERCADINHO BOBINA FELIZ LTDA').bold(false);
  p.line('CNPJ 00.000.000/0000-00  IE 000.000.000.000');
  p.line('Av. dos Cupons, 1000 - Centro - São Paulo/SP');
  p.fontB(true).line('Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica').fontB(false);
  p.align(0).sep();
  p.bold(true).lr('Código Descrição', 'Vl Total').bold(false);
  const itens = [
    ['001', 'Café torrado e moído 500g', '1 UN x 18,49', '18,49'],
    ['002', 'Açúcar refinado 1kg', '2 UN x 4,98', '9,96'],
    ['003', 'Pão de forma integral', '1 UN x 9,90', '9,90'],
    ['004', 'Leite UHT integral 1L', '6 UN x 5,29', '31,74'],
  ];
  for (const [c, d, q, v] of itens) { p.line(`${c} ${d}`); p.lr(`    ${q}`, v); }
  p.sep();
  p.lr('Qtde. total de itens', '10');
  p.lr('Valor total R$', '70,09');
  p.lr('Desconto R$', '0,09');
  p.bold(true).lr('Valor a Pagar R$', '70,00').bold(false);
  p.lr('FORMA PAGAMENTO', 'VALOR PAGO R$');
  p.lr('PIX', '70,00');
  p.sep();
  p.align(1).bold(true).line('Consulte pela Chave de Acesso em').bold(false);
  p.line('www.nfce.fazenda.sp.gov.br/consulta');
  p.fontB(true).line(chave.replace(/(\d{4})/g, '$1 ').trim()).fontB(false);
  p.sep();
  p.line('CONSUMIDOR NÃO IDENTIFICADO');
  p.bold(true).line('NFC-e nº 000000123 Série 001 15/11/2026 14:32:10').bold(false);
  p.line('Protocolo: 135260000000000  15/11/2026 14:32:11');
  p.bold(true).line('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO').line('SEM VALOR FISCAL').bold(false);
  p.raw(LF).qr(`https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${chave}|2|2|1|0000000000000000000000000000000000000000`, 5).raw(LF);
  p.line('Tributos incidentes (Lei 12.741/12): R$ 9,87');
  p.line('Obrigado pela preferência!');
  return p.cut().build();
}

/** Comanda de cozinha (ótima em 58 mm). */
function buildComanda(cols = 32) {
  const p = new Escpos(cols);
  p.align(1).invert(true).bold(true).size(2, 2).line(' COZINHA ').size(1, 1).invert(false);
  p.line().size(2, 2).line('MESA 07').size(1, 1).bold(false);
  p.line('Garçom: Ana   Pedido #0482');
  p.line('15/11/2026 19:47');
  p.align(0).sep('=');
  const itens = [['2x', 'X-SALADA'], ['1x', 'BATATA GRANDE'], ['1x', 'PIZZA CALABRESA'], ['3x', 'SUCO LARANJA']];
  for (const [q, d] of itens) p.bold(true).size(1, 2).line(`${q} ${d}`).size(1, 1).bold(false);
  p.line('   > sem cebola').line('   > ponto da carne: mal passado');
  p.sep('=');
  p.align(1).bold(true).line('*** URGENTE ***').bold(false);
  p.raw(LF).code128('PED0482', 50).raw(LF);
  return p.cut().build();
}

module.exports = { buildNfce, buildComanda, Escpos };
