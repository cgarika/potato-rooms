/* Hot Potato Rooms: self-hosted live Hot Potato for three to eight (GameNest's `potato`, dev port 3128).

   Same shape as the other GameNest game servers: rooms behind a 6-letter code, bots fill the seats, README.md has the wire. */

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Voice = require("./voice");   // voice chat in private rooms, EOS (2026-11-18; the file every server shares)
const Played = require("./friendsplayed");   // Friends: "last played with" when a game ends (2026-11-19; the file every server shares)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const PassPlay = require("./passplay");   // several players on one phone (2026-11-18)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const PING = {};
if (Number(process.env.PING_INTERVAL_MS) > 0) PING.pingInterval = Number(process.env.PING_INTERVAL_MS);
if (Number(process.env.PING_TIMEOUT_MS) > 0) PING.pingTimeout = Number(process.env.PING_TIMEOUT_MS);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true }, ...PING });

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const TEST_HOOKS = process.env.TEST_HOOKS === "1";
/* The clocks, in ms. */
const COUNTDOWN_MS = Math.max(50, Number(process.env.COUNTDOWN_MS || 3000));    // 3, 2, 1 before the first bomb
const SERVE_MS = Math.max(50, Number(process.env.SERVE_MS || 1300));            // a new bomb is shown this long before play
const POP_MS = Math.max(50, Number(process.env.POP_MS || 2600));                // the pop (the app's burst and slow-mo)
const FLIGHT_MS = Math.max(20, Number(process.env.FLIGHT_MS || 420));           // a throw's arc
const TWIST_MS = Math.max(20, Number(process.env.TWIST_MS || 650));             // a reverse or skip hands it on after this
const FUSE_MIN_MS = Math.max(100, Number(process.env.FUSE_MIN_MS || 8000));
const FUSE_MAX_MS = Math.max(FUSE_MIN_MS, Number(process.env.FUSE_MAX_MS || 25000));
const HEAT_MS = 6000;                                                           // the bomb heats over its last 6 s
const FUSE_SHOW_MS = 5000;                                                      // the digits show in the last 5 s
const AFK_MS = Math.max(300, Number(process.env.AFK_MS || 8000));               // a holder that does nothing this long is played by a bot
const SNAP_MS = 100;                                                            // 10 snapshots a second
const ROOM_IDLE_MS = 2 * 3600e3;
const NAME_GRAPHEMES = 18;             // one cap on every GameNest server, in whole characters
const CAPS = [];
const LIVES = [1, 3];
const LOOKS = ["slime", "workshop", "disco"];
const LEVELS = ["easy", "normal", "hard"];

const BOT_NAMES = { easy: ["Goo", "Blob", "Squish", "Bubbles", "Drip", "Wobble", "Ooze"], normal: ["Fizz", "Zap", "Gizmo", "Sprocket", "Cog", "Widget", "Pip"], hard: ["Boom", "Blitz", "Nitro", "Turbo", "Rocket", "Dash", "Flash"] };

const AVATARS = ["\u{1F60E}", "\u{1F913}", "\u{1F451}", "\u{1F42F}", "\u{1F43C}", "\u{1F98A}"];
const CODE_ALPHABET = "ABCDEFGHJKMNPRTWXYZ";

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const roomSockets = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }

/* A payload is an object or nothing. `42["create",null]` used to throw inside the
   handler and take the whole process, and every room in it, down. */
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

/* ---------- text ---------- */

/* A string, whatever arrives: a string, a number or a boolean as itself, anything else (an object with a hostile
   toString, an array) as nothing. String() on `{toString: 1}` throws. */
const text = (s) => (typeof s === "string" ? s : typeof s === "number" || typeof s === "boolean" ? String(s) : "");

const SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/* At most `max` whole characters (grapheme clusters: an emoji with its skin tone, a flag,
   a letter and its accents) in at most `units` UTF-16 units, never cutting one in half. */
function graphemes(s, max, units) {
  s = text(s);
  if (s.length > 4 * units) s = s.slice(0, 4 * units);    // bounds the work on a 100 KB name
  let out = "", n = 0;
  const parts = SEGMENTER ? Array.from(SEGMENTER.segment(s), (x) => x.segment) : Array.from(s);
  for (const g of parts) {
    if (n >= max || out.length + g.length > units) break;
    out += g; n++;
  }
  return out;
}
const strip = (s) => text(s).replace(/[<>&"'`\u0000-\u001f\u007f]/g, "").trim();
const cleanName = (s) => { const c = graphemes(strip(s), NAME_GRAPHEMES, 96).trim(); return c ? Moderation.name(c) : c; };   // a bad name is "Player"
const cleanAvatar = (s) => graphemes(strip(s), 1, 16);
const cleanId = (s) => (typeof s === "string" && s.length > 0 && s.length <= 128 ? s : null);
const cleanCaps = (c) => (Array.isArray(c) ? CAPS.filter((k) => c.includes(k)) : []);

/* A refusal: today's words for today's app, and a code a newer one can switch on without
   reading English. The code rides as a second argument, which an app that reads only the
   first never sees. Codes: not_found, started, full, name, nobody. */
function refuse(socket, op, code, message) { socket.emit("err", message, { code, op }); }

/* ---------- chat, voice and push ----------

   Copied from the other room servers rather than reinvented, because a client that already
   speaks them must not find another that is subtly different. */

const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;
const STICKERS = ["lol","cry","fire","dice","snail","devil","pray","skull","party","angry","pinch","run"];
const cleanChat = (n) => graphemes(text(n).replace(/[<>&"'`]/g, "").trim(), 140, 140);

const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = "Hot Potato";

function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  // only someone who cannot see the screen
  if (!(p.away || !p.connected)) return;
  const now = Date.now();
  if (p._lastPush && now - p._lastPush < 4000) return;
  p._lastPush = now;
  fetch(PUSH_URL + "/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }),
  }).catch(() => {});
}



/* ---------- room shape ---------- */

function newRoom(code, host) {
  return {
    v: 1, code, host, status: "lobby",
    players: [],
    opts: { lives: 1, look: "slime" },       // the host's choices
    phase: "lobby",                // lobby, countdown, play, pop, serve, over
    phaseEndsAt: null, phaseLeft: null,
    holder: null, heldAt: 0, dir: 1,
    fuseLeftMs: 0,                 // the hidden fuse: never sent
    flight: null,                  // { from, to, t0, ms }: the bomb in the air
    pickup: null,                  // { seat, kind: "reverse" | "skip" }
    twist: null, pop: null, elim: [],
    winner: null,
    log: "Share the code with your friends.",
    chat: [],
    round: 0, tick: 0, lastAt: 0,
    touched: Date.now(),
  };
}

function publicRoom(room) {
  const now = Date.now();
  const place = (i) => {   // 1 = the winner, then the others by how long they lasted
    if (room.status !== "over") return 0;
    if (i === room.winner) return 1;
    const k = room.elim.indexOf(i);
    return k < 0 ? 0 : room.players.length - k;
  };
  return {
    code: room.code, status: room.status,
    players: room.players.map((p, i) => ({
      name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, ...(p.bot ? { level: p.level } : {}),
      botControlled: !!p.botControlled, left: p.left, connected: p.connected, local: !!p.local,
      lives: p.lives == null ? room.opts.lives : p.lives, out: !!p.out, place: place(i),
    })),
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    opts: { lives: room.opts.lives, look: room.opts.look },
    phase: room.phase, phaseEndsAt: room.phaseEndsAt,
    holder: room.holder == null ? -1 : room.holder, dir: room.dir,
    flight: room.flight ? { from: room.flight.from, to: room.flight.to, t0: room.flight.t0, ms: room.flight.ms } : null,
    pickup: room.pickup, twist: room.twist, pop: room.pop,
    winner: room.winner,
    log: room.log, chat: room.chat, voice: room.voice ? Array.from(room.voice) : [],
    serverNow: now, tick: room.tick,
    v: room.v,
    ...Reactions.view(room),
    ...Quick.view(room),
    ...Voice.view(room),   // voice chat (2026-11-18): gnVoice { on, peers }
    ...Played.view(room, "potato"),   // Friends (2026-11-19): reports a finished game once; adds no field
    ...PassPlay.view(room),   // pass-and-play: which seats this phone plays
  };
}

function sendState(code) {
  const room = rooms.get(code), sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  for (const s of sockets) {
    const mySeat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: Object.assign({}, pub), mySeat });
  }
}
function bump(room) { room.v++; room.touched = Date.now(); sendState(room.code); }

/* ---------- play ---------- */

/* One bomb, one hidden fuse. Whoever holds it taps another player's seat to throw it (a fast arc: FLIGHT_MS); a bomb in the air is nobody's. The fuse (8 to 25 s) is
   the server's alone: the app is told only how hot the bomb is (`snap.h`, 0 to 1 over the last HEAT_MS) and, in the last FUSE_SHOW_MS, the seconds left (`snap.z`).
   When it pops the holder loses a life (the last one is out); the next bomb is served to a player still in. Last one in wins. */
const setPhase = (room, phase, ms) => { room.phase = phase; room.phaseEndsAt = ms == null ? null : Date.now() + ms; room.phaseLeft = ms; };
const alive = (room) => room.players.map((p, i) => (!p.out && !p.left ? i : -1)).filter((i) => i >= 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function brainFor(room, seat) {
  const p = room.players[seat];
  if (!p) return null;
  if (p.bot) return p.level;
  if (p.botControlled) return "normal";
  return null;
}

function startMatch(room) {
  room.status = "playing";
  room.round = (room.round || 0) + 1;
  room.winner = null; room.pop = null; room.flight = null; room.pickup = null; room.throws = 0;
  room.elim = [];
  room.dir = 1;
  room.players = room.players.filter((p) => !p.left);
  for (const p of room.players) { p.lives = room.opts.lives; p.out = false; p.lastIn = Date.now(); p.botControlled = false; }
  room.tick = 0; room.lastAt = Date.now();
  serveBomb(room, pick(alive(room)));
  setPhase(room, "countdown", COUNTDOWN_MS);
  room.log = room.opts.lives > 1 ? `Get ready! Three lives each: the last one in wins.` : `Get ready! One pop and you are out.`;
}

/* A fresh bomb into a seat's hands, a new hidden fuse. */
function serveBomb(room, seat) {
  room.holder = seat;
  room.heldAt = Date.now();
  room.fuseLeftMs = rnd(FUSE_MIN_MS, FUSE_MAX_MS);
  room.flight = null; room.pickup = null; room.throws = 0;
  const p = room.players[seat];
  if (p) p.lastIn = Date.now();
  room.botAt = null;
}

function finishMatch(room, winner, log) {
  room.status = "over";
  room.phase = "over"; room.phaseEndsAt = null;
  room.winner = winner;
  room.flight = null; room.pickup = null;
  room.log = log;
  if (winner != null) {
    Reactions.event(room, winner, "win", bump, 0);
    for (let i = 0; i < room.players.length; i++) if (i !== winner && !room.players[i].bot) Reactions.event(room, i, "bad", bump, 0);
  }
}

/* The seat after `from` in the table's direction, still in (and not `not`). */
function nextSeat(room, from, dir, skip) {
  const n = room.players.length;
  let seat = from, steps = 0, want = 1 + (skip || 0);
  for (let k = 0; k < n * 2 && steps < want; k++) {
    seat = (seat + dir + n) % n;
    if (!room.players[seat].out && !room.players[seat].left && seat !== from) steps++;
  }
  return seat;
}

/* A throw: seat `from` sends the bomb to seat `to`. */
function throwBomb(room, from, to, auto) {
  if (room.phase !== "play" || room.flight || room.holder !== from) return false;
  if (room.autoAt && !auto) return false;   // a reverse or skip is on its way: it is not the holder's to redirect
  const a = room.players[from], b = room.players[to];
  if (!a || !b || a.out || b.out || b.left || from === to) return false;
  room.flight = { from, to, t0: Date.now(), ms: FLIGHT_MS };
  room.holder = null;
  room.throws++;
  room.botAt = null;
  // a twist now and then: a pickup lands on one of the other seats (the bomb landing there takes it)
  if (!room.pickup && !room.local && room.throws >= 2 && Math.random() < 0.35) {
    const cand = alive(room).filter((s) => s !== from && s !== to);
    if (cand.length) room.pickup = { seat: pick(cand), kind: Math.random() < 0.5 ? "reverse" : "skip" };
  }
  room.log = auto ? `${b.name} gets it!` : `${a.name} throws it to ${b.name}!`;
  bump(room);
  return true;
}

function land(room) {
  const f = room.flight;
  room.flight = null;
  if (!f) return;
  const p = room.players[f.to];
  if (!p || p.out || p.left) { // the target went while it flew: the thrower gets it back
    const al = alive(room);
    if (al.length <= 1) { finishMatch(room, al.length ? al[0] : null, al.length ? `${room.players[al[0]].name} wins!` : "Everyone left."); bump(room); return; }
    const back = al.includes(f.from) ? f.from : pick(al);
    room.holder = back; room.heldAt = Date.now(); room.botAt = null; bump(room); return;
  }
  room.holder = f.to; room.heldAt = Date.now(); p.lastIn = Date.now(); room.botAt = null;
  room.lastFrom = f.from;
  const pk = room.pickup;
  if (pk && pk.seat === f.to) {
    room.pickup = null;
    room.twist = { kind: pk.kind, at: Date.now() };
    if (pk.kind === "reverse") { room.dir = -room.dir; room.autoAt = Date.now() + TWIST_MS; room.autoTo = alive(room).includes(f.from) ? f.from : nextSeat(room, f.to, room.dir, 0); room.log = `Reverse! It goes straight back.`; }
    else { room.autoAt = Date.now() + TWIST_MS; room.autoTo = nextSeat(room, f.to, room.dir, 1); room.log = `Skip! ${p.name} hands it on.`; }
  } else { room.autoAt = null; room.log = `${p.name} has the bomb!`; }
  bump(room);
}

function pop(room) {
  const seat = room.holder;
  const p = room.players[seat];
  room.flight = null; room.holder = null; room.pickup = null; room.autoAt = null;
  if (!p) return finishMatch(room, null, "Nobody left."), bump(room);
  p.lives = Math.max(0, p.lives - 1);
  const out = p.lives <= 0;
  if (out) { p.out = true; room.elim.push(seat); }
  room.pop = { seat, out, lives: p.lives };
  room.log = out ? `BOOM! ${p.name} is out!` : `BOOM! ${p.name} loses a life.`;
  if (!p.bot) Reactions.event(room, seat, "bad", bump, POP_MS);
  const left = alive(room);
  room.pendingEnd = left.length <= 1 ? (left.length ? left[0] : seat) : null;
  setPhase(room, "pop", POP_MS);
  bump(room);
}

function endPhase(room) {
  const al0 = alive(room);
  if ((room.phase === "countdown" || room.phase === "serve") && al0.length <= 1) {
    finishMatch(room, al0.length ? al0[0] : null, al0.length ? `${room.players[al0[0]].name} wins!` : "Everyone left.");
    return bump(room);
  }
  if (room.phase === "countdown" || room.phase === "serve") {
    if (room.holder == null || !al0.includes(room.holder)) room.holder = pick(al0);
    room.heldAt = Date.now(); room.botAt = null;
    setPhase(room, "play", null);
    room.log = `${room.players[room.holder].name} has the bomb!`;
    bump(room);
  } else if (room.phase === "pop") {
    room.pendingEnd = null;
    if (al0.length <= 1) {
      const w = al0.length ? al0[0] : null;
      return finishMatch(room, w, w != null ? `${room.players[w].name} wins!` : "Everyone left."), bump(room);
    }
    const popped = room.pop && al0.includes(room.pop.seat) ? room.pop.seat : pick(al0);
    room.pop = null;
    serveBomb(room, popped);
    setPhase(room, "serve", SERVE_MS);
    room.log = `${room.players[popped].name} gets a new bomb.`;
    bump(room);
  }
}

const REACT = { easy: [1100, 1900], normal: [650, 1200], hard: [330, 700] };
function botThrow(room, seat, level) {
  const others = alive(room).filter((s) => s !== seat);
  if (!others.length) return;
  let to;
  if (level === "hard") {
    const min = Math.min(...others.map((s) => room.players[s].lives));
    const weak = others.filter((s) => room.players[s].lives === min && s !== room.lastFrom);
    to = pick(weak.length ? weak : others);
  } else if (level === "normal") {
    const fresh = others.filter((s) => s !== room.lastFrom);
    to = pick(fresh.length ? fresh : others);
  } else to = pick(others);
  throwBomb(room, seat, to, false);
}

/* One tick (about every 25 ms). */
function stepRoom(room, dtMs) {
  const now = Date.now();
  if (room.phase === "play") {
    room.fuseLeftMs -= dtMs;
    if (room.flight && now - room.flight.t0 >= room.flight.ms) land(room);
    if (room.fuseLeftMs <= 0 && !room.flight && room.holder != null) return pop(room);   // a bomb in the air pops on landing, in its new holder's hands
    if (room.autoAt && room.holder != null && now >= room.autoAt) {
      const from = room.holder;
      let to = room.autoTo;
      if (to == null || !room.players[to] || room.players[to].out || room.players[to].left || to === from) to = nextSeat(room, from, room.dir, 0);
      const done = to !== from && throwBomb(room, from, to, true);
      room.autoAt = null;
      if (!done) bump(room);
    }
    if (room.holder != null && !room.flight && !room.autoAt) {
      const lvl = brainFor(room, room.holder);
      if (lvl && !PassPlay.isLocal(room)) {
        if (!room.botAt) { const [a, b] = REACT[lvl] || REACT.normal; room.botAt = now + rnd(a, b); }
        else if (now >= room.botAt) botThrow(room, room.holder, lvl);
      }
    }
  } else if (room.phaseLeft != null && room.phaseEndsAt != null && now >= room.phaseEndsAt) endPhase(room);
}

/* What the app is told 10 times a second: how hot (never the fuse itself), and, in the last seconds, the digits. */
const snapOf = (room) => {
  const left = room.fuseLeftMs;
  const live = room.phase === "play";
  return {
    t: Date.now(), ph: room.phase, hd: room.holder == null ? -1 : room.holder,
    h: live ? Math.max(0, Math.min(1, 1 - left / HEAT_MS)) : 0,
    ...(live && left <= FUSE_SHOW_MS ? { z: Math.max(0, Math.round(left)) } : {}),
  };
};

let lastLoop = Date.now(), snapAcc = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(250, now - lastLoop);
  lastLoop = now;
  snapAcc += dt;
  for (const room of rooms.values()) {
    if (room.status !== "playing") continue;
    stepRoom(room, dt);
    if (room.status !== "playing") continue;
    if (snapAcc >= SNAP_MS) sendSnap(room);
    // a holder that has gone quiet is played by a bot (it is given back the moment the human throws)
    for (let s = 0; s < room.players.length; s++) {
      const p = room.players[s];
      if (!p.bot && !p.botControlled && !p.local && !PassPlay.isLocal(room) && room.phase === "play" && room.holder === s && !room.flight && now - (room.heldAt || now) > (p.connected ? AFK_MS : Math.min(AFK_MS, 1500))) {
        p.botControlled = true; room.log = `A bot is playing for ${p.name}.`; bump(room);
      }
    }
  }
  if (snapAcc >= SNAP_MS) snapAcc = 0;
}, 25);

function sendSnap(room) {
  const sockets = roomSockets.get(room.code);
  if (!sockets) return;
  const snap = snapOf(room);
  for (const s of sockets) s.emit("snap", snap);
}

function addBotTo(room, level) {
  if (room.players.length >= MAX_PLAYERS) return null;
  level = LEVELS.includes(level) ? level : "normal";
  const used = room.players.map((q) => q.name);
  const names = BOT_NAMES[level];
  const name = names.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, level, left: false, connected: true };
  room.players.push(p);
  return p;
}

/* ---------- sockets ---------- */

function attach(socket, code, playerId) {
  const was = socket.data.roomCode;
  /* (a pass-and-play room's own phone seating one of its local people: the same socket, still in the room) */
  if (was && (was !== code || socket.data.playerId !== playerId) && !(was === code && PassPlay.isLocal(rooms.get(code)))) dropFromRoom(socket);
  socket.data.playerId = playerId;
  socket.data.roomCode = code;
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
}
function detach(socket) {
  const code = socket.data.roomCode;
  const set = roomSockets.get(code);
  if (set) { set.delete(socket); if (!set.size) roomSockets.delete(code); }
  socket.data.roomCode = null;
}
function heldElsewhere(room, id) {
  const set = roomSockets.get(room.code);
  if (set) for (const s of set) if (s.data.playerId === id) return true;
  return false;
}
function dropFromRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  const p = room ? room.players.find((q) => q.id === socket.data.playerId) : null;
  detach(socket);
  if (!room || !p || heldElsewhere(room, p.id)) return;
  p.connected = false;
  bump(room);
}

function forgetRoom(room) { rooms.delete(room.code); }

PassPlay.init({ app, base: BASE, rooms, broadcast: sendState, max: MAX_PLAYERS, drop: (c) => { const r = rooms.get(c); if (r) forgetRoom(r); } });
Quick.init({ game: 'potato', model: 'openskill', seats: 4, codeKey: 'roomCode', app, io, rooms, base: BASE, broadcast: sendState, rated: () => false });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);
  PassPlay.hook(socket);   // before Quick.hook: the seats a phone plays
  Quick.hook(socket); Quick.connection(socket); PassPlay.connection(socket);
  const currentRoom = () => rooms.get(socket.data.roomCode);
  Voice.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId, bump, emit: (ev, d) => socket.emit(ev, d) });   // voice chat in private rooms (2026-11-18)
  Reactions.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId,
    isHost: (r) => r.host === socket.data.playerId, bump });
  const me = () => { const r = currentRoom(); return r ? r.players.find((p) => p.id === socket.data.playerId) : null; };

  socket.on("create", (payload) => {
    const { name: rawName, playerId, avatar, caps, plus, look, crew } = obj(payload);
    const name = cleanName(rawName);
    if (!name) return refuse(socket, "create", "name", "Pick a name first.");
    let code = genCode(); let guard = 0;
    while (rooms.has(code) && guard++ < 10) code = genCode();
    code = Plus.crewCode({ plus, crew }, rooms, () => code);
    const id = cleanId(playerId) || newId();
    const room = newRoom(code, id);
    room.players.push({ id, name, avatar: cleanAvatar(avatar) || AVATARS[0], left: false, connected: true, caps: cleanCaps(caps) });
    rooms.set(code, room);
    attach(socket, code, id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: id });
    bump(room);
  });

  socket.on("join", (payload) => {
    const { code: rawCode, name, playerId, avatar, caps, plus, look } = obj(payload);
    const code = text(rawCode).trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return refuse(socket, "join", "not_found", "No room with that code.");
    const known = cleanId(playerId);
    let p = known ? room.players.find((q) => q.id === known) : null;
    if (p) {
      p.connected = true; p.left = false; p.lastIn = Date.now();
      p.caps = cleanCaps(caps);
      const n = cleanName(name);
      if (n) p.name = n;
    } else {
      if (room.status !== "lobby") return refuse(socket, "join", "started", "That match already started.");
      if (room.players.length >= MAX_PLAYERS) return refuse(socket, "join", "full", `Room is full (${MAX_PLAYERS}).`);
      const n = cleanName(name);
      if (!n) return refuse(socket, "join", "name", "Pick a name first.");
      const id = known || newId();
      p = { id, name: n, avatar: cleanAvatar(avatar) || AVATARS[room.players.length % AVATARS.length], left: false, connected: true, caps: cleanCaps(caps) };
      room.players.push(p);
      room.log = `${n} joined.`;
    }
    attach(socket, code, p.id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: p.id });
    bump(room);
  });

  /* The host's choices, in the lobby or between rounds: { lives: 1|3, look: "slime"|"workshop"|"disco" }. */
  socket.on("settings", (payload) => {
    const { lives, look } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    let changed = false;
    if (LIVES.includes(lives) && lives !== room.opts.lives) { room.opts.lives = lives; changed = true; }
    /* The Wind-Up Workshop and the Disco Gift are GameNest Plus's: a host who owns Plus picks them, anyone else keeps the Slime Lab. */
    const hostP = room.players.find((q) => q.id === room.host);
    if (LOOKS.includes(look) && look !== room.opts.look && (look === "slime" || (hostP && hostP.plus))) { room.opts.look = look; changed = true; }
    if (changed) { room.log = room.opts.lives > 1 ? "Three lives each." : "One pop and you are out."; bump(room); }
  });

  socket.on("addBot", (payload) => {
    const { level } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    if (room.players.length >= MAX_PLAYERS) return refuse(socket, "addBot", "full", "Room is full.");
    const b = addBotTo(room, level);
    if (!b) return;
    room.log = `${b.name} (${b.level} bot) joined.`;
    bump(room);
  });

  socket.on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].bot) { room.log = `${room.players[i].name} left.`; room.players.splice(i, 1); break; }
    }
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < MIN_PLAYERS) return refuse(socket, "start", "nobody", "Nobody to play with.");
    startMatch(room);
    bump(room);
  });

  /* A throw: { to } the seat the bomb goes to (the holder's own tap). In a pass-and-play room { as } is the holder's seat and `to` may be left out: the bomb goes on to the
     next player in the table's direction (the phone is the potato; the holder taps Pass and hands it on). */
  socket.on("throw", (payload) => {
    const { to } = obj(payload);
    const room = currentRoom(), self = me();
    if (!room || !self || room.status !== "playing" || room.phase !== "play") return;
    const seat = room.players.indexOf(self);
    if (seat < 0 || seat !== room.holder || room.flight) return;
    let target = Number.isInteger(to) ? to : null;
    if (target == null && PassPlay.isLocal(room)) target = nextSeat(room, seat, room.dir, 0);
    if (target == null) return;
    if (throwBomb(room, seat, target, false)) {
      if (self.botControlled) { self.botControlled = false; room.log = `${self.name} is back.`; }
      self.lastIn = Date.now();
    }
  });

  /* Clock sync for the app: { c } back with the server's time. */
  socket.on("ping", (payload) => { const { c } = obj(payload); socket.emit("pong", { c: Number.isFinite(c) ? c : 0, s: Date.now() }); });

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((q) => !q.left);
    if (room.players.length < MIN_PLAYERS) return refuse(socket, "rematch", "nobody", "Nobody to play with.");
    if (!room.players.some((q) => q.id === room.host)) room.host = room.players.find((q) => !q.bot).id;
    startMatch(room);
    room.log = `Rematch! ${room.log}`;
    bump(room);
  });

  socket.on("takeSeat", () => {
    const room = currentRoom(), p = me();
    if (room && p && p.botControlled) { p.botControlled = false; p.lastIn = Date.now(); room.heldAt = Date.now(); room.log = `${p.name} is back.`; bump(room); }
  });

  function handleLeave() {
    const room = currentRoom(), p = me();
    detach(socket);
    if (!room || !p) return;
    room.log = `${p.name} left.`;
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q !== p);
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot); if (h) room.host = h.id; }
    } else {
      p.left = true; p.connected = false;
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot && !q.left && !q.local); if (h) room.host = h.id; }
      if (room.status === "playing") {
        const seat = room.players.indexOf(p);
        if (!p.out) { p.out = true; room.elim.push(seat); }
        const left = alive(room);
        const humans = left.filter((s) => !room.players[s].bot);
        if (left.length <= 1 || humans.length === 0) {
          finishMatch(room, left.length ? left[0] : null, left.length ? `${room.players[left[0]].name} wins!` : "Everyone left.");
        } else if (room.holder === seat) { serveBomb(room, pick(left)); room.log = `${p.name} left. The bomb goes to ${room.players[room.holder].name}.`; }
        else if (room.flight && room.flight.to === seat) { /* lands back with the thrower (land() handles it) */ }
      }
    }
    if (room.players.every((q) => q.left || q.bot || q.local)) { forgetRoom(room); return; }
    bump(room);
  }

  socket.on("pushToken", (payload) => {
    const { token } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token;
  });

  socket.on("presence", (payload) => {
    const { away } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) p.away = !!away;
  });

  socket.on("chat", (payload) => {
    let { text, sticker } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_COOLDOWN_MS) return;

    let msg = null;
    if (sticker) {
      if (!STICKERS.includes(sticker)) return;
      msg = { k: "s", s: sticker };
    } else {
      text = cleanChat(text);
      if (!text) return;
      msg = { k: "t", x: text };
    }
    socket.data.lastChat = now;
    const finish = () => {
      const room = rooms.get(code), p = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!p) return;
      msg.n = p.name; msg.c = p.color; msg.a = p.avatar; msg.t = now;
      room.chat.push(msg);
      // a sticker is not worth waking someone for; words are
      if (msg.k === "t") {
        for (const q of room.players) {
          if (q !== p) pushTo(q, p.name + ": " + msg.x, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
        }
      }
      if (room.chat.length > CHAT_KEEP) room.chat.shift();
      room.touched = Date.now();
      bump(room);
    };
    const code = room.code, pid = p.id;
    if (msg.k === "t") Moderation.chat(msg.x).then((shown) => { msg.x = shown; finish(); }); else finish();
  });

  /* Voice is peer to peer; the server only carries the handshake, never audio.
     The 20k ceiling is what stops a signal being used as a data channel. */
  socket.on("voice", (payload) => {
    const { kind, to, data } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;

    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat);
      else room.voice.delete(seat);
      room.touched = Date.now();
      bump(room);
      return;
    }

    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0;
      try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const sockets = roomSockets.get(room.code);
      if (!sockets) return;
      for (const s of sockets) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  /* Tests only (TEST_HOOKS=1): put the match where a test needs it. { puck: [x, y, vx, vy], score: [a, b], clockMs, golden, phase }. */
  if (TEST_HOOKS) socket.on("testSet", (payload) => {
    const o = obj(payload);
    const room = currentRoom();
    if (!room || !me()) return;
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    const w = room.world;
    if (Array.isArray(o.puck) && o.puck.length === 4 && o.puck.every(num)) { w.puck.x = o.puck[0]; w.puck.y = o.puck[1]; w.puck.vx = o.puck[2]; w.puck.vy = o.puck[3]; for (const m of w.mallets) { m.x = m.tx = 10; } }   /* (test only: the hands out of the puck's way) */
    if (Array.isArray(o.score) && o.score.length === 2 && o.score.every((s) => Number.isInteger(s) && s >= 0)) room.score = o.score.slice();
    if (num(o.clockMs)) room.timeLeftMs = o.clockMs;
    if (typeof o.golden === "boolean") room.golden = o.golden;
    if (o.phase === "play" && room.status === "playing") setPhase(room, "play", null);
    if (Array.isArray(o.botControlled)) o.botControlled.slice(0, 2).forEach((b, i) => { if (room.players[i] && !room.players[i].bot) room.players[i].botControlled = !!b; });
    bump(room);
  });

  /* Tests only (TEST_HOOKS=1): { fuseMs, holder, lives: [..] }. */
  if (TEST_HOOKS) socket.on("testSet", (payload) => {
    const o = obj(payload);
    const room = currentRoom();
    if (!room || !me()) return;
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    if (num(o.fuseMs)) room.fuseLeftMs = o.fuseMs;
    if (Number.isInteger(o.holder) && room.players[o.holder] && room.phase === "play" && !room.flight) { room.holder = o.holder; room.heldAt = Date.now(); room.botAt = null; }
    if (Array.isArray(o.lives)) o.lives.forEach((l, i) => { if (room.players[i] && Number.isInteger(l) && l > 0) room.players[i].lives = l; });
    if (o.pickup && room.players[o.pickup.seat]) room.pickup = { seat: o.pickup.seat, kind: o.pickup.kind === "skip" ? "skip" : "reverse" };
    if (o.phase === "play" && room.status === "playing") { setPhase(room, "play", null); }
    bump(room);
  });

  socket.on("leave", handleLeave);
  socket.on("disconnect", () => dropFromRoom(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) forgetRoom(room);
  }
}, 60000).unref();

server.listen(PORT, () => console.log(`Hot Potato Rooms running on port ${PORT}${BASE ? " under " + BASE : ""}`));

module.exports = { app, server, io };

