// CS Zeus Arena — authoritative multiplayer server
// Handles: static client hosting + WebSocket game logic (lobbies, teams, hp, kills, respawns)

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 20;
const ZEUS_RANGE = 2.6;      // meters, melee/zeus contact range
const ZEUS_COOLDOWN = 1100;  // ms between attacks per player
const RESPAWN_DELAY = 3000;  // ms
const FFA_CAP = 8;
const TEAM_MODE_SIZES = { '1v1': 1, '2v2': 2, '3v3': 3, '4v4': 4 };
const KILLS_TO_WIN = { '1v1': 8, '2v2': 12, '3v3': 16, '4v4': 20 };

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/three/build', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));
app.use('/vendor/three/examples/jsm', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let nextId = 1;
const rooms = new Map();          // roomCode -> room
const waitingPools = {            // mode -> array of sockets waiting for quick match
  '1v1': [], '2v2': [], '3v3': [], '4v4': []
};
let ffaRoom = null;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? makeCode() : c;
}

function newPlayer(ws, name) {
  return {
    id: nextId++,
    ws,
    name: (name || 'Player').toString().slice(0, 16),
    team: null,
    hp: 100,
    alive: true,
    kills: 0,
    deaths: 0,
    x: 0, y: 0, z: 0, rotY: 0, pitch: 0,
    lastAttack: 0,
    connected: true
  };
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function createRoom(mode, isPrivate) {
  const room = {
    code: makeCode(),
    mode,
    private: isPrivate,
    players: new Map(),
    state: 'waiting', // waiting | live | ended
    killsToWin: KILLS_TO_WIN[mode] || 999,
    createdAt: Date.now(),
    teamSizes: TEAM_MODE_SIZES[mode] ? TEAM_MODE_SIZES[mode] : null,
    scores: { A: 0, B: 0 },
    nextTeam: 'A'
  };
  rooms.set(room.code, room);
  return room;
}

function capacityFor(mode) {
  if (mode === 'ffa') return FFA_CAP;
  return (TEAM_MODE_SIZES[mode] || 1) * 2;
}

function assignTeam(room, player) {
  if (room.mode === 'ffa') { player.team = null; return; }
  player.team = room.nextTeam;
  room.nextTeam = room.nextTeam === 'A' ? 'B' : 'A';
}

function roomPlayerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, team: p.team, hp: p.hp, alive: p.alive,
    kills: p.kills, deaths: p.deaths
  }));
}

function zoneFor(room, player) {
  // two rough spawn areas on the map, in raw .obj coordinate space (client converts)
  const A = { sx: -2200, sy: -800, radius: 450 };
  const B = { sx: 1600, sy: 3400, radius: 450 };
  if (room.mode === 'ffa') return Math.random() < 0.5 ? A : B;
  return player.team === 'A' ? A : B;
}

function startRoomIfReady(room) {
  if (room.state !== 'waiting') return;
  const need = capacityFor(room.mode);
  if (room.mode !== 'ffa' && room.players.size < need) return;
  if (room.mode === 'ffa' && room.players.size < 2) return;
  room.state = 'live';
  for (const p of room.players.values()) {
    send(p.ws, { t: 'start', zone: zoneFor(room, p), players: roomPlayerList(room) });
  }
  broadcast(room, { t: 'roomInfo', mode: room.mode, code: room.code, players: roomPlayerList(room) });
}

function removeFromRoom(room, player) {
  room.players.delete(player.id);
  broadcast(room, { t: 'leave', id: player.id });
  if (room.players.size === 0) {
    rooms.delete(room.code);
    if (ffaRoom === room) ffaRoom = null;
  }
}

function handleJoin(ws, data) {
  const mode = data.mode;
  const name = data.name;
  let room;

  if (data.roomCode) {
    room = rooms.get(data.roomCode.toUpperCase());
    if (!room) { send(ws, { t: 'error', msg: 'Кімнату не знайдено' }); return; }
    if (room.players.size >= capacityFor(room.mode)) { send(ws, { t: 'error', msg: 'Кімната заповнена' }); return; }
  } else if (mode === 'ffa') {
    if (!ffaRoom || ffaRoom.players.size >= FFA_CAP) ffaRoom = createRoom('ffa', false);
    room = ffaRoom;
  } else if (data.createPrivate) {
    room = createRoom(mode, true);
  } else {
    const pool = waitingPools[mode];
    if (!pool) { send(ws, { t: 'error', msg: 'Невідомий режим' }); return; }
    room = pool.find(r => r.players.size < capacityFor(mode) && r.state === 'waiting');
    if (!room) { room = createRoom(mode, false); pool.push(room); }
  }

  const player = newPlayer(ws, name);
  ws.playerId = player.id;
  ws.roomCode = room.code;
  assignTeam(room, player);
  room.players.set(player.id, player);

  send(ws, {
    t: 'welcome', id: player.id, roomCode: room.code, mode: room.mode,
    team: player.team, capacity: capacityFor(room.mode), waiting: room.state === 'waiting'
  });
  broadcast(room, { t: 'roomInfo', mode: room.mode, code: room.code, players: roomPlayerList(room) });

  if (room.mode === 'ffa') {
    // FFA is a persistent arena: spawn as soon as 2+ are present
    startRoomIfReady(room);
    if (room.state === 'live') {
      send(ws, { t: 'start', zone: zoneFor(room, player), players: roomPlayerList(room) });
    }
  } else {
    startRoomIfReady(room);
  }
}

function handleInput(ws, data) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = room.players.get(ws.playerId);
  if (!p || !p.alive) return;
  // trust client position (hobby/LAN-friends scale project); clamp to sane bounds
  if (typeof data.x === 'number') p.x = Math.max(-6000, Math.min(6000, data.x));
  if (typeof data.y === 'number') p.y = Math.max(-2000, Math.min(4000, data.y));
  if (typeof data.z === 'number') p.z = Math.max(-6000, Math.min(6000, data.z));
  if (typeof data.rotY === 'number') p.rotY = data.rotY;
  if (typeof data.pitch === 'number') p.pitch = data.pitch;
}

function handleAttack(ws, data) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const attacker = room.players.get(ws.playerId);
  if (!attacker || !attacker.alive) return;
  const now = Date.now();
  if (now - attacker.lastAttack < ZEUS_COOLDOWN) return;

  const target = room.players.get(data.targetId);
  if (!target || !target.alive || target.id === attacker.id) return;
  if (room.mode !== 'ffa' && target.team === attacker.team) return;

  const dx = target.x - attacker.x, dy = target.y - attacker.y, dz = target.z - attacker.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > ZEUS_RANGE + 1.0) return; // small server-side leniency over network lag

  attacker.lastAttack = now;
  target.hp = 0;
  target.alive = false;
  target.deaths++;
  attacker.kills++;

  broadcast(room, { t: 'killfeed', killer: attacker.name, victim: target.name, weapon: 'zeus' });
  send(target.ws, { t: 'death', by: attacker.name, respawnIn: RESPAWN_DELAY });

  if (room.mode !== 'ffa') {
    room.scores[attacker.team] = (room.scores[attacker.team] || 0) + 1;
    broadcast(room, { t: 'score', scores: room.scores });
    if (room.scores[attacker.team] >= room.killsToWin) {
      room.state = 'ended';
      broadcast(room, { t: 'end', winner: attacker.team, scores: room.scores });
      return;
    }
  }

  setTimeout(() => {
    if (!rooms.has(room.code) || room.state === 'ended') return;
    if (!room.players.has(target.id)) return;
    target.hp = 100;
    target.alive = true;
    send(target.ws, { t: 'respawn', zone: zoneFor(room, target) });
  }, RESPAWN_DELAY);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    switch (data.t) {
      case 'join': handleJoin(ws, data); break;
      case 'input': handleInput(ws, data); break;
      case 'attack': handleAttack(ws, data); break;
      default: break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = room.players.get(ws.playerId);
    if (p) removeFromRoom(room, p);
  });
});

// Broadcast loop: snapshot all live rooms
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    const snapshot = [...room.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, hp: p.hp, alive: p.alive,
      x: p.x, y: p.y, z: p.z, rotY: p.rotY, pitch: p.pitch,
      kills: p.kills, deaths: p.deaths
    }));
    broadcast(room, { t: 'state', players: snapshot, time: Date.now() });
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`CS Zeus Arena server running on http://localhost:${PORT}`);
});
