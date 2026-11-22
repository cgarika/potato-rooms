# Hot Potato Rooms (self-hosted)

The room server for **Hot Potato** (slug `potato`, dev port 3128, path `/potato`): a bomb with a hidden fuse goes round the table, three to eight players.
Express and Socket.IO, rooms behind a 6-letter code (letters only), quick play (`quickmatch.js`, unrated), bots Easy / Normal / Hard, the cartoon
reactions, chat, voice signalling, push, Plus, pass-and-play. No ads, no gear.

## How it plays

The holder sends `throw {to: seat}`; the bomb flies 0.42 s (nobody holds it in the air) and lands. The fuse is the server's alone, random 8 to 25 s, never
sent: `snap` carries only how hot the bomb is (`h`, 0 to 1 over its last 6 s) and, in the last 5 s, the milliseconds left (`z`). When it pops the holder loses
a life (`opts.lives` 1 or 3; the last life is out); a new bomb is served to a player still in. Last one in wins; `players[i].place` is 1 for the winner, then by
how long each lasted. Twists (online rooms only): after a throw a pickup may appear on a seat (`room.pickup {seat, kind: reverse|skip}`); the bomb landing there is
handed on by itself 0.65 s later (reverse: straight back to the thrower; skip: past the next player). A holder that does nothing for 8 s is played by a bot until
they throw again.

## The wire

Client to server: `create`, `join`, `settings {lives: 1|3, look: slime|workshop|disco}` (the last two need a Plus host), `addBot {level}`, `removeBot`,
`create {local: true}` + `addLocal {name}` (pass-and-play: the PHONE is the potato; `throw {as: holderSeat}` with no `to` passes to the next player in order),
`start`, `throw {to}`, `ping {c}` (answered `pong {c, s}`), `rematch`, `takeSeat`, `leave`, `chat`, `voice`, `react`, `quick` / `quickCancel`, `pushToken`, `presence`;
with `TEST_HOOKS=1` also `testSet {fuseMs, holder, lives, pickup, phase}`.

Server to client: `state {room, mySeat}` on every change (`room.phase`: lobby, countdown 3 s, play, pop 2.6 s, serve 1.3 s, over; `holder`, `dir`, `flight {from, to, t0, ms}`,
`pickup`, `twist`, `pop {seat, out, lives}`, `winner`, `opts`, `passplay {seats}`, `players[i] {lives, out, place, ...}`), and `snap {t, ph, hd, h, z?}` 10 a second while playing.

## Run it

```bash
PORT=3128 node server.js            # the desk
BASE_PATH=/potato PORT=3000 node server.js   # behind the reverse proxy
npm test
```

Env: `COUNTDOWN_MS`, `SERVE_MS`, `POP_MS`, `FLIGHT_MS`, `TWIST_MS`, `FUSE_MIN_MS`, `FUSE_MAX_MS`, `AFK_MS`, `TEST_HOOKS`.
