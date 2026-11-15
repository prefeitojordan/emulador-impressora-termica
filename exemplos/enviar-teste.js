// Envia um cupom ESC/POS de teste para a impressora emulada via TCP (igual a uma impressora de rede).
// Uso: node exemplos/enviar-teste.js [host] [porta] [colunas]
const net = require('net');
const { buildTestReceipt } = require('../src/sample');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 9100);
const cols = Number(process.argv[4] || 48);

const sock = net.connect(port, host, () => {
  sock.write(Buffer.from([0x10, 0x04, 0x01])); // DLE EOT 1 — pergunta o status
  sock.write(buildTestReceipt(cols));
  sock.end();
});
sock.on('data', (d) => console.log('Resposta de status:', [...d].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ')));
sock.on('close', () => console.log(`Enviado para ${host}:${port}`));
sock.on('error', (e) => console.error('Erro:', e.message));
