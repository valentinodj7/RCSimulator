// PLRC 2D - servidor del reactor. Sin dependencias: solo Node.js.
// Uso: node server.js -> abrir http://localhost:3000
// Audio opcional:
// inicio.mp3 = canción de la animación de inicio
// musica.mp3 = música de fondo

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const TIMESCALE = Number(process.env.TIMESCALE) || 1;
const AMBIENT = 20;
const MELT_AT = 500000;
const MELT_SECONDS = 130;   // cuenta hasta la explosión: 2 min 10 s
const COOL_SECONDS = 13.2;  // 3,2 s de explosión + 10 s de pantalla de reconstrucción
const LOG_RANGE = Math.log10(MELT_AT / AMBIENT);

const HEAT_BASE = 150;
const HEAT_GAIN = 0.05;
const COOL_POWER = 0.12;
const LEAK = 0.02;

// ---------- Juego: potencia, contratos y eventos ----------
// La potencia que entrega el reactor depende de la temperatura:
// 1.000 °C = 1 MW  ->  500.000 °C = 500 MW (y ahí es Meltdown).
const MW_PER_DEG = 1 / 1000;
const BAND_OVER = 1.2; // el contrato acepta hasta 20% más de lo pedido
const MW_CAP = 480;    // techo de la banda: más arriba está pegado al Meltdown

// Contratos: la red pide una potencia estable durante unos segundos.
//   mw     = potencia mínima pedida
//   hold   = segundos que hay que sostenerla dentro de la banda
//   limit  = tiempo total para cumplir (incluye calentar el reactor)
//   reward = créditos
const MISSIONS = [
  { name: 'Hospital Regional Valle Claro',     mw: 40,  hold: 25, limit: 150, reward: 100 },
  { name: 'Planta Potabilizadora Río Sereno',  mw: 85,  hold: 30, limit: 190, reward: 180 },
  { name: 'Ciudad Nueva Aurora',               mw: 115, hold: 40, limit: 220, reward: 320 },
  { name: 'Fundición Acero Norte',             mw: 200, hold: 40, limit: 260, reward: 600 },
  { name: 'Puerto Industrial Bahía Plata',     mw: 300, hold: 45, limit: 300, reward: 950 },
  { name: 'Estación Orbital Helios',           mw: 420, hold: 45, limit: 320, reward: 1500 },
];

// Eventos al azar mientras el reactor está encendido.
//   cool   = multiplicador de lo que enfría el refrigerante
//   leak   = multiplicador de la pérdida natural de calor
//   heat   = multiplicador del calor que genera el plasma
//   reward = multiplicador de créditos por entrega
//   dur    = [mín, máx] segundos
//   repairable = se puede arreglar con el botón REPARAR (cuesta créditos y tarda unos segundos)
const REPAIR_COST = 50;
const REPAIR_SECONDS = 6;
const EVENTS = [
  { id: 'summer', icon: '☀', name: 'VERANO', desc: 'Calor extremo: el refrigerante enfría 40% menos.', cool: 0.6, leak: 0.7, dur: [45, 65] },
  { id: 'winter', icon: '❄', name: 'INVIERNO', desc: 'Frío intenso: el refrigerante enfría 50% más.', cool: 1.5, leak: 1.4, dur: [45, 65] },
  { id: 'storm', icon: '⚡', name: 'TORMENTA SOLAR', desc: 'El plasma genera 25% más calor.', heat: 1.25, dur: [35, 50] },
  { id: 'pump', icon: '🔧', name: 'FALLA EN BOMBA P-01', desc: 'El refrigerante solo rinde al 30%.', cool: 0.3, repairable: true, dur: [25, 40] },
  { id: 'pump2', icon: '🔧', name: 'FALLA EN BOMBA P-02', desc: 'La inyección de plasma solo rinde al 40%.', heat: 0.4, repairable: true, dur: [25, 40] },
  { id: 'demand', icon: '💰', name: 'PICO DE DEMANDA', desc: 'La red paga el doble por cada entrega.', reward: 2, dur: [40, 60] },
  { id: 'meteors', icon: '☄', name: 'LLUVIA DE METEORITOS', desc: 'Impactos en el escudo: la temperatura sube a golpes.', meteors: true, dur: [30, 45] },
  { id: 'pulse', icon: '💥', name: 'PULSO DE PLASMA', desc: 'Un pico súbito sube la temperatura.', pulse: true, dur: [8, 8] },
];

const s = {
  temp: AMBIENT,
  fuel: 0,
  coolant: 0,
  servers: {
    compute: false,
    storage: false,
    network: false
  },
  message: '',
  shieldIntegrity: 100,
  ignited: false,
  phase: 'NORMAL',
  phaseTime: 0,
  // juego
  score: 0,
  completed: 0,
  streak: 0,
  mission: null,
  missionIdx: 0,
  missionDelay: 0,
  event: null,
  lastEventId: '',
  nextEventIn: 0,
  nextChatterIn: 0,
  notices: [],
};

let noticeId = 0;

function rnd(a, b) {
  return a + Math.random() * (b - a);
}

function notice(kind, text, sfx) {
  s.notices.push({ id: ++noticeId, kind, text, sfx: sfx || '' });
  if (s.notices.length > 8) s.notices.shift();
}

function power() {
  return s.ignited ? s.temp * MW_PER_DEG : 0;
}

function missionAt(idx) {
  const base = MISSIONS[idx % MISSIONS.length];
  const lap = Math.floor(idx / MISSIONS.length);
  return {
    name: base.name,
    mw: base.mw,
    bandMax: Math.min(Math.round(base.mw * BAND_OVER), MW_CAP),
    hold: base.hold + lap * 10,
    limit: base.limit,
    reward: Math.round(base.reward * (1 + lap * 0.5) / 5) * 5,
    n: (idx % MISSIONS.length) + 1,
    total: MISSIONS.length,
    lap: lap + 1,
    progress: 0,
    timeLeft: base.limit,
    inBand: false,
  };
}

function startMission() {
  s.mission = missionAt(s.missionIdx);
  const m = s.mission;
  notice(
    'mission',
    'NUEVO CONTRATO · ' + m.name + ' pide entre ' + m.mw + ' y ' + m.bandMax +
      ' MW durante ' + m.hold + ' s',
    'mission-new'
  );
}

function completeMission() {
  const m = s.mission;
  const ev = s.event;
  const streakBonus = 1 + Math.min(s.streak, 5) * 0.1;
  const shieldBonus = s.shieldIntegrity >= 80 ? 1.25 : 1;
  const evBonus = ev && ev.reward > 1 ? ev.reward : 1;
  const gain = Math.round(m.reward * streakBonus * shieldBonus * evBonus / 5) * 5;

  s.score += gain;
  s.completed += 1;
  s.streak += 1;

  const extras = [];
  if (streakBonus > 1) extras.push('racha x' + s.streak);
  if (shieldBonus > 1) extras.push('escudo intacto');
  if (evBonus > 1) extras.push('pico de demanda x' + evBonus);

  notice(
    'ok',
    'ENTREGA COMPLETA · ' + m.name + ' · +' + gain + ' cr' +
      (extras.length ? ' (' + extras.join(', ') + ')' : ''),
    'mission-ok'
  );

  s.missionIdx += 1;
  s.mission = null;
  s.missionDelay = 6;
}

function failMission(reason) {
  const m = s.mission;
  const loss = Math.min(s.score, Math.round(m.reward * 0.25 / 5) * 5);
  s.score -= loss;
  s.streak = 0;

  notice(
    'bad',
    reason + ' · ' + m.name + (loss ? ' · -' + loss + ' cr' : ''),
    'mission-fail'
  );

  s.missionIdx += 1;
  s.mission = null;
  s.missionDelay = 6;
}

function updateMission(dt) {
  const m = s.mission;

  if (!m) {
    s.missionDelay -= dt;
    if (s.missionDelay <= 0) startMission();
    return;
  }

  const mw = power();
  m.inBand = mw >= m.mw && mw <= m.bandMax;
  m.timeLeft -= dt;

  if (m.inBand) m.progress = Math.min(m.hold, m.progress + dt);

  if (m.progress >= m.hold) {
    completeMission();
  } else if (m.timeLeft <= 0) {
    failMission('TIEMPO AGOTADO');
  }
}

function onMeltdown() {
  const loss = Math.min(s.score, 200);
  const had = !!s.mission;
  s.score -= loss;
  s.streak = 0;
  s.mission = null; // el mismo contrato se vuelve a ofrecer al reencender
  s.event = null;
  notice(
    'bad',
    'MELTDOWN · explosión en 2:10' + (had ? ' · contrato cancelado' : '') + (loss ? ' · -' + loss + ' cr' : ''),
    'mission-fail'
  );
}

function pickEvent() {
  const pool = EVENTS.filter((e) => e.id !== s.lastEventId);
  return pool[Math.floor(Math.random() * pool.length)];
}

function startEvent(forceId) {
  const def = forceId ? EVENTS.find((e) => e.id === forceId) : pickEvent();
  if (!def) return;

  const dur = rnd(def.dur[0], def.dur[1]);
  s.lastEventId = def.id;
  s.event = {
    id: def.id,
    icon: def.icon,
    name: def.name,
    desc: def.desc,
    total: dur,
    timeLeft: dur,
    cool: def.cool || 1,
    leak: def.leak || 1,
    heat: def.heat || 1,
    reward: def.reward || 1,
    repairable: !!def.repairable,
    repair: null,
    hits: 0,
    impactIn: rnd(2, 4),
  };

  notice('event', def.icon + ' ' + def.name + ' · ' + def.desc, 'ev-' + def.id);

  if (def.pulse) {
    // salto súbito de temperatura, sin llegar solo al Meltdown
    s.temp = Math.min(MELT_AT - 10000, s.temp * 1.15 + 3000);
  }
}

function endEvent() {
  notice('info', 'Fin del evento: ' + s.event.name, '');
  s.event = null;
  s.nextEventIn = rnd(40, 75);
}

function updateEvents(dt) {
  if (s.event) {
    s.event.timeLeft -= dt;
    if (s.event.id === 'meteors') {
      s.event.impactIn -= dt;
      if (s.event.impactIn <= 0) {
        // impacto: salto de temperatura y golpe al escudo
        s.event.hits += 1;
        s.event.impactIn = rnd(2.5, 5);
        s.temp = Math.min(MELT_AT - 5000, s.temp * 1.02 + 300);
        s.shieldIntegrity = Math.max(0, s.shieldIntegrity - 3);
      }
    }
    if (s.event.repair) {
      s.event.repair.timeLeft -= dt;
      if (s.event.repair.timeLeft <= 0) {
        notice('ok', '🔧 REPARADO · ' + s.event.name + ' solucionada', 'repair-ok');
        s.event = null;
        s.nextEventIn = rnd(40, 75);
        return;
      }
    }
    if (s.event.timeLeft <= 0) endEvent();
  } else {
    s.nextEventIn -= dt;
    if (s.nextEventIn <= 0) startEvent();
  }
}

function chatter() {
  const mw = power();
  const pool = [
    'A.R.I.A.: telemetría estable en los tres racks.',
    'A.R.I.A.: bobinas magnéticas dentro de parámetros.',
    'Red orbital: frecuencia estable, seguimos conectados.',
    'A.R.I.A.: circuito de plasma sin fugas detectadas.',
  ];

  if (s.temp > 200000) {
    pool.push('A.R.I.A.: el escudo sufre a esta temperatura, no se pasen.');
  }
  if (s.shieldIntegrity < 50) {
    pool.push('A.R.I.A.: ALERTA, integridad del escudo por debajo del 50%.');
  }
  if (s.mission && mw < s.mission.mw * 0.5) {
    pool.push('Red orbital: ' + s.mission.name + ' espera más potencia.');
  }

  notice('info', pool[Math.floor(Math.random() * pool.length)], '');
}

function step(dt) {
  if (s.phase === 'MELTDOWN') {
    s.temp = MELT_AT;
    s.shieldIntegrity = 0;
    s.phaseTime += dt;

    if (s.phaseTime >= MELT_SECONDS) {
      s.phase = 'COOLDOWN';
      s.phaseTime = 0;
      s.ignited = false;
      s.fuel = 0;
    }
    return;
  }

  if (s.phase === 'COOLDOWN') {
    s.phaseTime += dt;
    let x = Math.log10(
      Math.max(s.temp, AMBIENT * 1.0001) / AMBIENT
    );

    x -= dt * LOG_RANGE / COOL_SECONDS;

    if (x <= 0.002) {
      s.temp = AMBIENT;
      s.phase = 'NORMAL';
      s.phaseTime = 0;
      s.coolant = 0;
      s.shieldIntegrity = 100;
      return;
    }

    s.temp = AMBIENT * Math.pow(10, x);
    return;
  }

  const f = s.ignited ? s.fuel / 100 : 0;
  const c = s.coolant / 100;

  // Los eventos modifican el calor, el refrigerante o la pérdida natural.
  const ev = s.event;
  const mh = ev ? ev.heat : 1;
  const mc = ev ? ev.cool : 1;
  const ml = ev ? ev.leak : 1;

  const heat = f * (HEAT_BASE + HEAT_GAIN * s.temp) * mh;
  const cool = c * COOL_POWER * mc * (s.temp - AMBIENT);
  const leak = LEAK * ml * (s.temp - AMBIENT);

  s.temp += (heat - cool - leak) * dt;

  if (s.temp < AMBIENT) s.temp = AMBIENT;

  if (s.temp >= 200000) {
    const targetIntegrity = Math.max(
      0,
      100 - ((s.temp - 200000) / 300000) * 100
    );

    s.shieldIntegrity = Math.min(
      s.shieldIntegrity,
      targetIntegrity
    );
  } else if (s.temp < 150000) {
    // apagado se repara rápido; con el reactor encendido, de a poco
    s.shieldIntegrity = Math.min(
      100,
      s.shieldIntegrity + dt * (s.ignited ? 0.4 : 1.5)
    );
  }

  if (s.temp >= MELT_AT) {
    s.temp = MELT_AT;
    s.shieldIntegrity = 0;
    s.phase = 'MELTDOWN';
    s.phaseTime = 0;
    onMeltdown();
    return;
  }

  if (s.ignited) {
    updateEvents(dt);
    updateMission(dt);

    s.nextChatterIn -= dt;
    if (s.nextChatterIn <= 0) {
      chatter();
      s.nextChatterIn = rnd(30, 55);
    }
  }
}

let last = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - last) / 1000) * TIMESCALE;
  last = now;
  step(dt);
}, 50);

const clients = new Set();

function snapshot() {
  return JSON.stringify({
    temp: s.temp,
    fuel: s.fuel,
    coolant: s.coolant,
    shieldIntegrity: s.shieldIntegrity,
    servers: s.servers,
    message: s.message,
    ignited: s.ignited,
    phase: s.phase,
    phaseTime: s.phaseTime,
    meltSeconds: MELT_SECONDS,
    coolSeconds: COOL_SECONDS,
    power: power(),
    score: s.score,
    completed: s.completed,
    streak: s.streak,
    mission: s.mission,
    event: s.event,
    notices: s.notices
  });
}

setInterval(() => {
  const msg = 'data: ' + snapshot() + '\n\n';

  for (const res of clients) {
    res.write(msg);
  }
}, 100);

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function serversReady() {
  return Object.values(s.servers).every(Boolean);
}

function startRepair() {
  const ev = s.event;
  if (!s.ignited || !ev || !ev.repairable || ev.repair) return;

  const cost = Math.min(s.score, REPAIR_COST);
  s.score -= cost;
  ev.repair = { timeLeft: REPAIR_SECONDS, total: REPAIR_SECONDS };

  notice(
    'info',
    '🔧 Mantenimiento trabajando en ' + ev.name + (cost ? ' · -' + cost + ' cr' : ''),
    'repair-start'
  );
}

// Estados visuales del simulador local.
// No hay conexión con hardware físico.
function handleCmd(c) {
  if (!c || typeof c !== 'object') return;

  if (c.type === 'setServer') {
    if (s.ignited) {
      s.message =
        'Apagá primero la simulación del reactor antes de cambiar el estado visual de los racks.';
      return;
    }

    if (s.phase !== 'NORMAL') {
      s.message =
        'Los racks están bloqueados mientras el simulador está en enfriamiento o alarma.';
      return;
    }

    const rack = [
      'compute',
      'storage',
      'network'
    ].includes(c.rack) ? c.rack : null;

    if (!rack || typeof c.on !== 'boolean') return;

    s.servers[rack] = c.on;

    if (!serversReady()) {
      s.fuel = 0;
      s.coolant = 0;

      s.message =
        'Hay servidores apagados. Encendé los tres racks antes de activar las bombas.';
    } else {
      s.message =
        'Los tres racks están encendidos. Ya podés habilitar las dos bombas simuladas.';
    }

    return;
  }

  if (s.phase !== 'NORMAL') return;

  if (c.type === 'set') {
    const requestsPumpOn =
      (typeof c.fuel === 'number' && c.fuel > 0) ||
      (typeof c.coolant === 'number' && c.coolant > 0);

    if (requestsPumpOn && !serversReady()) {
      s.message =
        'REQUISITO PENDIENTE: encendé primero los tres servidores.';
      return;
    }

    if (typeof c.fuel === 'number') {
      s.fuel = clamp(c.fuel, 0, 100);
    }

    if (typeof c.coolant === 'number') {
      s.coolant = clamp(c.coolant, 0, 100);
    }

    s.message = '';

  } else if (c.type === 'ignite') {
    if (!serversReady()) {
      s.message =
        'NO SE PUEDE INICIAR: primero encendé los tres servidores.';

    } else if (s.coolant <= 0 && s.fuel <= 0) {
      s.message =
        'NO SE PUEDE INICIAR: es necesario encender las dos bombas.';

    } else if (s.coolant <= 0) {
      s.message =
        'NO SE PUEDE INICIAR: falta encender la bomba de refrigerante.';

    } else if (s.fuel <= 0) {
      s.message =
        'NO SE PUEDE INICIAR: falta encender la bomba de recirculación.';

    } else {
      s.message = '';

      if (!s.ignited) {
        // arranca la partida: primer contrato en 4 s y primer evento en ~1 min
        s.missionDelay = 4;
        s.nextEventIn = rnd(40, 70);
        s.nextChatterIn = rnd(25, 40);
        s.event = null;
        s.mission = null;
        notice('info', 'REACTOR EN LÍNEA · A.R.I.A. conectada con la red orbital', '');
      }

      s.ignited = true;
      s.fuel = Math.max(s.fuel, 20);
    }

  } else if (c.type === 'repair') {
    startRepair();

  } else if (c.type === 'scram') {
    if (s.mission) {
      notice('info', 'Contrato suspendido: ' + s.mission.name, '');
    }

    s.mission = null;
    s.event = null;
    s.ignited = false;
    s.fuel = 0;
    s.coolant = 100;
    s.message = 'Simulación detenida.';
  }
}

const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a'];

const MIME = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4'
};

// Busca inicio / meltdown / explosion junto a server.js y también dentro de la carpeta "musica".
// Ignora mayúsculas, espacios, guiones y guiones bajos: "Alarma Inicio.MP3" también sirve para alarma_inicio.
function normName(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s_-]+/g, '');
}
function findAudio(base) {
  const want = normName(base);
  for (const dir of ['', 'musica/']) {
    let files = [];
    try { files = fs.readdirSync(path.join(__dirname, dir || '.')); } catch (e) { continue; }
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) continue;
      if (normName(path.basename(f, path.extname(f))) === want) return dir + f;
    }
  }

  return null;
}

// Alarmas personalizadas: alarma_inicio.mp3 y alarma_meltdown.mp3 (junto a server.js o en la carpeta musica)
const SONIDOS = ['alarma_inicio', 'alarma_meltdown'];

function serveAudio(res, base) {
  const f = findAudio(base);

  if (!f) {
    res.writeHead(404);
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(f).toLowerCase()] ||
      'application/octet-stream'
  });

  fs.createReadStream(path.join(__dirname, f)).pipe(res);
}

// ---- Playlist: archivos cuyo nombre empieza con "musica" (musica.mp3, musica1.mp3, musica2.mp3...) ----
// Se buscan junto a server.js y dentro de la carpeta "musica". Inicio, explosion u otros audios nunca entran.
function playlist() {
  const out = [];
  const scan = (dir, prefix) => {
    try {
      for (const f of fs.readdirSync(path.join(__dirname, dir))) {
        if (/^m[uú]sica/i.test(f) && AUDIO_EXT.includes(path.extname(f).toLowerCase())) out.push(prefix + f);
      }
    } catch (e) { /* no existe la carpeta */ }
  };
  scan('.', '');
  scan('musica', 'musica/');
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
}
function serveTrack(res, name) {
  const list = playlist();
  const f = name ? list.find((x) => x === name) : list[0];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(path.join(__dirname, f)).pipe(res);
}
function json(res, obj) {
  res.writeHead(200, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify(obj));
}

// ---- Voz de la IA con ElevenLabs (opcional) ----
// Poné un archivo voz.json junto a server.js:  { "apiKey": "TU_CLAVE", "voiceId": "ID_DE_LA_VOZ" }
// (o las variables ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ID). Sin eso se usa la voz del navegador.
const crypto = require('crypto');
function vozConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, 'voz.json'), 'utf8')); } catch (e) { /* sin archivo */ }
  return {
    apiKey: process.env.ELEVENLABS_API_KEY || c.apiKey || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || c.voiceId || '',
    model: c.model || 'eleven_multilingual_v2',
  };
}
const VOZ_DIR = path.join(__dirname, 'voz-cache');
const vozPending = new Map();
async function vozAudio(text) {
  const cfg = vozConfig();
  if (!cfg.apiKey || !cfg.voiceId) throw new Error('sin configurar');
  const key = crypto.createHash('sha1').update(cfg.voiceId + '|' + cfg.model + '|' + text).digest('hex');
  const file = path.join(VOZ_DIR, key + '.mp3');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (vozPending.has(key)) return vozPending.get(key);
  const job = (async () => {
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(cfg.voiceId) + '?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: cfg.model }),
    });
    if (!r.ok) throw new Error('ElevenLabs ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    try { fs.mkdirSync(VOZ_DIR, { recursive: true }); fs.writeFileSync(file, buf); } catch (e) { /* sin cache */ }
    return buf;
  })();
  vozPending.set(key, job);
  try { return await job; } finally { vozPending.delete(key); }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (
    req.method === 'GET' &&
    (url === '/systems' || url === '/systems.html')
  ) {
    fs.readFile(
      path.join(__dirname, 'systems.html'),
      (err, data) => {
        if (err) {
          res.writeHead(500);
          return res.end('Falta systems.html');
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8'
        });

        res.end(data);
      }
    );

  } else if (
    req.method === 'GET' &&
    (url === '/' || url === '/index.html')
  ) {
    fs.readFile(
      path.join(__dirname, 'index.html'),
      (err, data) => {
        if (err) {
          res.writeHead(500);
          return res.end('Falta index.html');
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });

        res.end(data);
      }
    );

  } else if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    res.write('data: ' + snapshot() + '\n\n');
    clients.add(res);

    req.on('close', () => clients.delete(res));

  } else if (req.method === 'GET' && url === '/state') {
    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    res.end(snapshot());

  } else if (req.method === 'GET' && url === '/voz-info') {
    const cfg = vozConfig();
    json(res, { enabled: !!(cfg.apiKey && cfg.voiceId) });
  } else if (req.method === 'GET' && url === '/voz') {
    const text = (new URL(req.url, 'http://x').searchParams.get('t') || '').slice(0, 300);
    if (!text) { res.writeHead(400); return res.end(); }
    vozAudio(text).then((buf) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length });
      res.end(buf);
    }).catch((e) => {
      console.log('Voz IA: ' + e.message + ' (se usa la voz del navegador)');
      res.writeHead(502); res.end();
    });
  } else if (req.method === 'GET' && url === '/sonido-info') {
    const n = new URL(req.url, 'http://x').searchParams.get('n');
    json(res, { file: SONIDOS.includes(n) ? findAudio(n) : null });
  } else if (req.method === 'GET' && url === '/sonido') {
    const n = new URL(req.url, 'http://x').searchParams.get('n');
    if (!SONIDOS.includes(n)) { res.writeHead(404); return res.end(); }
    serveAudio(res, n);
  } else if (req.method === 'GET' && url === '/meltdown-info') {
    json(res, { file: findAudio('meltdown') });
  } else if (req.method === 'GET' && url === '/meltdown') {
    serveAudio(res, 'meltdown');
  } else if (req.method === 'GET' && url === '/explosion-info') {
    json(res, { file: findAudio('explosion') });
  } else if (req.method === 'GET' && url === '/explosion') {
    serveAudio(res, 'explosion');
  } else if (req.method === 'GET' && url === '/musica-info') {
    json(res, { file: playlist()[0] || null, tracks: playlist() });

  } else if (req.method === 'GET' && url === '/musica') {
    serveTrack(res, new URL(req.url, 'http://x').searchParams.get('f'));

  } else if (req.method === 'GET' && url === '/inicio-info') {
    json(res, { file: findAudio('inicio') });

  } else if (req.method === 'GET' && url === '/inicio') {
    serveAudio(res, 'inicio');

  } else if (req.method === 'POST' && url === '/cmd') {
    let body = '';

    req.on('data', (d) => {
      body += d;

      if (body.length > 2000) req.destroy();
    });

    req.on('end', () => {
      try {
        handleCmd(JSON.parse(body));
      } catch (e) {
        // Ignorar comandos incorrectos
      }

      res.writeHead(204);
      res.end();
    });

  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    'Reactor corriendo en http://localhost:' + PORT
  );

  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) {
        console.log(
          'En tu red: http://' + i.address + ':' + PORT
        );
      }
    }
  }

  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const m0 = html.match(/const T_COUNT = (\d+), T_END = (\d+)/);
    console.log('Pagina: ' + path.join(__dirname, 'index.html'));
    if (m0) console.log('Intro: cuenta regresiva ' + m0[1] + ' s + ignicion ' + (m0[2] - m0[1]) + ' s');
  } catch (e) { /* sin index.html */ }

  console.log('Alarma de inicio: ' + (findAudio('alarma_inicio') || 'no hay (poné alarma_inicio.mp3 para usar la tuya)'));
  console.log('Alarma de meltdown: ' + (findAudio('alarma_meltdown') || 'no hay (poné alarma_meltdown.mp3 para usar la tuya)'));
  console.log('Cancion del meltdown: ' + (findAudio('meltdown') || 'no hay (poné meltdown.mp3 junto a server.js)'));
  console.log('Sonido de explosion: ' + (findAudio('explosion') || 'no hay (se usa uno sintetico)'));

  const a = findAudio('inicio');
  const m = findAudio('musica');

  console.log(
    a
      ? 'Cancion de inicio: ' + a
      : 'Cancion de inicio: no hay (poné inicio.mp3 en esta carpeta)'
  );

  console.log(
    m
      ? 'Musica de fondo: ' + m
      : 'Musica de fondo: melodia ambiente integrada'
  );
});
