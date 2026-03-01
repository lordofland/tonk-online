// server/server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;

// Serve your client files (index.html, app.js, styles.css, assets/)
app.use(express.static(path.join(__dirname, '..')));

server.on('upgrade', (req, socket, head) => {
  try {
    const url = req && typeof req.url === 'string' ? req.url : '';
    if (!url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch (e) {
    try {
      socket.destroy();
    } catch (_) {}
    console.log('WS upgrade failed:', e && e.message ? e.message : e);
  }
});

const SEAT_NAMES = ['Billy', 'Butch', 'Curt', 'Andy', 'Mark'];
const ROOM_ID = 'main';
const DISCONNECT_RELEASE_MS = 12_000;

function nowMs() {
  return Date.now();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function send(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(clients, fn) {
  for (const c of clients.values()) fn(c);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function makeDeck() {
  const deck = [];
  let id = 1;
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: `C${id++}`, rank: r, suit: s });
    }
  }
  shuffleInPlace(deck);
  return deck;
}

function initialRoomState() {
  return {
    id: ROOM_ID,
    createdAt: nowMs(),
    clients: new Map(),
    seats: SEAT_NAMES.map((name) => ({
      name,
      claimedBy: null,
      mode: 'sittingOut', // 'human' | 'cpu' | 'sittingOut'
      folded: false,
      pendingJoin: false,
      lastSeenAt: 0,
      releaseTimer: null,
    })),
    game: {
      handId: 0,
      handOver: true,
      dealing: false,
      dealerIndex: 0,
      currentPlayer: 0,
      phase: 'mustDraw',
      deck: [],
      discard: [],
      players: SEAT_NAMES.map((name) => ({ name, hand: [], melds: [] })),
      scores: Array.from({ length: SEAT_NAMES.length }, () => 0),
      turnTiming: {
        turnStartServerTs: null,
        perPlayer: Array.from({ length: SEAT_NAMES.length }, () => ({ totalMs: 0, turns: 0, lastTurnMs: 0 })),
        group: { totalMs: 0, turns: 0 },
      },
    },
  };
}

const room = initialRoomState();

function seatIndexByName(name) {
  return SEAT_NAMES.indexOf(name);
}

function isHandActive() {
  return !room.game.handOver && !room.game.dealing;
}

function ensureScoresSized() {
  const n = SEAT_NAMES.length;
  if (!Array.isArray(room.game.scores)) room.game.scores = [];
  if (room.game.scores.length !== n) {
    room.game.scores = Array.from({ length: n }, (_, i) => (Number.isFinite(room.game.scores[i]) ? room.game.scores[i] : 0));
  }
}

function applyPendingJoinsIfAllowed() {
  if (!room.game.handOver) return;
  for (const seat of room.seats) {
    if (seat.pendingJoin) {
      seat.pendingJoin = false;
    }
  }
}

function activeInHandSeat(i) {
  const seat = room.seats[i];
  if (!seat) return false;
  if (seat.folded) return false;
  return seat.mode !== 'sittingOut' && !seat.pendingJoin;
}

function participatingCount() {
  let n = 0;
  for (let i = 0; i < room.seats.length; i++) if (activeInHandSeat(i)) n++;
  return n;
}

function nextParticipatingIndex(idx) {
  const n = room.seats.length;
  for (let step = 1; step <= n; step++) {
    const j = (idx + step) % n;
    if (activeInHandSeat(j)) return j;
  }
  return idx;
}

function endTurnTimer(playerIdx) {
  const tt = room.game.turnTiming;
  if (tt.turnStartServerTs == null) return;
  const ms = Math.max(0, nowMs() - tt.turnStartServerTs);
  const rec = tt.perPlayer[playerIdx];
  if (rec) {
    rec.totalMs += ms;
    rec.turns += 1;
    rec.lastTurnMs = ms;
  }
  tt.group.totalMs += ms;
  tt.group.turns += 1;
  tt.turnStartServerTs = null;
}

function startTurnTimer(playerIdx) {
  room.game.turnTiming.turnStartServerTs = nowMs();
}

function resetHandState() {
  room.game.deck = makeDeck();
  room.game.discard = [];
  room.game.phase = 'mustDraw';
  room.game.dealing = false;
  room.game.handOver = false;
  room.game.players = SEAT_NAMES.map((name) => ({ name, hand: [], melds: [] }));
  for (const seat of room.seats) seat.folded = false;
  room.game.turnTiming.turnStartServerTs = null;
  room.game.turnTiming.perPlayer = Array.from({ length: SEAT_NAMES.length }, () => ({ totalMs: 0, turns: 0, lastTurnMs: 0 }));
  room.game.turnTiming.group = { totalMs: 0, turns: 0 };
  ensureScoresSized();
}

function dealNewHand() {
  resetHandState();
  applyPendingJoinsIfAllowed();
  if (participatingCount() < 2) {
    room.game.handOver = true;
    return;
  }

  const firstToDeal = nextParticipatingIndex(room.game.dealerIndex);
  const order = [];
  let idx = firstToDeal;
  for (let i = 0; i < room.seats.length; i++) {
    if (activeInHandSeat(idx)) order.push(idx);
    idx = (idx + 1) % room.seats.length;
  }

  for (let r = 0; r < 5; r++) {
    for (const seatIdx of order) {
      const c = room.game.deck.pop();
      if (c) room.game.players[seatIdx].hand.push(c);
    }
  }

  const firstDiscard = room.game.deck.pop();
  if (firstDiscard) room.game.discard.push(firstDiscard);

  room.game.currentPlayer = firstToDeal;
  room.game.phase = 'mustDraw';
  startTurnTimer(room.game.currentPlayer);
}

function settleFoldEndIfNeeded() {
  if (!isHandActive()) return;
  if (participatingCount() === 0) {
    room.game.handOver = true;
    room.game.phase = 'mustDraw';
    room.game.dealerIndex = (room.game.dealerIndex + 1) % room.seats.length;
    room.game.turnTiming.turnStartServerTs = null;
    applyPendingJoinsIfAllowed();
  }
}

function redactStateForSeat(seatIdx) {
  const g = room.game;
  return {
    roomId: room.id,
    serverTs: nowMs(),
    seats: room.seats.map((s) => ({
      name: s.name,
      claimed: !!s.claimedBy,
      mode: s.mode,
      folded: s.folded,
      pendingJoin: s.pendingJoin,
    })),
    game: {
      handId: g.handId,
      handOver: g.handOver,
      dealing: g.dealing,
      dealerIndex: g.dealerIndex,
      currentPlayer: g.currentPlayer,
      phase: g.phase,
      deckCount: g.deck.length,
      discardTop: g.discard.length ? g.discard[g.discard.length - 1] : null,
      discardCount: g.discard.length,
      scores: g.scores,
      turnTiming: g.turnTiming,
      players: g.players.map((p, i) => ({
        name: p.name,
        hand: i === seatIdx ? p.hand : null,
        handCount: p.hand.length,
        melds: p.melds,
      })),
    },
  };
}

function broadcastState() {
  broadcast(room.clients, (c) => {
    send(c.ws, { type: 'STATE', payload: redactStateForSeat(c.seatIdx) });
  });
}

function seatClaimable(seatIdx, clientId) {
  const seat = room.seats[seatIdx];
  if (!seat) return { ok: false, reason: 'bad_seat' };
  if (seat.claimedBy && seat.claimedBy !== clientId) return { ok: false, reason: 'taken' };
  return { ok: true };
}

function claimSeat(seatIdx, client) {
  const seat = room.seats[seatIdx];
  if (!seat) return { ok: false, reason: 'bad_seat' };
  if (seat.releaseTimer) {
    clearTimeout(seat.releaseTimer);
    seat.releaseTimer = null;
  }

  if (seat.claimedBy && seat.claimedBy !== client.id) return { ok: false, reason: 'taken' };
  seat.claimedBy = client.id;
  seat.lastSeenAt = nowMs();
  client.seatIdx = seatIdx;

  // If hand is active, join is pending.
  seat.pendingJoin = isHandActive();
  if (!seat.pendingJoin && seat.mode === 'sittingOut') seat.mode = 'human';
  return { ok: true };
}

function releaseSeat(seatIdx, clientId) {
  const seat = room.seats[seatIdx];
  if (!seat) return;
  if (seat.claimedBy !== clientId) return;
  seat.claimedBy = null;
  seat.pendingJoin = false;
  // Keep mode as-is (so you can set CPU seats even when not claimed).
}

function validateActorTurn(client) {
  if (room.game.handOver) return { ok: false, reason: 'hand_over' };
  if (!Number.isInteger(client.seatIdx)) return { ok: false, reason: 'no_seat' };
  const i = client.seatIdx;
  if (room.game.currentPlayer !== i) return { ok: false, reason: 'not_your_turn' };
  if (!activeInHandSeat(i)) return { ok: false, reason: 'not_active' };
  return { ok: true };
}

function handleAction(client, msg) {
  const { action, payload } = msg;
  if (action === 'RESET_ROOM') {
    const fresh = initialRoomState();
    room.game = fresh.game;
    for (const seat of room.seats) {
      seat.folded = false;
      seat.pendingJoin = false;
    }
    room.game.handOver = true;
    broadcastState();
    return;
  }
  if (action === 'NEW_HAND') {
    // Anyone may request; server starts only if handOver.
    if (!room.game.handOver) return send(client.ws, { type: 'ERROR', error: 'hand_in_progress' });
    dealNewHand();
    broadcastState();
    return;
  }

  if (action === 'FOLD') {
    if (!Number.isInteger(client.seatIdx)) return send(client.ws, { type: 'ERROR', error: 'no_seat' });
    const seat = room.seats[client.seatIdx];
    if (!seat || seat.folded) return;
    seat.folded = true;
    if (room.game.currentPlayer === client.seatIdx) {
      endTurnTimer(client.seatIdx);
      room.game.currentPlayer = nextParticipatingIndex(room.game.currentPlayer);
      startTurnTimer(room.game.currentPlayer);
    }
    settleFoldEndIfNeeded();
    broadcastState();
    return;
  }

  const v = validateActorTurn(client);
  if (!v.ok) return send(client.ws, { type: 'ERROR', error: v.reason });

  const p = room.game.players[client.seatIdx];
  if (!p) return send(client.ws, { type: 'ERROR', error: 'bad_player' });

  if (action === 'DRAW_DECK') {
    if (room.game.phase !== 'mustDraw') return send(client.ws, { type: 'ERROR', error: 'bad_phase' });
    const c = room.game.deck.pop();
    if (!c) return send(client.ws, { type: 'ERROR', error: 'deck_empty' });
    p.hand.push(c);
    room.game.phase = 'mustDiscard';
    broadcastState();
    return;
  }

  if (action === 'DRAW_DISCARD') {
    if (room.game.phase !== 'mustDraw') return send(client.ws, { type: 'ERROR', error: 'bad_phase' });
    const c = room.game.discard.pop();
    if (!c) return send(client.ws, { type: 'ERROR', error: 'discard_empty' });
    p.hand.push(c);
    room.game.phase = 'mustDiscard';
    broadcastState();
    return;
  }

  if (action === 'DISCARD') {
    if (room.game.phase !== 'mustDiscard') return send(client.ws, { type: 'ERROR', error: 'bad_phase' });
    const cardId = payload && payload.cardId;
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return send(client.ws, { type: 'ERROR', error: 'card_not_in_hand' });
    const [removed] = p.hand.splice(idx, 1);
    room.game.discard.push(removed);
    room.game.phase = 'mustDraw';
    endTurnTimer(client.seatIdx);
    room.game.currentPlayer = nextParticipatingIndex(room.game.currentPlayer);
    startTurnTimer(room.game.currentPlayer);
    broadcastState();
    return;
  }

  return send(client.ws, { type: 'ERROR', error: 'unknown_action' });
}

wss.on('connection', (ws) => {
  const id = `c_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  const client = { id, ws, seatIdx: null };
  room.clients.set(id, client);

  send(ws, { type: 'WELCOME', payload: { clientId: id, roomId: room.id, seatNames: SEAT_NAMES } });
  broadcastState();

  ws.on('message', (buf) => {
    const msg = safeJsonParse(String(buf));
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'HELLO') {
      send(ws, { type: 'HELLO_ACK', payload: { clientId: id, roomId: room.id } });
      broadcastState();
      return;
    }
    if (msg.type === 'CLAIM_SEAT') {
      const name = msg.payload && msg.payload.name;
      const seatIdx = seatIndexByName(name);
      const can = seatClaimable(seatIdx, id);
      if (!can.ok) {
        send(ws, { type: 'CLAIM_DENIED', error: can.reason });
        return;
      }
      const res = claimSeat(seatIdx, client);
      if (!res.ok) {
        send(ws, { type: 'CLAIM_DENIED', error: res.reason });
        return;
      }
      send(ws, { type: 'CLAIM_OK', payload: { seatIdx, name: SEAT_NAMES[seatIdx] } });
      broadcastState();
      return;
    }
    if (msg.type === 'SET_MODE') {
      const name = msg.payload && msg.payload.name;
      const mode = msg.payload && msg.payload.mode;
      const seatIdx = seatIndexByName(name);
      const seat = room.seats[seatIdx];
      if (!seat) return;
      if (!['human', 'cpu', 'sittingOut'].includes(mode)) return;
      // Allow changing mode only if seat unclaimed or claimed by requester.
      if (seat.claimedBy && seat.claimedBy !== id) return;
      seat.mode = mode;
      if (mode === 'sittingOut') seat.folded = false;
      broadcastState();
      return;
    }
    if (msg.type === 'ACTION') {
      handleAction(client, msg);
      return;
    }
  });

  ws.on('close', () => {
    room.clients.delete(id);
    if (Number.isInteger(client.seatIdx)) {
      const seat = room.seats[client.seatIdx];
      if (seat && seat.claimedBy === id) {
        seat.lastSeenAt = nowMs();
        seat.releaseTimer = setTimeout(() => {
          releaseSeat(client.seatIdx, id);
          broadcastState();
        }, DISCONNECT_RELEASE_MS);
      }
    }
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});