'use strict';
const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, clipboard, dialog, shell, Notification,
} = require('electron');
const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EscPosParser } = require('./escpos');
const { buildTestReceipt } = require('./sample');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ------------------------------------------------------------------ configuração

const DEFAULTS = {
  paper: 80, // 58 ou 80 (mm)
  scale: 0.6, // pixels de tela por ponto da impressora
  speed: 120, // mm/s (0 = instantâneo)
  sound: true,
  encoding: 'auto', // auto | cp850 | cp860 | win1252 | utf8 | cp437
  host: '127.0.0.1', // só este PC. Use '0.0.0.0' para aceitar impressões de outros aparelhos da rede.
  tcpPort: 9100,
  httpPort: 9101,
  showOnPrint: true,
  saveJobs: false,
  maxReceipts: 30,
};
const MAX_JOB_BYTES = 4 * 1024 * 1024; // protege a memória contra envios gigantes
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { ...DEFAULTS };

function loadConfig() {
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch { cfg = { ...DEFAULTS }; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));
}
function geometry() {
  const is58 = Number(cfg.paper) === 58;
  return { printableDots: is58 ? 384 : 576, paperDots: is58 ? 464 : 640, cols: is58 ? 32 : 48 };
}
const parserOptions = () => ({ printableDots: geometry().printableDots, encoding: cfg.encoding });

// ------------------------------------------------------------------ janela

let win = null;
let tray = null;
const status = { tcp: 'iniciando', http: 'iniciando', jobs: 0 };

function windowBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.round(geometry().paperDots * cfg.scale) + 48;
  const top = 44; // deixa livre a barra de título (botões fechar/maximizar) das outras janelas
  return { x: wa.x + wa.width - width, y: wa.y + top, width, height: wa.height - top };
}

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Impressora Térmica Emulada',
    icon: makeIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
}

function pushConfig() {
  if (!win) return;
  win.setBounds(windowBounds());
  win.webContents.send('config', { ...cfg, ...geometry() });
}
function pushStatus() {
  if (win) win.webContents.send('status', { ...status, tcpPort: cfg.tcpPort, httpPort: cfg.httpPort });
  if (tray) { tray.setToolTip(`Impressora térmica emulada\nTCP ${cfg.tcpPort}: ${status.tcp}\nHTTP ${cfg.httpPort}: ${status.http}`); buildMenus(); }
}

function sendOps(ops) {
  if (!win || !ops.length) return;
  if (cfg.showOnPrint && !win.isVisible()) win.showInactive();
  win.webContents.send('ops', ops);
}

// ------------------------------------------------------------------ jobs

function saveJob(data, source) {
  status.jobs++;
  pushStatus();
  if (!cfg.saveJobs || !data.length) return;
  const dir = path.join(app.getPath('userData'), 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFile(path.join(dir, `${stamp}_${source}.bin`), data, () => {});
}

function processJob(data, source) {
  const parser = new EscPosParser(parserOptions);
  const { ops } = parser.feed(data);
  sendOps([...ops, ...parser.end()]);
  saveJob(data, source);
}

// ------------------------------------------------------------------ servidor TCP (RAW / porta 9100)

let tcpServer = null;
function startTcp() {
  if (tcpServer) tcpServer.close();
  tcpServer = net.createServer((sock) => {
    const parser = new EscPosParser(parserOptions);
    const chunks = [];
    let received = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      sendOps(parser.end());
      saveJob(Buffer.concat(chunks), `tcp-${(sock.remoteAddress || '').replace(/[^0-9a-f.]/gi, '_')}`);
    };
    sock.on('data', (d) => {
      received += d.length;
      if (received > MAX_JOB_BYTES) {
        sendOps([{ type: 'notice', text: `[job descartado: passou de ${MAX_JOB_BYTES / 1048576} MB]`, align: 1 }]);
        finished = true;
        sock.destroy();
        return;
      }
      chunks.push(d);
      const { ops, responses } = parser.feed(d);
      if (responses.length) sock.write(Buffer.from(responses));
      sendOps(ops);
    });
    sock.on('end', () => { finish(); sock.end(); });
    sock.on('close', finish);
    sock.on('error', () => {});
    sock.setTimeout(30000, () => sock.destroy()); // conexão ociosa
  });
  tcpServer.on('error', (e) => {
    status.tcp = e.code === 'EADDRINUSE' ? `porta ${cfg.tcpPort} em uso` : `erro: ${e.message}`;
    pushStatus();
    notify('Impressora emulada', `Não foi possível abrir a porta TCP ${cfg.tcpPort}: ${status.tcp}`);
  });
  tcpServer.listen(cfg.tcpPort, cfg.host, () => { status.tcp = 'ok'; pushStatus(); });
}

// ------------------------------------------------------------------ servidor HTTP

let httpServer = null;
function startHttp() {
  if (httpServer) httpServer.close();
  httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
      return json(200, { ok: true, online: true, paper: `${cfg.paper}mm`, columns: geometry().cols, tcpPort: cfg.tcpPort, jobs: status.jobs });
    }
    if (req.method === 'POST' && url.pathname === '/print') {
      const body = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > MAX_JOB_BYTES) { json(413, { ok: false, error: 'Job muito grande' }); req.destroy(); return; }
        body.push(d);
      });
      req.on('end', () => {
        if (size > MAX_JOB_BYTES) return;
        let data = Buffer.concat(body);
        const ct = String(req.headers['content-type'] || '');
        try {
          if (ct.includes('application/json')) {
            const j = JSON.parse(data.toString('utf8'));
            if (j.base64) data = Buffer.from(j.base64, 'base64');
            else if (j.text != null) {
              data = Buffer.concat([Buffer.from(String(j.text), 'utf8'), j.cut === false ? Buffer.alloc(0) : Buffer.from([0x1d, 0x56, 66, 60])]);
            } else return json(400, { ok: false, error: 'Envie { "text": "..." } ou { "base64": "..." }' });
          }
        } catch (e) { return json(400, { ok: false, error: e.message }); }
        processJob(data, 'http');
        json(200, { ok: true, bytes: data.length });
      });
      return;
    }
    json(404, { ok: false, error: 'Use GET /status ou POST /print' });
  });
  httpServer.on('error', (e) => { status.http = e.code === 'EADDRINUSE' ? `porta ${cfg.httpPort} em uso` : `erro: ${e.message}`; pushStatus(); });
  httpServer.listen(cfg.httpPort, cfg.host, () => { status.http = 'ok'; pushStatus(); });
}

// ------------------------------------------------------------------ menus / bandeja

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function setCfg(patch, restart = false) {
  const paperChanged = patch.paper && patch.paper !== cfg.paper;
  Object.assign(cfg, patch);
  saveConfig();
  pushConfig();
  if (paperChanged && win) win.webContents.send('command', 'clear');
  if (restart) { startTcp(); startHttp(); }
  buildMenus();
}

function menuTemplate() {
  const radio = (label, key, value, restart) => ({ label, type: 'radio', checked: cfg[key] === value, click: () => setCfg({ [key]: value }, restart) });
  const ips = localIps();
  return [
    { label: 'Imprimir página de teste', click: () => processJob(buildTestReceipt(geometry().cols), 'teste') },
    { label: 'Limpar papel', click: () => win && win.webContents.send('command', 'clear') },
    { type: 'separator' },
    { label: 'Largura do papel', submenu: [radio('58 mm (32 colunas)', 'paper', 58), radio('80 mm (48 colunas)', 'paper', 80)] },
    { label: 'Zoom', submenu: [radio('Pequeno', 'scale', 0.45), radio('Normal', 'scale', 0.6), radio('Grande', 'scale', 0.75), radio('Muito grande', 'scale', 0.95)] },
    { label: 'Velocidade', submenu: [radio('Lenta (40 mm/s)', 'speed', 40), radio('Normal (120 mm/s)', 'speed', 120), radio('Rápida (250 mm/s)', 'speed', 250), radio('Instantânea', 'speed', 0)] },
    {
      label: 'Codificação do texto',
      submenu: [
        radio('Automática (respeita ESC t; senão UTF-8 ou CP850)', 'encoding', 'auto'),
        { type: 'separator' },
        radio('Forçar CP850', 'encoding', 'cp850'), radio('Forçar CP860', 'encoding', 'cp860'),
        radio('Forçar CP437', 'encoding', 'cp437'), radio('Forçar Windows-1252', 'encoding', 'win1252'),
        radio('Forçar UTF-8', 'encoding', 'utf8'),
      ],
    },
    { label: 'Som da impressão', type: 'checkbox', checked: cfg.sound, click: (i) => setCfg({ sound: i.checked }) },
    { label: 'Mostrar ao receber impressão', type: 'checkbox', checked: cfg.showOnPrint, click: (i) => setCfg({ showOnPrint: i.checked }) },
    { label: 'Salvar jobs recebidos (.bin)', type: 'checkbox', checked: cfg.saveJobs, click: (i) => setCfg({ saveJobs: i.checked }) },
    { label: 'Aceitar impressões de outros aparelhos da rede', type: 'checkbox', checked: cfg.host === '0.0.0.0', click: (i) => setCfg({ host: i.checked ? '0.0.0.0' : '127.0.0.1' }, true) },
    { label: 'Abrir pasta dos jobs', click: () => { const d = path.join(app.getPath('userData'), 'jobs'); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } },
    { type: 'separator' },
    { label: `TCP RAW  ${cfg.host}:${cfg.tcpPort}  —  ${status.tcp}`, enabled: false },
    { label: `HTTP     http://localhost:${cfg.httpPort}/print  —  ${status.http}`, enabled: false },
    ...ips.map((ip) => ({ label: `IP na rede: ${ip}`, enabled: false })),
    { label: `Jobs recebidos: ${status.jobs}`, enabled: false },
    { label: 'Editar configuração (portas etc.)…', click: () => { saveConfig(); shell.openPath(cfgPath()); } },
    { label: 'Recarregar configuração', click: () => { loadConfig(); pushConfig(); startTcp(); startHttp(); buildMenus(); } },
    { type: 'separator' },
    { label: win && win.isVisible() ? 'Ocultar impressora' : 'Mostrar impressora', click: toggleWindow },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ];
}

function buildMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else win.showInactive();
  buildMenus();
}

/** Ícone desenhado em código (32x32 BGRA): impressora com papel. */
function makeIcon() {
  const S = 32, buf = Buffer.alloc(S * S * 4);
  const px = (x, y, [r, g, b, a = 255]) => { const o = (y * S + x) * 4; buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = a; };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, c); };
  rect(8, 1, 23, 17, [250, 250, 245]);
  for (const y of [4, 7, 10, 13]) rect(10, y, y === 13 ? 17 : 21, y, [90, 90, 90]);
  rect(2, 15, 29, 29, [45, 48, 56]);
  rect(5, 16, 26, 17, [10, 10, 12]);
  rect(24, 24, 26, 26, [60, 220, 120]);
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

// ------------------------------------------------------------------ IPC

ipcMain.on('ignore-mouse', (_e, v) => win && win.setIgnoreMouseEvents(!!v, { forward: true }));
ipcMain.on('ready', () => { pushConfig(); pushStatus(); });
ipcMain.on('open-menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win }));
ipcMain.on('receipt-menu', (_e, { text, png }) => {
  Menu.buildFromTemplate([
    { label: 'Copiar texto', click: () => clipboard.writeText(text) },
    { label: 'Copiar imagem', click: () => clipboard.writeImage(nativeImage.createFromDataURL(png)) },
    {
      label: 'Salvar como PNG…',
      click: async () => {
        const r = await dialog.showSaveDialog(win, { defaultPath: `cupom-${Date.now()}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, Buffer.from(png.split(',')[1], 'base64'));
      },
    },
  ]).popup({ window: win });
});

// ------------------------------------------------------------------ ciclo de vida

app.whenReady().then(() => {
  app.setAppUserModelId('emulador.impressora.termica');
  loadConfig();
  saveConfig();
  createWindow();
  tray = new Tray(makeIcon());
  tray.on('click', toggleWindow);
  buildMenus();
  startTcp();
  startHttp();
  const reposition = () => win && win.setBounds(windowBounds());
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
});

app.on('second-instance', () => win && win.showInactive());
app.on('window-all-closed', () => app.quit());
