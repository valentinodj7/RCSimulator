// Arma la versión para celular (app que corre sola, sin PC).
// Uso:  node armar-movil.js     ->  crea la carpeta "movil" lista para subir a internet.
// Necesita en esta misma carpeta: server.js, index.html, systems.html, icon192.png, icon512.png
// y tus audios: musica*.mp3 (también dentro de la carpeta "musica"), inicio.mp3, explosion.mp3 (opcional).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'movil');
const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a'];

function read(f) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.error('Falta ' + f + ' en esta carpeta.'); process.exit(1); }
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
function between(text, startMarker, endMarker, from) {
  const a = text.indexOf(startMarker, from || 0);
  if (a < 0) throw new Error('No encontré: ' + startMarker);
  const b = endMarker ? text.indexOf(endMarker, a) : text.length;
  if (b < 0) throw new Error('No encontré: ' + endMarker);
  return text.slice(a, b);
}

// ---------- 1. lógica del reactor (sale de server.js, así siempre queda igual) ----------
const server = read('server.js');
const partA = between(server, 'const AMBIENT', 'let last = Date.now();');
const snapAt = server.indexOf('function snapshot()');
const partB = between(server, 'function snapshot()', 'setInterval(() => {', snapAt);
const partC = between(server, 'function clamp(', 'const AUDIO_EXT');
const simJs =
  '// Generado por armar-movil.js a partir de server.js. No editar.\n' +
  'window.PLRC_SIM = (function () {\n' +
  partA + '\n' + partB + '\n' + partC + '\n' +
  'return { s: s, step: step, snapshot: snapshot, cmd: handleCmd,\n' +
  '  getNotice: function () { return noticeId; }, setNotice: function (v) { noticeId = v; } };\n' +
  '})();\n';

// ---------- 2. capa que reemplaza al servidor dentro del celular ----------
const shimJs = `// Reemplaza al servidor: el reactor corre dentro de esta página.
(function () {
  var SIM = window.PLRC_SIM;
  var KEY = 'plrc_sim';
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && Date.now() - o.t < 30 * 60 * 1000) {
        Object.assign(SIM.s, o.s);
        SIM.s.notices = [];
        SIM.setNotice(o.n || 0);
      }
    }
  } catch (e) { /* sin almacenamiento */ }

  var last = performance.now();
  setInterval(function () {
    var now = performance.now();
    var dt = Math.min(0.2, (now - last) / 1000);
    last = now;
    try { SIM.step(dt); } catch (e) { console.error(e); }
  }, 50);

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), n: SIM.getNotice(), s: SIM.s })); } catch (e) { /* ignorar */ }
  }
  setInterval(save, 1000);
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });

  // EventSource falso: manda el estado cada 100 ms
  function FakeES(url) {
    var self = this;
    self.url = url; self.readyState = 0;
    self.onopen = null; self.onerror = null; self.onmessage = null;
    self._l = {};
    setTimeout(function () {
      self.readyState = 1;
      self._emit('open', {});
      self._t = setInterval(function () { self._emit('message', { data: SIM.snapshot() }); }, 100);
    }, 50);
  }
  FakeES.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  FakeES.prototype.removeEventListener = function (t, f) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== f; }); };
  FakeES.prototype._emit = function (t, e) {
    var h = this['on' + t];
    if (h) h.call(this, e);
    (this._l[t] || []).forEach(function (f) { f.call(this, e); }, this);
  };
  FakeES.prototype.close = function () { clearInterval(this._t); this.readyState = 2; };
  window.EventSource = FakeES;

  // fetch: las rutas del servidor se contestan acá; lo demás va a internet/caché normal
  var realFetch = window.fetch.bind(window);
  var base = document.baseURI;
  var audioInfo = null;
  function info() {
    if (!audioInfo) {
      audioInfo = realFetch(new URL('audio.json', base)).then(function (r) { return r.json(); })
        .catch(function () { return { tracks: [], inicio: null, explosion: null, meltdown: null }; });
    }
    return audioInfo;
  }
  function json(o) { return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function audioFile(name) {
    if (!name) return Promise.resolve(new Response(null, { status: 404 }));
    return realFetch(new URL('audio/' + encodeURIComponent(name), base));
  }
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    var url;
    try { url = new URL(u, location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin) return realFetch(input, init);
    switch (url.pathname) {
      case '/state': return Promise.resolve(json(JSON.parse(SIM.snapshot())));
      case '/cmd':
        try { SIM.cmd(JSON.parse((init && init.body) || '{}')); } catch (e) { console.error(e); }
        return Promise.resolve(new Response(null, { status: 204 }));
      case '/voz-info': return Promise.resolve(json({ enabled: false }));
      case '/musica-info': return info().then(function (a) { return json({ file: a.tracks[0] || null, tracks: a.tracks }); });
      case '/musica': return info().then(function (a) { return audioFile(url.searchParams.get('f') || a.tracks[0]); });
      case '/inicio-info': return info().then(function (a) { return json({ file: a.inicio }); });
      case '/inicio': return info().then(function (a) { return audioFile(a.inicio); });
      case '/meltdown-info': return info().then(function (a) { return json({ file: a.meltdown }); });
      case '/meltdown': return info().then(function (a) { return audioFile(a.meltdown); });
      case '/explosion-info': return info().then(function (a) { return json({ file: a.explosion }); });
      case '/explosion': return info().then(function (a) { return audioFile(a.explosion); });
      default: return realFetch(input, init);
    }
  };

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* sin caché offline */ });
  }
})();
`;

// ---------- 3. páginas ----------
const HEAD =
  '<link rel="manifest" href="manifest.webmanifest">\n' +
  '<meta name="theme-color" content="#05070d">\n' +
  '<meta name="mobile-web-app-capable" content="yes">\n' +
  '<link rel="icon" href="icon192.png">\n' +
  '<script src="sim.js"></script>\n<script src="movil-shim.js"></script>\n</head>';
function page(name) {
  let h = read(name);
  if (h.split('</head>').length !== 2) throw new Error('No encontré </head> en ' + name);
  h = h.replace('</head>', HEAD);
  h = h.split('href="/systems"').join('href="systems.html"').split('href="/"').join('href="index.html"');
  h = h.split('conectado al servidor').join('reactor local');
  return h;
}

// ---------- 4. audios (solo los de la playlist, la intro y la explosión) ----------
function listAudio() {
  const tracks = [];
  const scan = (dir) => {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return;
    for (const f of fs.readdirSync(full)) {
      if (/^m[uú]sica/i.test(f) && AUDIO_EXT.includes(path.extname(f).toLowerCase()) && fs.statSync(path.join(full, f)).isFile()) {
        tracks.push({ name: f, from: path.join(full, f) });
      }
    }
  };
  scan('.');
  scan('musica');
  tracks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const one = (base) => {
    for (const e of AUDIO_EXT) if (fs.existsSync(path.join(ROOT, base + e))) return { name: base + e, from: path.join(ROOT, base + e) };
    return null;
  };
  return { tracks, inicio: one('inicio'), explosion: one('explosion'), meltdown: one('meltdown') };
}

// ---------- armar la carpeta ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });

const files = ['index.html', 'systems.html', 'sim.js', 'movil-shim.js', 'manifest.webmanifest', 'audio.json', 'icon192.png', 'icon512.png'];
fs.writeFileSync(path.join(OUT, 'index.html'), page('index.html'));
fs.writeFileSync(path.join(OUT, 'systems.html'), page('systems.html'));
fs.writeFileSync(path.join(OUT, 'sim.js'), simJs);
fs.writeFileSync(path.join(OUT, 'movil-shim.js'), shimJs);
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: 'Plasma Reactor Core', short_name: 'PLRC', start_url: './index.html', scope: './',
  display: 'fullscreen', orientation: 'landscape', background_color: '#05070d', theme_color: '#05070d',
  icons: [
    { src: 'icon192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
}, null, 2));
for (const ic of ['icon192.png', 'icon512.png']) {
  if (fs.existsSync(path.join(ROOT, ic))) fs.copyFileSync(path.join(ROOT, ic), path.join(OUT, ic));
  else console.warn('Aviso: falta ' + ic + ' (la app se instala igual pero sin ícono propio).');
}

const au = listAudio();
const copy = (a) => { fs.copyFileSync(a.from, path.join(OUT, 'audio', a.name)); files.push('audio/' + encodeURIComponent(a.name)); return a.name; };
const audioJson = { tracks: au.tracks.map(copy), inicio: au.inicio ? copy(au.inicio) : null, explosion: au.explosion ? copy(au.explosion) : null, meltdown: au.meltdown ? copy(au.meltdown) : null };
fs.writeFileSync(path.join(OUT, 'audio.json'), JSON.stringify(audioJson, null, 2));

// service worker: guarda todo para que funcione sin internet
const cacheName = 'plrc-' + Date.now();
fs.writeFileSync(path.join(OUT, 'sw.js'), `const CACHE = ${JSON.stringify(cacheName)};
const FILES = ${JSON.stringify(['./', ...files.filter((f) => !f.startsWith('icon') || fs.existsSync(path.join(OUT, f))), 'sw.js'])};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => { if (e.request.method !== 'GET') return; e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request))); });
`);

let mb = 0;
for (const f of fs.readdirSync(path.join(OUT, 'audio'))) mb += fs.statSync(path.join(OUT, 'audio', f)).size;
console.log('Listo: se creó la carpeta "movil".');
console.log('Canciones de fondo: ' + (audioJson.tracks.length ? audioJson.tracks.join(', ') : 'ninguna (suena la melodía integrada)'));
console.log('Intro: ' + (audioJson.inicio || 'sonido sintético') + ' | Meltdown: ' + (audioJson.meltdown || 'sonidos sintéticos') + ' | Explosión: ' + (audioJson.explosion || 'sonido sintético'));
console.log('Audios: ' + (mb / 1048576).toFixed(1) + ' MB en total.');
