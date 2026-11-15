'use strict';
/** Monta um cupom de teste em ESC/POS puro (o mesmo que um sistema real enviaria). */
const iconv = require('iconv-lite');

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

function buildTestReceipt(cols = 48) {
  const parts = [];
  const raw = (...bytes) => parts.push(Buffer.from(bytes));
  const t = (s) => parts.push(iconv.encode(s, 'cp850'));
  const ln = (s = '') => { t(s); raw(LF); };
  const lr = (l, r, w = cols) => l.slice(0, w - r.length - 1).padEnd(w - r.length) + r;
  const sep = (ch = '-') => ln(ch.repeat(cols));

  raw(ESC, 0x40); // init
  raw(ESC, 0x74, 2); // codepage CP850

  // logo raster (GS v 0) gerado aqui mesmo
  raw(ESC, 0x61, 1);
  const W = 160, H = 72, xb = W / 8;
  const img = Buffer.alloc(xb * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - W / 2, dy = y - H / 2;
      const r = Math.sqrt(dx * dx * 0.35 + dy * dy);
      const ring = r > 28 && r < 34;
      const inner = r < 22 && ((x + y) % 6 < 3);
      if (ring || inner) img[y * xb + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  raw(GS, 0x76, 0x30, 0, xb & 255, xb >> 8, H & 255, H >> 8);
  parts.push(img);
  raw(LF);

  raw(GS, 0x21, 0x11); raw(ESC, 0x45, 1);
  ln('LOJA DEMONSTRAÇÃO');
  raw(GS, 0x21, 0x00); raw(ESC, 0x45, 0);
  ln('CNPJ 00.000.000/0001-00');
  ln('Rua das Bobinas, 80 - Centro');
  ln('(11) 4002-8922');
  raw(ESC, 0x61, 0);
  sep('=');
  raw(ESC, 0x45, 1); ln(lr('ITEM / DESCRIÇÃO', 'VALOR')); raw(ESC, 0x45, 0);
  sep();
  const items = [['001 Pão francês 6x R$0,75', '4,50'], ['002 Café coado 300ml', '8,90'], ['003 Pão de queijo 2x R$5,25', '10,50'], ['004 Suco natural laranja', '12,00'], ['005 Bolo de cenoura c/ chocolate (fatia)', '10,00']];
  for (const [d, v] of items) ln(lr(d, v));
  sep();
  ln(lr('Subtotal', '45,90'));
  ln(lr('Desconto', '-0,00'));
  raw(ESC, 0x21, 0x18); // negrito + altura dupla
  ln(lr('TOTAL R$', '45,90'));
  raw(ESC, 0x21, 0x00);
  ln(lr('Pagamento: PIX', '45,90'));
  sep();

  raw(ESC, 0x61, 1);
  raw(GS, 0x42, 1); ln('  PEDIDO #1234 - BALCÃO  '); raw(GS, 0x42, 0);
  ln();
  raw(ESC, 0x2d, 1); ln('Texto sublinhado'); raw(ESC, 0x2d, 0);
  raw(ESC, 0x4d, 1); ln('Fonte B: menor, cabe mais texto por linha na bobina.'); raw(ESC, 0x4d, 0);
  ln('Acentos: ÁÉÍÓÚ áéíóú çÇ ãõ âêô à');
  raw(GS, 0x21, 0x10); ln('LARGURA DUPLA'); raw(GS, 0x21, 0x00);
  ln();

  // EAN-13
  raw(GS, 0x68, 70); raw(GS, 0x77, 2); raw(GS, 0x48, 2);
  const ean = Buffer.from('789123456789');
  raw(GS, 0x6b, 67, ean.length); parts.push(ean);
  ln();
  // CODE128
  const c128 = Buffer.from('{BPED-0001234');
  raw(GS, 0x68, 50); raw(GS, 0x77, 2);
  raw(GS, 0x6b, 73, c128.length); parts.push(c128);
  ln();

  // QR Code (GS ( k)
  const qr = Buffer.from('https://www.exemplo.com.br/nfce?p=35261100000000000100650010000012341000012345|2|1|1|ABCDEF', 'utf8');
  raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0); // modelo 2
  raw(GS, 0x28, 0x6b, 3, 0, 49, 67, 5); // tamanho do módulo
  raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 49); // correção M
  const len = qr.length + 3;
  raw(GS, 0x28, 0x6b, len & 255, len >> 8, 49, 80, 48); parts.push(qr);
  raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48); // imprime
  ln();
  ln('Consulte pela chave de acesso');
  raw(ESC, 0x45, 1); ln('Obrigado pela preferência!'); raw(ESC, 0x45, 0);
  ln(new Date().toLocaleString('pt-BR'));

  raw(GS, 0x56, 66, 60); // avança e corta parcial
  raw(ESC, 0x70, 0, 25, 250); // abre gaveta
  return Buffer.concat(parts);
}

module.exports = { buildTestReceipt };
