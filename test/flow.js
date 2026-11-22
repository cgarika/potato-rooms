/* The room flow over real sockets, against a server this script starts (TEST_PORT, default 5731; never 3111-3126):
   create and join, lobby settings, bots, start, the phases (countdown, play, pop, serve, over), a throw (arc, landing, refusals), the hidden fuse (never sent: only the heat
   and the last digits), a pop (a life, then out), pickups (reverse, skip), last one in wins, forfeit on leave, rematch, pass-and-play (the phone is the potato). */
"use strict";
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const PORT = Number(process.env.TEST_PORT || 5731);
if (PORT >= 3111 && PORT <= 3126) { console.error("refusing " + PORT); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (fn, what, ms = 10000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timed out waiting for " + what)); setTimeout(tick, 5); }; tick(); });
function client(name) {
  const s = io("http://127.0.0.1:" + PORT, { path: "/socket.io", transports: ["websocket"] });
  const c = { s, room: null, mySeat: -1, snaps: [], errs: [], joined: null, name };
  s.on("state", (d) => { c.room = d.room; c.mySeat = d.mySeat; });
  s.on("snap", (x) => { c.snaps.push(x); if (c.snaps.length > 300) c.snaps.shift(); });
  s.on("err", (m, o) => c.errs.push(o && o.code));
  s.on("joined", (j) => { c.joined = j; });
  c.create = (extra) => { s.emit("create", { name, playerId: "p_" + name, ...(extra || {}) }); return wait(() => c.joined, "joined"); };
  c.join = (code) => { s.emit("join", { code, name, playerId: "p_" + name }); return wait(() => c.joined, "joined"); };
  c.last = () => c.snaps[c.snaps.length - 1];
  return c;
}
let n = 0;
const ok = (m) => { n++; console.log("ok  " + m); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "potato-flow-"));
  const env = { ...process.env, PORT: String(PORT), TEST_HOOKS: "1", RANK_DIR: data, STATS_DIR: data, DATA_DIR: data, COUNTDOWN_MS: "200", SERVE_MS: "150", POP_MS: "250", FLIGHT_MS: "120", TWIST_MS: "150", AFK_MS: "900" };
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "ignore" });
  const clients = [];
  const mk = (n_) => { const c = client(n_); clients.push(c); return c; };
  try {
    await sleep(700);
    // lobby: a room, settings, bots
    const a = mk("Ann");
    await a.create();
    assert(/^[A-HJKMNPRTWXYZ]{6}$/.test(a.joined.code)); ok("a room is made with a letters-only code");
    a.s.emit("settings", { lives: 3, look: "disco" });
    await wait(() => a.room && a.room.opts.lives === 3, "lives");
    assert.strictEqual(a.room.opts.look, "slime"); ok("a Plus look is refused to a host without Plus");
    a.s.emit("settings", { lives: 9, look: "nope" });
    await sleep(100); assert.strictEqual(a.room.opts.lives, 3); ok("settings outside the lists are ignored");
    a.s.emit("start", {});
    await sleep(150); assert.strictEqual(a.room.status, "lobby"); assert(a.errs.includes("nobody")); ok("it will not start with fewer than three");
    for (let i = 0; i < 7; i++) a.s.emit("addBot", { level: i === 0 ? "easy" : "normal" });
    await wait(() => a.room.players.length === 8, "eight seats");
    a.s.emit("addBot", { level: "hard" }); await sleep(100);
    assert.strictEqual(a.room.players.length, 8); assert(a.errs.includes("full")); ok("eight seats, then full");
    assert.strictEqual(new Set(a.room.players.map((p) => p.name)).size, 8); ok("every bot has its own name");
    for (let i = 0; i < 5; i++) a.s.emit("removeBot");
    await wait(() => a.room.players.length === 3, "three seats");

    // a round: phases, no fuse on the wire
    a.s.emit("settings", { lives: 1 });
    await wait(() => a.room.opts.lives === 1, "one life");
    a.s.emit("start", {});
    await wait(() => a.room.phase === "countdown", "countdown");
    await wait(() => a.room.phase === "play", "play");
    ok("start: countdown then play");
    assert(JSON.stringify(a.room).indexOf("fuse") < 0); ok("the fuse is never in the state");
    const t0 = Date.now(), c0 = a.snaps.length;
    await sleep(1000);
    const rate = (a.snaps.length - c0) / ((Date.now() - t0) / 1000);
    assert(rate > 7 && rate < 13, "snap rate " + rate); ok("about 10 snapshots a second (" + rate.toFixed(1) + ")");
    assert(a.last().h === 0 && a.last().z === undefined, "cold early"); ok("a cold bomb says nothing: heat 0, no digits");
    // only the holder throws; a bot holder throws by itself
    const holder = a.room.holder;
    if (holder !== 0) {
      a.s.emit("throw", { to: 1 }); await sleep(100); assert.notStrictEqual(a.room.flight && a.room.flight.from, 0);
      ok("someone else's throw is ignored");
    }
    a.s.emit("testSet", { holder: 0, fuseMs: 60000 });
    await wait(() => a.room.holder === 0, "Ann holds");
    a.s.emit("throw", { to: 0 }); await sleep(80); assert.strictEqual(a.room.holder, 0); ok("a player cannot throw to themselves");
    a.s.emit("throw", { to: 2 });
    await wait(() => a.room.flight && a.room.flight.to === 2, "in flight");
    assert.strictEqual(a.room.holder, -1); ok("a throw: the bomb is in the air, nobody holds it");
    await wait(() => a.room.holder === 2 && !a.room.flight, "landed");
    ok("it lands with the target");
    a.s.emit("testSet", { fuseMs: 4000 });
    await wait(() => a.last().z !== undefined && a.last().z <= 4000, "digits");
    assert(a.last().h > 0.3); ok("the last 5 s show digits and heat");
    a.s.emit("testSet", { fuseMs: 40 });
    await wait(() => a.room.phase === "pop", "pop");
    const popSeat = a.room.pop.seat;
    assert(a.room.pop.out && a.room.players[popSeat].out); ok("one life: the holder is out");
    await wait(() => a.room.phase === "serve" || a.room.phase === "play", "next bomb");
    assert(!a.room.players[a.room.holder].out); ok("the next bomb goes to a player still in");
    await wait(() => a.room.phase === "play", "play again");
    a.s.emit("testSet", { fuseMs: 40 });
    await wait(() => a.room.status === "over", "over", 15000);
    assert(a.room.winner >= 0 && !a.room.players[a.room.winner].out); assert.strictEqual(a.room.players[a.room.winner].place, 1);
    ok("last one in wins, place 1");
    assert.deepStrictEqual(a.room.players.map((p) => p.place).sort(), [1, 2, 3]); ok("places 1 2 3");

    a.s.emit("rematch");
    await wait(() => a.room.status === "playing", "rematch");
    assert(a.room.players.every((p) => p.lives === 1 && !p.out)); ok("rematch starts fresh");
    a.s.emit("leave"); await sleep(100);

    // three lives, pickups, humans
    const h = mk("Hal"), i2 = mk("Ida"), j = mk("Jon");
    await h.create();
    await i2.join(h.joined.code); await j.join(h.joined.code);
    await wait(() => h.room.players.length === 3, "three humans");
    h.s.emit("settings", { lives: 3 });
    await wait(() => h.room.opts.lives === 3, "3 lives");
    j.s.emit("start"); await sleep(100); assert.strictEqual(h.room.status, "lobby"); ok("only the host starts");
    h.s.emit("start");
    await wait(() => h.room.phase === "play", "play", 6000);
    h.s.emit("testSet", { holder: 0, fuseMs: 60000, pickup: { seat: 1, kind: "reverse" } });
    await wait(() => h.room.holder === 0 && h.room.pickup, "pickup placed");
    h.s.emit("throw", { to: 1 });
    await wait(() => h.room.twist && h.room.twist.kind === "reverse", "reverse");
    await wait(() => h.room.holder === 0 || (h.room.flight && h.room.flight.to === 0), "straight back", 4000);
    ok("reverse: it goes straight back to the thrower");
    await wait(() => h.room.holder === 0 && !h.room.flight, "landed back");
    h.s.emit("testSet", { pickup: { seat: 1, kind: "skip" } });
    h.s.emit("throw", { to: 1 });
    await wait(() => h.room.twist && h.room.twist.kind === "skip", "skip", 4000);
    await wait(() => h.room.holder === 2 || (h.room.flight && h.room.flight.to === 2), "skip hands on", 4000);
    ok("skip: the receiver hands it on to the next player");
    h.s.emit("testSet", { fuseMs: 30 });
    await wait(() => h.room.phase === "pop", "pop 3 lives");
    assert(!h.room.pop.out && h.room.pop.lives === 2); ok("three lives: a pop costs one");
    await wait(() => h.room.phase === "serve" || h.room.phase === "play", "next");
    j.s.emit("leave");
    await wait(() => h.room.players[2].left, "left");
    ok("a player who leaves is out of the round");
    h.s.emit("leave"); i2.s.emit("leave");

    // pass-and-play: the phone is the potato
    const p = mk("Pam");
    await p.create({ local: true });
    await wait(() => p.room && p.room.passplay, "local room");
    for (const nm of ["Quin", "Rae"]) p.s.emit("addLocal", { name: nm });
    await wait(() => p.room.players.length === 3, "three locals");
    p.s.emit("start");
    await wait(() => p.room.phase === "play", "local play", 6000);
    const hd = p.room.holder;
    p.s.emit("testSet", { fuseMs: 60000 });
    p.s.emit("throw", { as: hd });
    await wait(() => p.room.flight, "pass flight");
    assert.strictEqual(p.room.flight.to, (hd + 1) % 3); ok("pass-and-play: Pass hands it to the next player in order");
    await wait(() => p.room.holder === (hd + 1) % 3 && !p.room.flight, "landed");
    p.s.emit("throw", { as: (hd + 2) % 3 }); await sleep(100);
    assert.strictEqual(p.room.holder, (hd + 1) % 3); ok("only the holder's seat can pass");
    await sleep(1200);
    assert.strictEqual(p.room.holder, (hd + 1) % 3); ok("no bot ever takes a pass-and-play seat");
    assert.strictEqual(p.room.pickup, null); ok("no pickups in pass-and-play");
    // a fuse that runs out with the bomb in the air pops it in its new holder's hands
    p.s.emit("testSet", { holder: 0, fuseMs: 60000 });
    await wait(() => p.room.holder === 0, "Pam holds");
    p.s.emit("throw", { as: 0, to: 2 });
    p.s.emit("testSet", { fuseMs: 5 });
    await wait(() => p.room.phase === "pop", "pop");
    assert.strictEqual(p.room.pop.seat, 2); ok("a bomb in the air pops on landing, on the one it lands with");

    console.log(`\n${n} checks passed`);
  } catch (e) {
    console.error("FAIL:", (e && e.stack) || e);
    process.exitCode = 1;
  } finally {
    for (const c of clients) c.s.close();
    srv.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
