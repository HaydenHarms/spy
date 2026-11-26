// Lobby API for The Dossier. Cloudflare Pages Function backed by D1 (binding: DB).
// Clients poll GET /api/state. Roles are only ever returned to the player they belong to.

const LOCATIONS = [
  { name: "Airplane", roles: ["Pilot","Co-Pilot","Flight Attendant","Air Marshal","First Class Passenger","Economy Passenger","Mechanic","Child Traveling Alone"] },
  { name: "Bank", roles: ["Teller","Bank Manager","Security Guard","Robber","Loan Officer","Customer","Armored Car Driver","Auditor"] },
  { name: "Beach", roles: ["Lifeguard","Surfer","Ice Cream Vendor","Sunbather","Photographer","Volleyball Player","Fisherman","Tourist"] },
  { name: "Casino", roles: ["Card Dealer","Bouncer","High Roller","Cocktail Waitress","Pit Boss","Card Counter","Slot Regular","Security Operator"] },
  { name: "Circus", roles: ["Ringmaster","Clown","Trapeze Artist","Lion Tamer","Ticket Seller","Fortune Teller","Strongman","Concession Vendor"] },
  { name: "Corporate Office", roles: ["CEO","Intern","IT Support","HR Manager","Accountant","Receptionist","Janitor","Salesperson"] },
  { name: "Cruise Ship", roles: ["Captain","Bartender","Cruise Director","Passenger","Chef","Deckhand","Onboard Magician","Ship Doctor"] },
  { name: "Hospital", roles: ["Surgeon","Nurse","Patient","Anesthesiologist","Receptionist","Paramedic","Visitor","Janitor"] },
  { name: "Hotel", roles: ["Concierge","Bellhop","Housekeeper","Guest","Manager","Chef","Doorman","Valet"] },
  { name: "Movie Studio", roles: ["Director","Lead Actor","Stunt Double","Camera Operator","Screenwriter","Makeup Artist","Producer","Background Extra"] },
  { name: "Pirate Ship", roles: ["Captain","First Mate","Cabin Boy","Cook","Navigator","Lookout","Prisoner","Gunner"] },
  { name: "School", roles: ["Principal","Teacher","Student","Janitor","Librarian","Coach","Lunch Lady","Substitute Teacher"] }
];

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const LOBBY_TTL_MS = 12 * 60 * 60 * 1000;
const STALE_MS = 90 * 1000; // players not polling for this long are dropped while in the lobby phase

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
const fail = (message, status = 400) => json({ error: message }, status);

function randInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
  return s;
}
function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
function cleanName(raw) {
  const n = String(raw ?? "").replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 16);
  return n;
}
function cleanCode(raw) {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

async function getLobby(db, code) {
  return db.prepare("SELECT * FROM lobbies WHERE code = ?").bind(code).first();
}
async function getPlayers(db, code) {
  const r = await db.prepare("SELECT * FROM players WHERE code = ? ORDER BY joined_at, id").bind(code).all();
  return r.results;
}

// Drop long-idle lobbies, and idle players while a lobby is still waiting to start.
async function housekeeping(db, now) {
  const cutoff = now - LOBBY_TTL_MS;
  await db.prepare("DELETE FROM players WHERE code IN (SELECT code FROM lobbies WHERE updated_at < ?)").bind(cutoff).run();
  await db.prepare("DELETE FROM lobbies WHERE updated_at < ?").bind(cutoff).run();
}
async function pruneStale(db, lobby, now) {
  if (lobby.phase !== "lobby") return;
  await db.prepare("DELETE FROM players WHERE code = ? AND last_seen < ?").bind(lobby.code, now - STALE_MS).run();
  const players = await getPlayers(db, lobby.code);
  if (players.length === 0) {
    await db.prepare("DELETE FROM lobbies WHERE code = ?").bind(lobby.code).run();
    return;
  }
  if (!players.some(p => p.id === lobby.host_id)) {
    await db.prepare("UPDATE lobbies SET host_id = ?, updated_at = ? WHERE code = ?").bind(players[0].id, now, lobby.code).run();
  }
}

async function uniqueName(db, code, wanted) {
  const players = await getPlayers(db, code);
  const taken = new Set(players.map(p => p.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; i < 100; i++) {
    const cand = `${wanted.slice(0, 13)} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${wanted.slice(0, 10)} ${randInt(900) + 100}`;
}

async function requirePlayer(db, code, pid) {
  const lobby = await getLobby(db, code);
  if (!lobby) return { err: fail("Lobby not found. Check the code.", 404) };
  const me = await db.prepare("SELECT * FROM players WHERE id = ? AND code = ?").bind(pid, code).first();
  if (!me) return { err: fail("You are no longer in this lobby.", 403) };
  return { lobby, me };
}

async function assignRound(db, lobby, now) {
  const players = await getPlayers(db, lobby.code);
  if (players.length < MIN_PLAYERS) return fail(`Need at least ${MIN_PLAYERS} players.`);
  const loc = LOCATIONS[randInt(LOCATIONS.length)];
  const spy = players[randInt(players.length)];
  const roles = shuffle(loc.roles);
  let cursor = 0;
  const stmts = [];
  for (const p of players) {
    const role = p.id === spy.id ? null : roles[cursor++ % roles.length];
    stmts.push(db.prepare("UPDATE players SET role = ? WHERE id = ?").bind(role, p.id));
  }
  stmts.push(
    db.prepare("UPDATE lobbies SET phase = 'playing', location = ?, spy_id = ?, round = round + 1, updated_at = ? WHERE code = ?")
      .bind(loc.name, spy.id, now, lobby.code)
  );
  await db.batch(stmts);
  return null;
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return fail("Database not configured.", 500);
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const now = Date.now();

  try {
    if (route === "create" && request.method === "POST") {
      const body = await readBody(request);
      const name = cleanName(body.name);
      if (!name) return fail("Enter a name.");
      await housekeeping(db, now);
      let code = null;
      for (let i = 0; i < 20; i++) {
        const c = newCode();
        if (!(await getLobby(db, c))) { code = c; break; }
      }
      if (!code) return fail("Could not create a lobby. Try again.", 503);
      const pid = newId();
      await db.batch([
        db.prepare("INSERT INTO lobbies (code, host_id, phase, round, created_at, updated_at) VALUES (?, ?, 'lobby', 0, ?, ?)").bind(code, pid, now, now),
        db.prepare("INSERT INTO players (id, code, name, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)").bind(pid, code, name, now, now)
      ]);
      return json({ code, playerId: pid });
    }

    if (route === "join" && request.method === "POST") {
      const body = await readBody(request);
      const code = cleanCode(body.code);
      const name = cleanName(body.name);
      if (code.length !== 4) return fail("Enter the 4-letter code.");
      if (!name) return fail("Enter a name.");
      const lobby = await getLobby(db, code);
      if (!lobby) return fail("No lobby with that code.", 404);
      await pruneStale(db, lobby, now);
      const fresh = await getLobby(db, code);
      if (!fresh) return fail("No lobby with that code.", 404);
      if (fresh.phase !== "lobby") return fail("That game has already started.", 409);
      const players = await getPlayers(db, code);
      if (players.length >= MAX_PLAYERS) return fail("That lobby is full.", 409);
      const finalName = await uniqueName(db, code, name);
      const pid = newId();
      await db.prepare("INSERT INTO players (id, code, name, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)").bind(pid, code, finalName, now, now).run();
      await db.prepare("UPDATE lobbies SET updated_at = ? WHERE code = ?").bind(now, code).run();
      return json({ code, playerId: pid, name: finalName });
    }

    if (route === "state" && request.method === "GET") {
      const code = cleanCode(url.searchParams.get("code"));
      const pid = String(url.searchParams.get("pid") || "");
      const first = await getLobby(db, code);
      if (!first) return fail("Lobby not found. Check the code.", 404);
      await db.prepare("UPDATE players SET last_seen = ? WHERE id = ? AND code = ?").bind(now, pid, code).run();
      await pruneStale(db, first, now);
      const { lobby, me, err } = await requirePlayer(db, code, pid);
      if (err) return err;
      const players = await getPlayers(db, code);
      const out = {
        code,
        phase: lobby.phase,
        round: lobby.round,
        isHost: lobby.host_id === pid,
        minPlayers: MIN_PLAYERS,
        players: players.map(p => ({ id: p.id, name: p.name, isHost: p.id === lobby.host_id, you: p.id === pid })),
        me: null,
        reveal: null
      };
      if (lobby.phase !== "lobby") {
        out.me = lobby.spy_id === pid
          ? { spy: true }
          : { spy: false, location: lobby.location, role: me.role };
      }
      if (lobby.phase === "revealed") {
        const spy = players.find(p => p.id === lobby.spy_id);
        out.reveal = { location: lobby.location, spyName: spy ? spy.name : "Unknown" };
      }
      return json(out);
    }

    if (route === "start" || route === "reveal" || route === "lobby") {
      if (request.method !== "POST") return fail("Method not allowed.", 405);
      const body = await readBody(request);
      const code = cleanCode(body.code);
      const { lobby, err } = await requirePlayer(db, code, String(body.playerId || ""));
      if (err) return err;
      if (lobby.host_id !== body.playerId) return fail("Only the host can do that.", 403);

      if (route === "start") {
        const e = await assignRound(db, lobby, now);
        if (e) return e;
        return json({ ok: true });
      }
      if (route === "reveal") {
        if (lobby.phase !== "playing") return fail("Nothing to reveal yet.", 409);
        await db.prepare("UPDATE lobbies SET phase = 'revealed', updated_at = ? WHERE code = ?").bind(now, code).run();
        return json({ ok: true });
      }
      // back to the waiting room
      await db.batch([
        db.prepare("UPDATE lobbies SET phase = 'lobby', location = NULL, spy_id = NULL, updated_at = ? WHERE code = ?").bind(now, code),
        db.prepare("UPDATE players SET role = NULL, last_seen = ? WHERE code = ?").bind(now, code)
      ]);
      return json({ ok: true });
    }

    if (route === "leave" && request.method === "POST") {
      const body = await readBody(request);
      const code = cleanCode(body.code);
      const pid = String(body.playerId || "");
      const lobby = await getLobby(db, code);
      if (!lobby) return json({ ok: true });
      await db.prepare("DELETE FROM players WHERE id = ? AND code = ?").bind(pid, code).run();
      const players = await getPlayers(db, code);
      if (players.length === 0) {
        await db.prepare("DELETE FROM lobbies WHERE code = ?").bind(code).run();
      } else {
        // A round in progress can't continue once someone drops out, so send everyone back to the waiting room.
        const abort = lobby.phase !== "lobby";
        const newHost = lobby.host_id === pid ? players[0].id : lobby.host_id;
        const stmts = [db.prepare("UPDATE lobbies SET host_id = ?, phase = 'lobby', location = NULL, spy_id = NULL, updated_at = ? WHERE code = ?").bind(newHost, now, code)];
        if (abort) stmts.push(db.prepare("UPDATE players SET role = NULL, last_seen = ? WHERE code = ?").bind(now, code));
        await db.batch(stmts);
      }
      return json({ ok: true });
    }

    return fail("Not found.", 404);
  } catch (e) {
    return fail("Server error.", 500);
  }
}
