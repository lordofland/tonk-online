
(() => {
  'use strict';

  const CONFIG = {
    handSize: 5,
    knockThreshold: 7,
    cpuThinkMs: 900,
    cpuActionDelayMinMs: 700,
    cpuActionDelayMaxMs: 1200,
    animationMs: 420,
    logMaxLines: 14,
    dealCardDelayMs: 90,
    initialDealCardDelayMs: 9,
    dragThresholdPx: 6,
  };

  const gameOptions = {
    noKnock: false,
    basicStake: 1,
  };

  const SUITS = ['S', 'H', 'D', 'C'];
  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const RANK_LABEL = {
    1: 'A',
    11: 'J',
    12: 'Q',
    13: 'K',
  };

  function rankLabel(rank) {
    return RANK_LABEL[rank] || String(rank);
  }

  function beginHumanHandReorder(ev) {
    try {
      if (NET.connected) return;
      if (STATE.handOver) return;
      if (STATE.busy) return;
      if (!STATE.players[0]?.playing) return;
      const target = ev.currentTarget;
      if (!target || !target.classList.contains('handCard')) return;
      const uid = target.dataset.uid || target.dataset.cardId;
      if (!uid) return;

      const human = STATE.players[0];
      const fromIndex = human.hand.findIndex((c) => c.id === uid);
      if (fromIndex < 0) return;

      console.log(`[DEV] drag down uid=${uid}`);

      STATE.drag.pointerId = ev.pointerId;
      STATE.drag.cardId = uid;
      STATE.drag.startX = ev.clientX;
      STATE.drag.startY = ev.clientY;
      const rect = target.getBoundingClientRect();
      STATE.drag.offsetX = ev.clientX - rect.left;
      STATE.drag.offsetY = ev.clientY - rect.top;
      STATE.drag.fromIndex = fromIndex;
      STATE.drag.active = true;
      STATE.drag.dragging = false;
      STATE.drag.placeholderIndex = fromIndex;
      STATE.drag.suppressClick = false;
      STATE.drag.sourceEl = target;
      STATE.drag.sourceRect = rect;

      // Capture on stable container to ensure we keep receiving move/up even if the card node is removed.
      UI.humanHand.setPointerCapture(ev.pointerId);
    } catch (e) {
      handleError(e);
    }
  }

  function discardHumanCardByUid(uid) {
    try {
      if (NET.connected) return;
      if (!uid) return;
      if (STATE.handOver) return;
      if (STATE.busy) return;
      if (!STATE.players[0]?.playing) return;

      if (STATE.currentPlayer !== 0) {
        logLine('Not your turn.');
        return;
      }

      if (STATE.phase !== 'mustDiscard') {
        logLine('Draw first.');
        return;
      }

      const human = STATE.players[0];
      const found = human?.hand?.some((c) => c.id === uid);
      if (!found) return;

      console.log('DISCARD', uid);
      const fromEl = UI.humanHand.querySelector(`.handCard[data-uid="${uid}"]`);
      humanDiscardById(uid, fromEl || UI.humanHand);
    } catch (e) {
      handleError(e);
    }
  }

  function cardValue(rank) {
    if (rank === 1) return 1;
    if (rank >= 11) return 10;
    return rank;
  }

  function cardText(card) {
    return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
  }

  function isRedSuit(suit) {
    return suit === 'H' || suit === 'D';
  }

  function safeNow() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function cloneCard(card) {
    return { id: card.id, rank: card.rank, suit: card.suit };
  }

  function sortedByRankThenSuit(cards) {
    return [...cards].sort((a, b) => (a.rank - b.rank) || a.suit.localeCompare(b.suit));
  }

  function computeAllMeldMasks(cards) {
    const n = cards.length;
    const meldMasks = [];

    function addConsecutiveRunsFromSorted(idxs, mappedRankOfIndex) {
      for (let start = 0; start < idxs.length; start++) {
        let run = [idxs[start]];
        for (let j = start + 1; j < idxs.length; j++) {
          const prev = mappedRankOfIndex(idxs[j - 1]);
          const cur = mappedRankOfIndex(idxs[j]);
          if (cur === prev) continue;
          if (cur === prev + 1) {
            run.push(idxs[j]);
            if (run.length >= 3) {
              let mask = 0;
              for (const k of run) mask |= 1 << k;
              meldMasks.push(mask);
            }
          } else {
            run = [idxs[j]];
          }
        }
      }
    }

    const byRank = new Map();
    for (let i = 0; i < n; i++) {
      const r = cards[i].rank;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(i);
    }

    for (const idxs of byRank.values()) {
      if (idxs.length >= 3) {
        const k = idxs.length;
        const total = 1 << k;
        for (let m = 0; m < total; m++) {
          if (popcount(m) < 3) continue;
          let mask = 0;
          for (let bit = 0; bit < k; bit++) {
            if (m & (1 << bit)) mask |= (1 << idxs[bit]);
          }
          meldMasks.push(mask);
        }
      }
    }

    const bySuit = new Map();
    for (let i = 0; i < n; i++) {
      const s = cards[i].suit;
      if (!bySuit.has(s)) bySuit.set(s, []);
      bySuit.get(s).push(i);
    }

    for (const idxs of bySuit.values()) {
      // Ace-low runs
      idxs.sort((ia, ib) => cards[ia].rank - cards[ib].rank);
      addConsecutiveRunsFromSorted(idxs, (i) => cards[i].rank);

      // Ace-high runs (treat A as 14)
      idxs.sort((ia, ib) => {
        const ra = cards[ia].rank === 1 ? 14 : cards[ia].rank;
        const rb = cards[ib].rank === 1 ? 14 : cards[ib].rank;
        return ra - rb;
      });
      addConsecutiveRunsFromSorted(idxs, (i) => (cards[i].rank === 1 ? 14 : cards[i].rank));
    }

    return uniqueInts(meldMasks);
  }

  function uniqueInts(arr) {
    const s = new Set(arr);
    return Array.from(s);
  }

  function popcount(x) {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  }

  function bestDeadwood(cards) {
    const n = cards.length;
    if (n === 0) return { deadwood: 0, meldMasks: [] };
    if (n > 10) {
      const sum = cards.reduce((acc, c) => acc + cardValue(c.rank), 0);
      return { deadwood: sum, meldMasks: [] };
    }

    const meldMasks = computeAllMeldMasks(cards);
    const memo = new Map();

    const fullMask = (1 << n) - 1;
    function solve(remainingMask) {
      if (remainingMask === 0) return { deadwood: 0, meldMasks: [] };
      if (memo.has(remainingMask)) return memo.get(remainingMask);

      let best = {
        deadwood: deadwoodSumFromMask(remainingMask),
        meldMasks: [],
      };

      for (const mm of meldMasks) {
        if ((mm & remainingMask) !== mm) continue;
        const nextMask = remainingMask & ~mm;
        const sub = solve(nextMask);
        if (sub.deadwood < best.deadwood) {
          best = { deadwood: sub.deadwood, meldMasks: [mm, ...sub.meldMasks] };
          if (best.deadwood === 0) break;
        }
      }

      memo.set(remainingMask, best);
      return best;
    }

    function deadwoodSumFromMask(mask) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) sum += cardValue(cards[i].rank);
      }
      return sum;
    }

    return solve(fullMask);
  }

  function isValidSet(cards) {
    if (cards.length < 3) return false;
    const r = cards[0].rank;
    return cards.every((c) => c.rank === r);
  }

  function consecutiveRanks(mappedRanks) {
    const ranks = [...new Set(mappedRanks)].sort((a, b) => a - b);
    if (ranks.length !== mappedRanks.length) return false;
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] !== ranks[i - 1] + 1) return false;
    }
    return true;
  }

  function maybeRunLocalAiTurn() {
    try {
      if (!NET.connected) return;
      const seat = mySeatInfo();
      if (!seat || seat.mode !== 'cpu') return;
      if (!canLocalUserActNow()) return;
      if (STATE.handOver || STATE.dealing || STATE.busy) return;

      if (STATE.phase === 'mustDraw') {
        setTimeout(() => {
          if (!NET.connected) return;
          if (!canLocalUserActNow()) return;
          if (STATE.phase !== 'mustDraw') return;
          multiplayerSendAction('DRAW_DECK');
        }, 650);
        return;
      }

      if (STATE.phase === 'mustDiscard') {
        const mi = mySeatIdx();
        const p = mi != null ? STATE.players[mi] : null;
        const hand = p && Array.isArray(p.hand) ? p.hand : [];
        if (!hand.length) return;
        const pick = hand[Math.floor(Math.random() * hand.length)];
        if (!pick || !pick.id) return;
        setTimeout(() => {
          if (!NET.connected) return;
          if (!canLocalUserActNow()) return;
          if (STATE.phase !== 'mustDiscard') return;
          multiplayerSendAction('DISCARD', { cardId: pick.id });
        }, 650);
      }
    } catch (e) {
      handleError(e);
    }
  }

  function isValidRunAceAware(cards) {
    if (cards.length < 3) return { ok: false, aceHigh: false };
    const s = cards[0].suit;
    if (!cards.every((c) => c.suit === s)) return { ok: false, aceHigh: false };

    const baseRanks = cards.map((c) => c.rank);
    const hasAce = baseRanks.includes(1);

    const okAceLow = consecutiveRanks(baseRanks);
    if (okAceLow) return { ok: true, aceHigh: false };

    if (!hasAce) return { ok: false, aceHigh: false };
    const aceHighRanks = baseRanks.map((r) => (r === 1 ? 14 : r));
    const okAceHigh = consecutiveRanks(aceHighRanks);
    if (okAceHigh) return { ok: true, aceHigh: true };
    return { ok: false, aceHigh: false };
  }

  function isValidRun(cards) {
    return isValidRunAceAware(cards).ok;
  }

  function sortRunMeldCards(meld) {
    if (!meld || meld.type !== 'run' || !Array.isArray(meld.cards)) return;
    const aceHigh = !!meld.aceHigh;
    meld.cards.sort((a, b) => {
      const ra = aceHigh && a.rank === 1 ? 14 : a.rank;
      const rb = aceHigh && b.rank === 1 ? 14 : b.rank;
      return (ra - rb) || a.suit.localeCompare(b.suit);
    });
  }

  function validateMeld(cards) {
    const sorted = sortedByRankThenSuit(cards);
    if (isValidSet(sorted)) return { ok: true, type: 'set' };
    const runRes = isValidRunAceAware(sorted);
    if (runRes.ok) return { ok: true, type: 'run', aceHigh: runRes.aceHigh };
    return { ok: false, type: null };
  }

  function canHitMeld(card, meld) {
    if (!card || !meld || !Array.isArray(meld.cards) || meld.cards.length < 3) return { ok: false };
    if (meld.type === 'set') {
      const rank = meld.cards[0]?.rank;
      if (rank == null || card.rank !== rank) return { ok: false };
      const suitTaken = new Set(meld.cards.map((c) => c.suit));
      if (suitTaken.has(card.suit)) return { ok: false };
      if (meld.cards.length >= 4) return { ok: false };
      return { ok: true, aceHigh: false };
    }

    if (meld.type === 'run') {
      const suit = meld.cards[0]?.suit;
      if (!suit || card.suit !== suit) return { ok: false };
      const nextCards = [...meld.cards.map(cloneCard), cloneCard(card)];
      const res = isValidRunAceAware(sortedByRankThenSuit(nextCards));
      if (!res.ok) return { ok: false };
      return { ok: true, aceHigh: !!res.aceHigh };
    }

    return { ok: false };
  }

  function applyHitToFirstLegalMeld(card) {
    try {
      if (!card) return { ok: false };
      for (let pi = 0; pi < STATE.players.length; pi++) {
        const p = STATE.players[pi];
        if (!p || !p.playing) continue;
        const melds = Array.isArray(p.melds) ? p.melds : [];
        for (let mi = 0; mi < melds.length; mi++) {
          const meld = melds[mi];
          const hit = canHitMeld(card, meld);
          if (!hit.ok) continue;

          meld.cards.push(cloneCard(card));
          if (meld.type === 'run') {
            meld.aceHigh = !!hit.aceHigh;
            sortRunMeldCards(meld);
          } else {
            meld.cards = sortedByRankThenSuit(meld.cards.map(cloneCard));
          }

          return { ok: true, playerIdx: pi, meldIdx: mi };
        }
      }
      return { ok: false };
    } catch (e) {
      handleError(e);
      return { ok: false };
    }
  }

  const UI = {
    table: document.getElementById('table'),
    turnIndicator: document.getElementById('turnIndicator'),
    statusLine: document.getElementById('statusLine'),
    log: document.getElementById('log'),

    whoAmI: document.getElementById('whoAmI'),

    scoreboard: document.getElementById('scoreboard'),

    fxLayer: document.getElementById('fxLayer'),

    humanName: document.getElementById('humanName'),
    cpu1Name: document.getElementById('cpu1Name'),
    cpu2Name: document.getElementById('cpu2Name'),
    cpu3Name: document.getElementById('cpu3Name'),
    cpu4Name: document.getElementById('cpu4Name'),

    drawPileCount: document.getElementById('drawPileCount'),
    discardPileCount: document.getElementById('discardPileCount'),
    discardPileCard: document.getElementById('discardPileCard'),
    drawPile: document.getElementById('drawPile'),
    discardPile: document.getElementById('discardPile'),
    drawPileCard: document.getElementById('drawPileCard'),

    humanHand: document.getElementById('humanHand'),
    humanMeta: document.getElementById('humanMeta'),
    humanMetaText: document.getElementById('humanMetaText'),
    humanTurnTime: document.getElementById('humanTurnTime'),
    humanMelds: document.getElementById('humanMelds'),

    seatHuman: document.getElementById('human'),
    seatCpu1: document.getElementById('cpu1'),
    seatCpu2: document.getElementById('cpu2'),
    seatCpu3: document.getElementById('cpu3'),
    seatCpu4: document.getElementById('cpu4'),

    cpu1Meta: document.getElementById('cpu1Meta'),
    cpu2Meta: document.getElementById('cpu2Meta'),
    cpu3Meta: document.getElementById('cpu3Meta'),
    cpu4Meta: document.getElementById('cpu4Meta'),

    cpu1MetaText: document.getElementById('cpu1MetaText'),
    cpu2MetaText: document.getElementById('cpu2MetaText'),
    cpu3MetaText: document.getElementById('cpu3MetaText'),
    cpu4MetaText: document.getElementById('cpu4MetaText'),

    cpu1TurnTime: document.getElementById('cpu1TurnTime'),
    cpu2TurnTime: document.getElementById('cpu2TurnTime'),
    cpu3TurnTime: document.getElementById('cpu3TurnTime'),
    cpu4TurnTime: document.getElementById('cpu4TurnTime'),

    turnStats: document.getElementById('turnStats'),

    cpu1Hand: document.getElementById('cpu1Hand'),
    cpu2Hand: document.getElementById('cpu2Hand'),
    cpu3Hand: document.getElementById('cpu3Hand'),
    cpu4Hand: document.getElementById('cpu4Hand'),

    cpu1Melds: document.getElementById('cpu1Melds'),
    cpu2Melds: document.getElementById('cpu2Melds'),
    cpu3Melds: document.getElementById('cpu3Melds'),
    cpu4Melds: document.getElementById('cpu4Melds'),
    btnCreateMeld: document.getElementById('btnCreateMeld'),
    btnKnock: document.getElementById('btnKnock'),
    btnNewHand: document.getElementById('btnNewHand'),
    btnToggleLog: document.getElementById('btnToggleLog'),
    btnSort: document.getElementById('btnSort'),

    btnFold0: document.getElementById('btnFold0'),
    btnFold1: document.getElementById('btnFold1'),
    btnFold2: document.getElementById('btnFold2'),
    btnFold3: document.getElementById('btnFold3'),
    btnFold4: document.getElementById('btnFold4'),

    seatModal: document.getElementById('seatModal'),
    seatModalHint: document.getElementById('seatModalHint'),
    seatChoiceAndy: document.getElementById('seatChoiceAndy'),
    seatChoiceBilly: document.getElementById('seatChoiceBilly'),
    seatChoiceButch: document.getElementById('seatChoiceButch'),
    seatChoiceCurt: document.getElementById('seatChoiceCurt'),
    seatChoiceMark: document.getElementById('seatChoiceMark'),

    optNoKnock: document.getElementById('optNoKnock'),
    optStake: document.getElementById('optStake'),

    optPlay0: document.getElementById('optPlay0'),
    optPlay1: document.getElementById('optPlay1'),
    optPlay2: document.getElementById('optPlay2'),
    optPlay3: document.getElementById('optPlay3'),
    optPlay4: document.getElementById('optPlay4'),
  };

  const NET = {
    enabled: true,
    ws: null,
    connected: false,
    clientId: null,
    seatNames: ['Billy', 'Butch', 'Curt', 'Andy', 'Mark'],
    mySeatName: null,
    mySeatIdx: null,
    lastServerState: null,
    reconnectTimer: null,
  };

  function mySeatIdx() {
    return NET.connected && Number.isInteger(NET.mySeatIdx) ? NET.mySeatIdx : null;
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function sendWs(obj) {
    if (!NET.ws || !NET.connected) return false;
    try {
      NET.ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {
      return false;
    }
  }

  function multiplayerSendAction(action, payload) {
    return sendWs({ type: 'ACTION', action, payload: payload || null });
  }

  function mySeatInfo() {
    if (!NET.connected) return null;
    if (!Number.isInteger(NET.mySeatIdx)) return null;
    const seats = NET.lastServerState && Array.isArray(NET.lastServerState.seats) ? NET.lastServerState.seats : null;
    const seat = seats ? seats[NET.mySeatIdx] : null;
    return seat || null;
  }

  function openSeatModal() {
    if (!UI.seatModal) return;
    UI.seatModal.classList.add('isOpen');
    UI.seatModal.setAttribute('aria-hidden', 'false');
  }

  function closeSeatModal() {
    if (!UI.seatModal) return;
    UI.seatModal.classList.remove('isOpen');
    UI.seatModal.setAttribute('aria-hidden', 'true');
  }

  function updateSeatModalButtonsFromServer() {
    if (!NET.lastServerState || !Array.isArray(NET.lastServerState.seats)) return;
    const seats = NET.lastServerState.seats;
    const btns = [UI.seatChoiceBilly, UI.seatChoiceButch, UI.seatChoiceCurt, UI.seatChoiceAndy, UI.seatChoiceMark];
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!b) continue;
      const seat = seats[i];
      const taken = !!(seat && seat.claimed);
      b.disabled = taken && NET.mySeatIdx !== i;
    }
  }

  function requestClaimSeat(name) {
    if (!name) return;
    sendWs({ type: 'CLAIM_SEAT', payload: { name } });
  }

  function ensureSeatHeaderControls(seatIdx) {
    const seatEl = seatElByPlayerIndex(seatIdx);
    if (!seatEl) return null;
    const header = seatEl.querySelector('.playerHeader');
    if (!header) return null;
    let wrap = header.querySelector(':scope > .headerControls');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'headerControls';
      header.insertBefore(wrap, header.firstChild);
    }
    return wrap;
  }

  function ensureLocalSeatControlsMounted() {
    if (!NET.connected) return;
    const mi = mySeatIdx();
    if (mi == null) return;
    const seat = mySeatInfo();
    if (!seat || seat.mode !== 'human') return;
    const wrap = ensureSeatHeaderControls(mi);
    if (!wrap) return;

    if (UI.btnCreateMeld && UI.btnCreateMeld.parentElement !== wrap) wrap.appendChild(UI.btnCreateMeld);
    if (UI.btnSort && UI.btnSort.parentElement !== wrap) wrap.appendChild(UI.btnSort);
    if (UI.btnKnock && UI.btnKnock.parentElement !== wrap) wrap.appendChild(UI.btnKnock);
  }

  function ensureLocalModeSelect() {
    if (!UI.whoAmI) return;
    if (!document.getElementById('whoAmIText')) {
      const t = document.createElement('span');
      t.id = 'whoAmIText';
      UI.whoAmI.appendChild(t);
    }
    if (document.getElementById('localModeSelect')) return;
    const select = document.createElement('select');
    select.id = 'localModeSelect';
    select.style.marginLeft = '10px';
    select.innerHTML = '<option value="sittingOut">Sit Out</option><option value="human">Play (Human)</option><option value="cpu">AI Plays</option>';
    select.addEventListener('change', () => {
      if (!NET.connected) return;
      if (!NET.mySeatName) return;
      const v = select.value;
      const mode = v === 'cpu' ? 'cpu' : v === 'human' ? 'human' : 'sittingOut';
      sendWs({ type: 'SET_MODE', payload: { name: NET.mySeatName, mode } });
    });
    UI.whoAmI.appendChild(select);
    UI.localModeSelect = select;
  }

  function seatStatusTextFromServer(seat) {
    if (!seat) return '';
    if (seat.mode === 'sittingOut') return 'Sitting Out';
    if (seat.pendingJoin) return 'Waiting (joins next hand)';
    if (seat.mode === 'cpu') return 'CPU';
    return 'Playing';
  }

  function updateModeControlsFromServer() {
    if (!NET.connected) return;
    if (!NET.lastServerState || !Array.isArray(NET.lastServerState.seats)) return;
    const checks = [UI.optPlay0, UI.optPlay1, UI.optPlay2, UI.optPlay3, UI.optPlay4];
    for (let i = 0; i < checks.length; i++) {
      const el = checks[i];
      if (!el) continue;
      const seat = NET.lastServerState.seats[i];
      const mode = seat && seat.mode;
      if (mode === 'sittingOut') {
        el.checked = false;
        el.indeterminate = false;
      } else if (mode === 'cpu') {
        el.checked = true;
        el.indeterminate = true;
      } else {
        el.checked = true;
        el.indeterminate = false;
      }
    }
  }

  function cycleMySeatModeAndSend() {
    if (!NET.connected) return;
    if (!Number.isInteger(NET.mySeatIdx)) return;
    if (!NET.mySeatName) return;

    const seat = NET.lastServerState && Array.isArray(NET.lastServerState.seats) ? NET.lastServerState.seats[NET.mySeatIdx] : null;
    const cur = seat && seat.mode ? seat.mode : 'human';
    const next = cur === 'human' ? 'cpu' : cur === 'cpu' ? 'sittingOut' : 'human';
    sendWs({ type: 'SET_MODE', payload: { name: NET.mySeatName, mode: next } });
  }

  function setNameLabel(el, name) {
    if (!el) return;
    // The name elements contain badges/toggles. Replace only the leading text node.
    const first = el.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) first.nodeValue = `${name} `;
  }

  function applyServerStateSnapshot(snapshot) {
    if (!snapshot || !snapshot.game || !Array.isArray(snapshot.game.players)) return;
    NET.lastServerState = snapshot;

    ensureLocalModeSelect();
    const whoText = document.getElementById('whoAmIText');
    if (whoText) whoText.textContent = NET.mySeatName ? `You are: ${NET.mySeatName}` : 'Not seated';

    // Server is authoritative; client is a renderer. Map snapshot into local STATE shape.
    if (!STATE.players.length) initPlayers();

    STATE.handOver = !!snapshot.game.handOver;
    STATE.dealing = !!snapshot.game.dealing;
    STATE.winnerIndex = Number.isInteger(snapshot.game.winnerIndex) ? snapshot.game.winnerIndex : null;
    STATE.currentPlayer = snapshot.game.currentPlayer;
    STATE.dealerIndex = snapshot.game.dealerIndex;
    STATE.phase = snapshot.game.phase;

    // We only need counts for deck/discard UI.
    STATE.deck = Array.from({ length: snapshot.game.deckCount || 0 }, () => ({ id: 'X', rank: 0, suit: 'S' }));
    STATE.discard = [];
    if (snapshot.game.discardTop) STATE.discard.push(snapshot.game.discardTop);

    if (Array.isArray(snapshot.game.scores)) STATE.scores = snapshot.game.scores.slice();

    for (let i = 0; i < STATE.players.length; i++) {
      const sp = snapshot.game.players[i];
      const lp = STATE.players[i];
      if (!lp || !sp) continue;
      lp.name = sp.name;
      lp.melds = Array.isArray(sp.melds) ? sp.melds : [];
      lp.playing = snapshot.seats && snapshot.seats[i] ? snapshot.seats[i].mode !== 'sittingOut' : lp.playing;

      lp.handCount = Number.isFinite(sp.handCount) ? sp.handCount : (Array.isArray(sp.hand) ? sp.hand.length : 0);
      if (i === NET.mySeatIdx && Array.isArray(sp.hand)) lp.hand = sp.hand;
      else lp.hand = [];
    }

    if (snapshot.game.turnTiming) {
      STATE.turnTiming.perPlayer = snapshot.game.turnTiming.perPlayer || STATE.turnTiming.perPlayer;
      STATE.turnTiming.group = snapshot.game.turnTiming.group || STATE.turnTiming.group;
      STATE.turnTiming.turnStartTs = null;
      STATE.turnTiming.currentPlayerAtStart = STATE.currentPlayer;
    }

    // Update visible name labels to match server.
    setNameLabel(UI.humanName, STATE.players[0]?.name || '');
    setNameLabel(UI.cpu1Name, STATE.players[1]?.name || '');
    setNameLabel(UI.cpu2Name, STATE.players[2]?.name || '');
    setNameLabel(UI.cpu3Name, STATE.players[3]?.name || '');
    setNameLabel(UI.cpu4Name, STATE.players[4]?.name || '');

    updateSeatModalButtonsFromServer();
    updateModeControlsFromServer();
    if (UI.localModeSelect && NET.connected && Number.isInteger(NET.mySeatIdx) && snapshot.seats && snapshot.seats[NET.mySeatIdx]) {
      const m = snapshot.seats[NET.mySeatIdx].mode;
      UI.localModeSelect.value = m === 'cpu' ? 'cpu' : m === 'human' ? 'human' : 'sittingOut';
    }
    render();
    maybeRunLocalAiTurn();
  }

  function connectMultiplayer() {
    if (!NET.enabled) return;
    if (NET.ws && (NET.ws.readyState === WebSocket.OPEN || NET.ws.readyState === WebSocket.CONNECTING)) return;

    try {
      NET.ws = new WebSocket(wsUrl());
    } catch (_) {
      return;
    }

    NET.ws.addEventListener('open', () => {
      NET.connected = true;
      sendWs({ type: 'HELLO', payload: {} });

      const saved = localStorage.getItem('tonkSeatName');
      if (saved) requestClaimSeat(saved);
      else openSeatModal();
    });

    NET.ws.addEventListener('message', (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'WELCOME') {
        NET.clientId = msg.payload && msg.payload.clientId;
        if (Array.isArray(msg.payload && msg.payload.seatNames)) NET.seatNames = msg.payload.seatNames;
        return;
      }

      if (msg.type === 'CLAIM_OK') {
        NET.mySeatIdx = msg.payload && msg.payload.seatIdx;
        NET.mySeatName = msg.payload && msg.payload.name;
        if (NET.mySeatName) localStorage.setItem('tonkSeatName', NET.mySeatName);
        closeSeatModal();
        ensureLocalModeSelect();
        const whoText = document.getElementById('whoAmIText');
        if (whoText) whoText.textContent = NET.mySeatName ? `You are: ${NET.mySeatName}` : 'Not seated';
        render();
        return;
      }

      if (msg.type === 'CLAIM_DENIED') {
        openSeatModal();
        if (UI.seatModalHint) UI.seatModalHint.textContent = 'Seat is unavailable. Choose another.';
        return;
      }

      if (msg.type === 'STATE') {
        applyServerStateSnapshot(msg.payload);
        return;
      }
    });

    const scheduleReconnect = () => {
      NET.connected = false;
      if (NET.reconnectTimer) clearTimeout(NET.reconnectTimer);
      NET.reconnectTimer = setTimeout(() => connectMultiplayer(), 1000);
    };

    NET.ws.addEventListener('close', scheduleReconnect);
    NET.ws.addEventListener('error', scheduleReconnect);
  }

  function updateSortModeLabel() {}

  function cardCode(c) {
    if (!c) return '';
    return `${rankLabel(c.rank)}${typeof c.suit === 'string' ? c.suit : ''}`;
  }

  const SORT_SUIT_ORDER = { D: 0, C: 1, H: 2, S: 3 };

  function compareSuitRank(a, b) {
    const sa = SORT_SUIT_ORDER[a.suit] ?? 99;
    const sb = SORT_SUIT_ORDER[b.suit] ?? 99;
    if (sa !== sb) return sa - sb;
    return (a.rank - b.rank) || 0;
  }

  function compareRankSuit(a, b) {
    const r = (a.rank - b.rank) || 0;
    if (r) return r;
    const sa = SORT_SUIT_ORDER[a.suit] ?? 99;
    const sb = SORT_SUIT_ORDER[b.suit] ?? 99;
    return sa - sb;
  }

  function toggleSort() {
    try {
      if (STATE.handOver) return;
      if (STATE.busy) return;
      if (!STATE.players[0]?.playing) return;

      const human = STATE.players[0];
      if (!human) return;
      const before = human.hand.map(cardCode).join(',');

      const useSuitRank = STATE.sortMode === 0;
      human.hand.sort(useSuitRank ? compareSuitRank : compareRankSuit);
      STATE.sortMode = useSuitRank ? 1 : 0;

      const after = human.hand.map(cardCode).join(',');
      console.log(`[DEV] Sort mode=${useSuitRank ? 'Suit+Rank' : 'Rank-first'} Before: ${before} After: ${after}`);
      render();
    } catch (e) {
      handleError(e);
    }
  }

  function moveCardInHand(player, fromIdx, toIdx) {
    if (!player || !Array.isArray(player.hand)) return;
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return;
    if (fromIdx < 0 || fromIdx >= player.hand.length) return;
    if (toIdx < 0) toIdx = 0;
    if (toIdx > player.hand.length) toIdx = player.hand.length;
    if (fromIdx === toIdx) return;

    const [c] = player.hand.splice(fromIdx, 1);
    if (!c) return;
    player.hand.splice(toIdx, 0, c);
  }

  function syncOptionsFromUi() {
    if (!UI.optNoKnock) return;
    gameOptions.noKnock = !!UI.optNoKnock.checked;
    if (gameOptions.noKnock) STATE.pendingKnock = false;
    if (UI.optStake) {
      if (UI.optStake.disabled) {
        UI.optStake.value = String(gameOptions.basicStake);
        render();
        return;
      }
      const v = Number(UI.optStake.value);
      gameOptions.basicStake = Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
      UI.optStake.value = String(gameOptions.basicStake);
    }
    render();
  }

  function formatMs(ms) {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const tenths = Math.floor(safe / 100);
    const totalSeconds = Math.floor(tenths / 10);
    const t = tenths % 10;
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60);
    const ss = m > 0 ? String(s).padStart(2, '0') : String(s);
    return m > 0 ? `${m}:${ss}.${t}` : `${ss}.${t}`;
  }

  function ensureTurnTimingInit() {
    if (!STATE.turnTiming.perPlayer.length) {
      STATE.turnTiming.perPlayer = Array.from({ length: STATE.players.length }, () => ({ totalMs: 0, turns: 0, lastTurnMs: 0 }));
    }
  }

  function updateTurnTimerUi() {
    if (STATE.handOver || STATE.dealing) {
      if (STATE.turnTiming.rafId != null) {
        cancelAnimationFrame(STATE.turnTiming.rafId);
        STATE.turnTiming.rafId = null;
      }
      return;
    }
    if (STATE.turnTiming.turnStartTs == null) return;

    const now = performance.now();
    const currentMs = Math.max(0, now - STATE.turnTiming.turnStartTs);
    const idx = STATE.currentPlayer;

    const el = idx === 0 ? UI.humanTurnTime : idx === 1 ? UI.cpu1TurnTime : idx === 2 ? UI.cpu2TurnTime : idx === 3 ? UI.cpu3TurnTime : UI.cpu4TurnTime;
    if (el) el.textContent = formatMs(currentMs);

    if (STATE.turnTiming.rafId != null) cancelAnimationFrame(STATE.turnTiming.rafId);
    STATE.turnTiming.rafId = requestAnimationFrame(updateTurnTimerUi);
  }

  function startTurnTimer(playerIdx) {
    if (STATE.handOver || STATE.dealing) return;
    if (!Number.isInteger(playerIdx) || playerIdx < 0 || playerIdx >= STATE.players.length) return;
    if (!STATE.players[playerIdx] || !STATE.players[playerIdx].playing) return;

    ensureTurnTimingInit();
    STATE.turnTiming.turnStartTs = performance.now();
    STATE.turnTiming.currentPlayerAtStart = playerIdx;

    if (STATE.turnTiming.rafId != null) cancelAnimationFrame(STATE.turnTiming.rafId);
    STATE.turnTiming.rafId = requestAnimationFrame(updateTurnTimerUi);
  }

  function endTurnTimer(playerIdx) {
    if (STATE.turnTiming.turnStartTs == null) return;
    if (STATE.turnTiming.currentPlayerAtStart == null) return;

    const idx = Number.isInteger(playerIdx) ? playerIdx : STATE.turnTiming.currentPlayerAtStart;
    const now = performance.now();
    const ms = Math.max(0, now - STATE.turnTiming.turnStartTs);

    ensureTurnTimingInit();
    const rec = STATE.turnTiming.perPlayer[idx];
    if (rec) {
      rec.totalMs += ms;
      rec.turns += 1;
      rec.lastTurnMs = ms;
    }
    STATE.turnTiming.group.totalMs += ms;
    STATE.turnTiming.group.turns += 1;

    STATE.turnTiming.turnStartTs = null;
    STATE.turnTiming.currentPlayerAtStart = null;
    if (STATE.turnTiming.rafId != null) {
      cancelAnimationFrame(STATE.turnTiming.rafId);
      STATE.turnTiming.rafId = null;
    }
  }

  function logLine(msg) {
    const el = document.createElement('div');
    el.textContent = `[${safeNow()}] ${msg}`;
    UI.log.insertBefore(el, UI.log.firstChild);
    while (UI.log.childNodes.length > CONFIG.logMaxLines) {
      UI.log.removeChild(UI.log.lastChild);
    }
    // Newest entries are on top.
    UI.log.scrollTop = 0;
  }

  function setStatus(msg) {
    UI.statusLine.textContent = msg;
  }

  let lastTapTime = 0;
  let lastTapUid = null;
  let lastTapPointerType = null;

  const STATE = {
    deck: [],
    discard: [],
    players: [],
    dealerIndex: 0,
    currentPlayer: 0,
    phase: 'mustDraw',
    selected: new Set(),
    selectedMeldTarget: null, // { ownerSeatIdx, meldIndex }
    pendingKnock: false,
    handOver: false,
    busy: false,
    justDrewCardId: null,
    justDrewHold: false,
    sortMode: 0,
    scores: [0, 0, 0, 0, 0],
    play: [true, true, true, true, true],
    turnTiming: {
      turnStartTs: null,
      currentPlayerAtStart: null,
      perPlayer: [],
      group: { totalMs: 0, turns: 0 },
      rafId: null,
    },
    drag: {
      pointerId: null,
      cardId: null,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      fromIndex: -1,
      active: false,
      dragging: false,
      placeholderIndex: -1,
      floatingEl: null,
      placeholderEl: null,
      sourceEl: null,
      sourceRect: null,
      suppressClick: false,
    },
    lastError: null,
    ui: {
      showLog: false,
    },
  };

  function applyUiVisibility() {
    document.body.classList.toggle('showLog', !!STATE.ui.showLog);
    if (UI.btnToggleLog) UI.btnToggleLog.textContent = STATE.ui.showLog ? 'Hide Log' : 'Show Log';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function actionDelayMs() {
    return randInt(CONFIG.cpuActionDelayMinMs, CONFIG.cpuActionDelayMaxMs);
  }

  function clearJustDrew() {
    STATE.justDrewCardId = null;
    STATE.justDrewHold = false;
  }

  function setJustDrew(cardId) {
    STATE.justDrewCardId = cardId;
    STATE.justDrewHold = false;
    render();
    window.setTimeout(() => {
      if (STATE.justDrewCardId !== cardId) return;
      STATE.justDrewHold = true;
      render();
    }, 1200);
  }

  function elementCenterRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  const CARD_ASSET_BASE = 'assets/cards';

  function normalizeRank(rank) {
    if (rank === 1 || rank === '1' || rank === 'A' || rank === 'a' || rank === 'ace' || rank === 'ACE') return 'A';
    if (rank === 11 || rank === '11' || rank === 'J' || rank === 'j' || rank === 'jack' || rank === 'JACK') return 'J';
    if (rank === 12 || rank === '12' || rank === 'Q' || rank === 'q' || rank === 'queen' || rank === 'QUEEN') return 'Q';
    if (rank === 13 || rank === '13' || rank === 'K' || rank === 'k' || rank === 'king' || rank === 'KING') return 'K';

    const n = typeof rank === 'number' ? rank : Number(rank);
    if (Number.isFinite(n) && n >= 2 && n <= 10) return String(Math.trunc(n));

    if (typeof rank === 'string') {
      const t = rank.trim();
      if (/^(?:[2-9]|10)$/.test(t)) return t;
    }

    return null;
  }

  function normalizeSuit(suit) {
    if (suit == null) return null;
    if (typeof suit === 'string') {
      const t = suit.trim();
      const u = t.toUpperCase();

      if (t === '♣' || u === 'C' || u === 'CLUB' || u === 'CLUBS') return 'C';
      if (t === '♦' || u === 'D' || u === 'DIAMOND' || u === 'DIAMONDS') return 'D';
      if (t === '♥' || u === 'H' || u === 'HEART' || u === 'HEARTS') return 'H';
      if (t === '♠' || u === 'S' || u === 'SPADE' || u === 'SPADES') return 'S';
    }
    return null;
  }

  function suitSymbolFromNormalized(s) {
    if (s === 'C') return '♣';
    if (s === 'D') return '♦';
    if (s === 'H') return '♥';
    if (s === 'S') return '♠';
    return '';
  }

  // If your asset filenames differ, edit these two functions.
  function faceAssetFilename(card) {
    const r = normalizeRank(card?.rank);
    const s = normalizeSuit(card?.suit);
    if (!r || !s) {
      console.warn('[cards] Failed to normalize card for asset filename:', card);
      return null;
    }
    return `${r}${s}.svg`;
  }

  function backAssetFilename() {
    // Preferred: BACK-RED.svg. Fallback: BACK.svg.
    return 'BACK-RED.svg';
  }

  function cardFaceText(card) {
    const r = normalizeRank(card?.rank) || rankLabel(card?.rank);
    const sNorm = normalizeSuit(card?.suit);
    const s = typeof card?.suit === 'string' && card.suit.length ? card.suit : (sNorm ? suitSymbolFromNormalized(sNorm) : '');
    return `${r}${s}`;
  }

  function setCardImg(el, src, alt, fallbackText) {
    if (!el) return;

    let img = el.querySelector(':scope > img.card-img');
    if (!img) {
      el.textContent = '';
      img = document.createElement('img');
      img.className = 'card-img';
      img.draggable = false;
      el.appendChild(img);
    } else {
      for (const node of Array.from(el.childNodes)) {
        if (node !== img) node.remove();
      }
    }

    img.alt = alt || '';
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.onerror = () => {
      if (src.endsWith('/BACK-RED.svg')) {
        img.setAttribute('src', `${CARD_ASSET_BASE}/BACK.svg`);
      } else {
        el.textContent = fallbackText || alt || '??';
      }
    };
  }

  function renderCardFace(el, card) {
    if (!el || !card) return;
    el.classList.toggle('red', isRedSuit(card.suit));
    const fn = faceAssetFilename(card);
    if (!fn) {
      el.innerHTML = '';
      el.textContent = cardFaceText(card);
      return;
    }
    const src = `${CARD_ASSET_BASE}/${fn}`;
    setCardImg(el, src, cardFaceText(card), cardFaceText(card));
  }

  function renderCardBack(el) {
    if (!el) return;
    el.classList.remove('red');
    const src = `${CARD_ASSET_BASE}/${backAssetFilename()}`;
    setCardImg(el, src, 'Card Back', '🂠');
  }

  function rankLabel(rank) {
    if (rank === 1) return 'A';
    if (rank === 11) return 'J';
    if (rank === 12) return 'Q';
    if (rank === 13) return 'K';
    return String(rank);
  }

  async function animateFlyCard(fromEl, toEl, faceText, faceDown, durationOverrideMs) {
    if (!fromEl || !toEl || !UI.fxLayer) return;

    const from = elementCenterRect(fromEl);
    const to = elementCenterRect(toEl);

    const fly = document.createElement('div');
    fly.className = `flyCard ${faceDown ? 'back' : 'face'}`;
    if (faceDown) {
      renderCardBack(fly);
    } else {
      // We only have the text here (e.g. "Q♠"), so parse it to a card-like object.
      const t = typeof faceText === 'string' ? faceText.trim() : '';
      if (t.length >= 2) {
        const suit = t.slice(-1);
        const rankStr = t.slice(0, -1);
        const rank = rankStr === 'A' ? 1 : rankStr === 'J' ? 11 : rankStr === 'Q' ? 12 : rankStr === 'K' ? 13 : Number(rankStr);
        if (Number.isFinite(rank)) {
          renderCardFace(fly, { rank, suit });
        } else {
          fly.textContent = faceText;
        }
      } else {
        fly.textContent = faceText;
      }
    }
    fly.style.left = `${from.x}px`;
    fly.style.top = `${from.y}px`;
    fly.style.transform = 'translate(-50%, -50%)';
    UI.fxLayer.appendChild(fly);

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const anim = fly.animate(
      [
        { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1)' },
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.98)` },
      ],
      {
        duration: typeof durationOverrideMs === 'number' ? durationOverrideMs : CONFIG.animationMs,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        fill: 'forwards',
      }
    );

    try {
      await anim.finished;
    } finally {
      fly.remove();
    }
  }

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

  function ensureScoresSized() {
    if (!Array.isArray(STATE.scores)) STATE.scores = [];
    const n = STATE.players.length;
    if (STATE.scores.length !== n) {
      const next = Array.from({ length: n }, (_, i) => (Number.isFinite(STATE.scores[i]) ? STATE.scores[i] : 0));
      STATE.scores = next;
    }
  }

  function initPlayers() {
    STATE.players = [
      { name: 'Billy', isHuman: true, hand: [], melds: [], revealedMelds: [], playing: true },
      { name: 'Butch', isHuman: false, hand: [], melds: [], revealedMelds: [], playing: true },
      { name: 'Curt', isHuman: false, hand: [], melds: [], revealedMelds: [], playing: true },
      { name: 'Andy', isHuman: false, hand: [], melds: [], revealedMelds: [], playing: true },
      { name: 'Mark', isHuman: false, hand: [], melds: [], revealedMelds: [], playing: true },
    ];
    ensureScoresSized();
  }

  function syncParticipationFromUi() {
    if (NET.connected) return;
    const checks = [UI.optPlay0, UI.optPlay1, UI.optPlay2, UI.optPlay3, UI.optPlay4];
    for (let i = 0; i < STATE.players.length; i++) {
      const p = STATE.players[i];
      if (!p) continue;
      p.playing = !!checks[i]?.checked;
    }
  }

  function resetHandState() {
    STATE.deck = makeDeck();
    STATE.discard = [];
    STATE.phase = 'mustDraw';
    STATE.selected = new Set();
    STATE.pendingKnock = false;
    STATE.handOver = false;
    STATE.busy = false;
    STATE.dealing = false;
    STATE.winnerIndex = null;
    clearJustDrew();
    STATE.lastError = null;

    for (const p of STATE.players) {
      p.hand = [];
      p.melds = [];
      p.revealedMelds = [];
    }
  }

  function getHandElByPlayerIndex(idx) {
    if (idx === 0) return UI.humanHand;
    if (idx === 1) return UI.cpu1Hand;
    if (idx === 2) return UI.cpu2Hand;
    if (idx === 3) return UI.cpu3Hand;
    return UI.cpu4Hand;
  }

  function seatElByPlayerIndex(idx) {
    if (idx === 0) return UI.seatHuman;
    if (idx === 1) return UI.seatCpu1;
    if (idx === 2) return UI.seatCpu2;
    if (idx === 3) return UI.seatCpu3;
    return UI.seatCpu4;
  }

  function canLocalUserActNow() {
    const mi = mySeatIdx();
    if (mi == null) return false;
    if (STATE.handOver || STATE.busy || STATE.dealing) return false;
    const seat = NET.lastServerState && Array.isArray(NET.lastServerState.seats) ? NET.lastServerState.seats[mi] : null;
    if (!seat) return false;
    if (seat.mode === 'sittingOut') return false;
    if (seat.folded) return false;
    const p = STATE.players[mi];
    if (!p) return false;
    return STATE.currentPlayer === mi;
  }

  function canLocalUserSelectCards() {
    if (!NET.connected) return true;
    const seat = mySeatInfo();
    if (!seat) return false;
    if (seat.mode !== 'human') return false;
    if (seat.folded) return false;
    if (seat.pendingJoin) return false;
    if (STATE.handOver || STATE.dealing || STATE.busy) return false;
    return true;
  }

  function sortMyHandClientSide() {
    const mi = mySeatIdx();
    if (mi == null) return;
    const p = STATE.players[mi];
    if (!p || !Array.isArray(p.hand)) return;
    p.hand = sortedByRankThenSuit(p.hand);
    render();
  }

  function handPoints(cards) {
    return cards.reduce((acc, c) => acc + cardValue(c.rank), 0);
  }

  function rotateDealer() {
    STATE.dealerIndex = nextPlayerIndex(STATE.dealerIndex);
    logLine(`Dealer rotates to: ${STATE.players[STATE.dealerIndex].name}.`);
  }

  function applyPayment(fromIdx, toIdx, amount, why) {
    if (!Number.isFinite(amount) || amount === 0) return;
    STATE.scores[fromIdx] -= amount;
    STATE.scores[toIdx] += amount;
    logLine(`${STATE.players[fromIdx].name} pays ${STATE.players[toIdx].name} ${amount} (${why}).`);
  }

  function settleWinner(winnerIdx, stakeMultiplier, why) {
    if (!Number.isInteger(winnerIdx) || winnerIdx < 0 || winnerIdx >= STATE.players.length) return;
    const winner = STATE.players[winnerIdx];
    if (!winner || !winner.playing) return;

    const mult = Number.isFinite(stakeMultiplier) && stakeMultiplier > 0 ? stakeMultiplier : 1;
    const stake = (gameOptions.basicStake || 1) * mult;

    STATE.winnerIndex = winnerIdx;
    for (let i = 0; i < STATE.players.length; i++) {
      if (i === winnerIdx) continue;
      const p = STATE.players[i];
      if (!p || !p.playing) continue;
      applyPayment(i, winnerIdx, stake, why || 'winner');
    }
  }

  function settleByDeadwood(why) {
    const results = showdownScores().filter((r) => STATE.players[r.idx]?.playing);
    if (!results.length) return { ok: false, draw: true };

    let best = Infinity;
    for (const r of results) best = Math.min(best, r.deadwood);
    const winners = results.filter((r) => r.deadwood === best);
    if (winners.length !== 1) {
      logLine(`${why}: draw (tie at ${best}).`);
      STATE.winnerIndex = null;
      return { ok: false, draw: true };
    }

    const w = winners[0];
    logLine(`${why}: ${w.name} wins with deadwood ${w.deadwood}.`);
    settleWinner(w.idx, 1, why);
    return { ok: true, winnerIdx: w.idx };
  }

  function settleDrop(byIdx) {
    settleByDeadwood('drop');
  }

  function settleStockOut() {
    settleByDeadwood('stockout');
  }

  function checkEmptyHandWin(pIdx, terminalCheck) {
    try {
      if (STATE.handOver) return true;
      const p = STATE.players[pIdx];
      if (!p || !p.playing) return false;
      if (p.hand.length !== 0) return false;

      logLine(`${p.name} went out (empty hand).`);
      settleWinner(pIdx, 1, terminalCheck ? 'empty hand' : 'empty hand');
      endHand({ kind: 'empty', by: pIdx });
      return true;
    } catch (e) {
      handleError(e);
      return false;
    }
  }

  function renderScoreboard() {
    if (!UI.scoreboard) return;
    UI.scoreboard.innerHTML = '';
    for (let i = 0; i < STATE.players.length; i++) {
      const row = document.createElement('div');
      row.className = 'scoreRow';
      const name = document.createElement('div');
      name.className = 'scoreName';
      name.textContent = STATE.players[i].name;
      const val = document.createElement('div');
      val.className = 'scoreVal';
      const n = STATE.scores[i] || 0;
      val.textContent = (n >= 0 ? `+${n}` : String(n));
      row.appendChild(name);
      row.appendChild(val);
      UI.scoreboard.appendChild(row);
    }
  }

  async function dealNewHand() {
    const n = STATE.players.length;
    const nPlaying = participatingCount();
    const firstToDeal = nextParticipatingIndex(STATE.dealerIndex);
    logLine(`Dealer: ${STATE.players[STATE.dealerIndex].name}. First player: ${STATE.players[firstToDeal].name}.`);

    const dealAnimMs = 60;

    STATE.busy = true;
    STATE.dealing = true;
    render();

    for (let round = 0; round < CONFIG.handSize; round++) {
      let pi = firstToDeal;
      for (let dealt = 0; dealt < nPlaying; dealt++) {
        const p = STATE.players[pi];
        if (p && p.playing) {
          const c = STATE.deck.pop();
          if (!c) break;
          p.hand.push(c);
          if (pi === 0) {
            updateHandDom(UI.humanHand, p.hand, true);
          } else {
            updateCpuHandDom(getHandElByPlayerIndex(pi), p.hand.length);
          }
          await animateFlyCard(UI.drawPileCard, getHandElByPlayerIndex(pi), '', true, dealAnimMs);
          await sleep(CONFIG.initialDealCardDelayMs);
        }
        pi = nextParticipatingIndex(pi);
      }
    }

    const firstDiscard = STATE.deck.pop();
    if (firstDiscard) {
      STATE.discard.push(firstDiscard);
      render();
      await animateFlyCard(UI.drawPileCard, UI.discardPileCard, cardText(firstDiscard), true, dealAnimMs);
    }

    const immediate = [];
    for (let i = 0; i < STATE.players.length; i++) {
      if (!STATE.players[i].playing) continue;
      const pts = handPoints(STATE.players[i].hand);
      if (pts === 49 || pts === 50) immediate.push(i);
    }
    if (immediate.length === 1) {
      const w = immediate[0];
      logLine('Immediate tonk (49/50) — double stake.');
      settleWinner(w, 2, 'immediate tonk');
      endHand({ kind: 'immediate', by: w });
      return;
    }
    if (immediate.length >= 2) {
      logLine('Immediate tonk (49/50) — multiple players. Hand is a draw.');
      endHand({ kind: 'immediate-draw', by: -1 });
      return;
    }

    STATE.currentPlayer = firstToDeal;
    if (STATE.players[STATE.currentPlayer] && !STATE.players[STATE.currentPlayer].playing) {
      STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
    }
    STATE.phase = 'mustDraw';
    STATE.busy = false;
    STATE.dealing = false;
    updateHandDom(UI.humanHand, STATE.players[0].hand, false);
    render();

    startTurnTimer(STATE.currentPlayer);

    if (STATE.currentPlayer !== 0) maybeRunCpuTurn();
  }

  function topDiscard() {
    return STATE.discard.length ? STATE.discard[STATE.discard.length - 1] : null;
  }

  function recycleDeckIfNeeded() {
    if (STATE.deck.length > 0) return false;
    if (STATE.discard.length <= 1) return false;

    const top = STATE.discard.pop();
    const recycle = STATE.discard.splice(0, STATE.discard.length);
    shuffleInPlace(recycle);
    STATE.deck = recycle;
    if (top) STATE.discard.push(top);
    logLine('Deck was empty. Recycled discard pile into deck.');
    render();
    return STATE.deck.length > 0;
  }

  function ensureDeckNotEmpty() {
    if (STATE.deck.length > 0) return true;
    if (recycleDeckIfNeeded()) return true;
    return false;
  }

  function currentPlayer() {
    return STATE.players[STATE.currentPlayer];
  }

  function nextPlayerIndex(idx) {
    return (idx + 1) % STATE.players.length;
  }

  function nextParticipatingIndex(idx) {
    const n = STATE.players.length;
    for (let step = 1; step <= n; step++) {
      const j = (idx + step) % n;
      if (STATE.players[j] && STATE.players[j].playing) return j;
    }
    return idx;
  }

  function handValueSimple(cards) {
    return cards.reduce((acc, c) => acc + cardValue(c.rank), 0);
  }

  function playerDeadwoodEstimate(p) {
    const res = bestDeadwood(p.hand);
    return res.deadwood;
  }

  function canKnock(p) {
    return playerDeadwoodEstimate(p) <= CONFIG.knockThreshold;
  }

  function checkTonkPossible(p) {
    const res = bestDeadwood(p.hand);
    return res.deadwood === 0;
  }

  function updateRevealedMeldsForPlayer(p) {
    const res = bestDeadwood(p.hand);
    p.revealedMelds = res.meldMasks.map((mask) => {
      const meldCards = [];
      for (let i = 0; i < p.hand.length; i++) {
        if (mask & (1 << i)) meldCards.push(cloneCard(p.hand[i]));
      }
      const val = validateMeld(meldCards);
      const m = { type: val.ok ? val.type : 'meld', cards: meldCards };
      if (val.ok && val.type === 'run') m.aceHigh = !!val.aceHigh;
      return m;
    });
  }

  function cpuPlaySpreadsAndHits(pIdx) {
    const p = STATE.players[pIdx];
    if (!p || p.isHuman) return;

    let improved = true;
    while (improved) {
      improved = false;
      const res = bestDeadwood(p.hand);
      if (!res.meldMasks.length) break;

      const mm = res.meldMasks[0];
      const meldCards = [];
      const keep = [];
      for (let i = 0; i < p.hand.length; i++) {
        if (mm & (1 << i)) meldCards.push(p.hand[i]);
        else keep.push(p.hand[i]);
      }

      const val = validateMeld(meldCards);
      if (!val.ok) break;
      p.hand = keep;
      const meldObj = { type: val.type, cards: sortedByRankThenSuit(meldCards.map(cloneCard)) };
      if (val.type === 'run') {
        meldObj.aceHigh = !!val.aceHigh;
        sortRunMeldCards(meldObj);
      }
      p.melds.push(meldObj);
      logLine(`${p.name} laid down a ${val.type.toUpperCase()} spread (${meldCards.length} cards).`);
      improved = true;
    }

    let hitMade = true;
    while (hitMade) {
      hitMade = false;
      for (let i = 0; i < p.hand.length; i++) {
        const c = p.hand[i];
        const hit = applyHitToFirstLegalMeld(cloneCard(c));
        if (hit.ok) {
          p.hand.splice(i, 1);
          logLine(`${p.name} hit ${STATE.players[hit.playerIdx].name}'s spread with ${cardText(c)}.`);
          hitMade = true;
          break;
        }
      }
    }
  }

  function renderMelds(container, melds, ownerSeatIdx) {
    container.innerHTML = '';
    for (let i = 0; i < melds.length; i++) {
      const meld = melds[i];
      const wrap = document.createElement('div');
      wrap.className = 'meld';
      if (Number.isInteger(ownerSeatIdx)) wrap.dataset.ownerSeatIdx = String(ownerSeatIdx);
      wrap.dataset.meldIndex = String(i);
      if (STATE.selectedMeldTarget && STATE.selectedMeldTarget.ownerSeatIdx === ownerSeatIdx && STATE.selectedMeldTarget.meldIndex === i) {
        wrap.classList.add('meldTargetSelected');
      }
      const header = document.createElement('div');
      header.className = 'meldHeader';
      const left = document.createElement('div');
      left.textContent = `${(meld.type || 'meld').toUpperCase()} #${i + 1}`;
      const right = document.createElement('div');
      right.textContent = `${meld.cards.length} cards`;
      header.appendChild(left);
      header.appendChild(right);

      const cardsRow = document.createElement('div');
      cardsRow.className = 'meldCards';
      for (const c of meld.cards) {
        const ce = document.createElement('div');
        ce.className = 'handCard' + (isRedSuit(c.suit) ? ' red' : '');
        renderCardFace(ce, c);
        ce.style.cursor = 'default';
        cardsRow.appendChild(ce);
      }

      wrap.appendChild(header);
      wrap.appendChild(cardsRow);
      container.appendChild(wrap);
    }
  }

  function render() {
    const td = topDiscard();
    UI.drawPileCount.textContent = String(STATE.deck.length);
    UI.discardPileCount.textContent = String(STATE.discard.length);

    UI.discardPileCard.className = 'card' + (td && isRedSuit(td.suit) ? ' red' : '');
    if (td) renderCardFace(UI.discardPileCard, td);
    else {
      UI.discardPileCard.textContent = '';
      UI.discardPileCard.textContent = '—';
    }

    renderCardBack(UI.drawPileCard);

    const canInteract = NET.connected ? canLocalUserActNow() : (!STATE.handOver && !STATE.busy && STATE.currentPlayer === 0 && !!STATE.players[0]?.playing);
    UI.drawPile.classList.toggle('dbl', canInteract && STATE.phase === 'mustDraw');
    UI.discardPile.classList.toggle('dbl', canInteract && STATE.phase === 'mustDraw' && !!td);

    UI.turnIndicator.textContent = `Turn: ${currentPlayer().name}`;

    if (NET.connected) ensureLocalSeatControlsMounted();

    if (UI.btnResetGame) UI.btnResetGame.style.display = NET.connected ? '' : 'none';

    renderScoreboard();

    for (let i = 0; i < STATE.players.length; i++) {
      const seat = seatElByPlayerIndex(i);
      if (!seat) continue;
      seat.classList.toggle('isDealer', i === STATE.dealerIndex);
      seat.classList.toggle('isTurn', i === STATE.currentPlayer && !STATE.handOver);
      seat.classList.toggle('isWinner', Number.isInteger(STATE.winnerIndex) && i === STATE.winnerIndex);
    }

    const mi2 = mySeatIdx();
    const seatsSnap = NET.connected && NET.lastServerState && Array.isArray(NET.lastServerState.seats) ? NET.lastServerState.seats : null;

    const human = STATE.players[0];
    const humanStatus = NET.connected ? seatStatusTextFromServer(seatsSnap && seatsSnap[0]) : (human.playing ? '' : 'Sitting Out');
    const humanIsMine = NET.connected && mi2 === 0;
    const humanCardsN = NET.connected
      ? (humanIsMine ? (human.hand ? human.hand.length : 0) : (Number.isFinite(human.handCount) ? human.handCount : 0))
      : human.hand.length;
    const humanTxt = NET.connected
      ? `${humanStatus} | Cards: ${humanCardsN}`
      : (!human.playing
          ? 'Sitting Out'
          : (gameOptions.noKnock
              ? `Cards: ${humanCardsN} | Deadwood (best): ${playerDeadwoodEstimate(human)}`
              : `Cards: ${humanCardsN} | Deadwood (best): ${playerDeadwoodEstimate(human)} | Knock ≤ ${CONFIG.knockThreshold}`));
    if (UI.humanMetaText) UI.humanMetaText.textContent = humanTxt;
    else UI.humanMeta.textContent = humanTxt;

    const cpu1 = STATE.players[1];
    const cpu2 = STATE.players[2];
    const cpu3 = STATE.players[3];
    const cpu4 = STATE.players[4];

    const cpu1Cards = NET.connected ? (mi2 === 1 ? (cpu1.hand ? cpu1.hand.length : 0) : (Number.isFinite(cpu1.handCount) ? cpu1.handCount : 0)) : cpu1.hand.length;
    const cpu2Cards = NET.connected ? (mi2 === 2 ? (cpu2.hand ? cpu2.hand.length : 0) : (Number.isFinite(cpu2.handCount) ? cpu2.handCount : 0)) : cpu2.hand.length;
    const cpu3Cards = NET.connected ? (mi2 === 3 ? (cpu3.hand ? cpu3.hand.length : 0) : (Number.isFinite(cpu3.handCount) ? cpu3.handCount : 0)) : cpu3.hand.length;
    const cpu4Cards = NET.connected ? (mi2 === 4 ? (cpu4.hand ? cpu4.hand.length : 0) : (Number.isFinite(cpu4.handCount) ? cpu4.handCount : 0)) : cpu4.hand.length;

    const cpu1Status = NET.connected ? seatStatusTextFromServer(seatsSnap && seatsSnap[1]) : (cpu1.playing ? '' : 'Sitting Out');
    const cpu2Status = NET.connected ? seatStatusTextFromServer(seatsSnap && seatsSnap[2]) : (cpu2.playing ? '' : 'Sitting Out');
    const cpu3Status = NET.connected ? seatStatusTextFromServer(seatsSnap && seatsSnap[3]) : (cpu3.playing ? '' : 'Sitting Out');
    const cpu4Status = NET.connected ? seatStatusTextFromServer(seatsSnap && seatsSnap[4]) : (cpu4.playing ? '' : 'Sitting Out');

    const cpu1Txt = NET.connected ? `${cpu1Status} | Cards: ${cpu1Cards}` : (cpu1.playing ? `Cards: ${cpu1Cards}` : 'Sitting Out');
    const cpu2Txt = NET.connected ? `${cpu2Status} | Cards: ${cpu2Cards}` : (cpu2.playing ? `Cards: ${cpu2Cards}` : 'Sitting Out');
    const cpu3Txt = NET.connected ? `${cpu3Status} | Cards: ${cpu3Cards}` : (cpu3.playing ? `Cards: ${cpu3Cards}` : 'Sitting Out');
    const cpu4Txt = NET.connected ? `${cpu4Status} | Cards: ${cpu4Cards}` : (cpu4.playing ? `Cards: ${cpu4Cards}` : 'Sitting Out');

    if (UI.cpu1MetaText) UI.cpu1MetaText.textContent = cpu1Txt;
    else UI.cpu1Meta.textContent = cpu1Txt;
    if (UI.cpu2MetaText) UI.cpu2MetaText.textContent = cpu2Txt;
    else UI.cpu2Meta.textContent = cpu2Txt;
    if (UI.cpu3MetaText) UI.cpu3MetaText.textContent = cpu3Txt;
    else UI.cpu3Meta.textContent = cpu3Txt;
    if (UI.cpu4MetaText) UI.cpu4MetaText.textContent = cpu4Txt;
    else UI.cpu4Meta.textContent = cpu4Txt;

    if (STATE.turnTiming && STATE.turnTiming.perPlayer && STATE.turnTiming.perPlayer.length) {
      const now = performance.now();
      const activeIdx = STATE.currentPlayer;
      const activeMs = !STATE.handOver && !STATE.dealing && STATE.turnTiming.turnStartTs != null && STATE.turnTiming.currentPlayerAtStart === activeIdx ? Math.max(0, now - STATE.turnTiming.turnStartTs) : null;

      if (UI.humanTurnTime) UI.humanTurnTime.textContent = activeIdx === 0 && activeMs != null ? formatMs(activeMs) : formatMs(STATE.turnTiming.perPlayer[0]?.lastTurnMs || 0);
      if (UI.cpu1TurnTime) UI.cpu1TurnTime.textContent = activeIdx === 1 && activeMs != null ? formatMs(activeMs) : formatMs(STATE.turnTiming.perPlayer[1]?.lastTurnMs || 0);
      if (UI.cpu2TurnTime) UI.cpu2TurnTime.textContent = activeIdx === 2 && activeMs != null ? formatMs(activeMs) : formatMs(STATE.turnTiming.perPlayer[2]?.lastTurnMs || 0);
      if (UI.cpu3TurnTime) UI.cpu3TurnTime.textContent = activeIdx === 3 && activeMs != null ? formatMs(activeMs) : formatMs(STATE.turnTiming.perPlayer[3]?.lastTurnMs || 0);
      if (UI.cpu4TurnTime) UI.cpu4TurnTime.textContent = activeIdx === 4 && activeMs != null ? formatMs(activeMs) : formatMs(STATE.turnTiming.perPlayer[4]?.lastTurnMs || 0);

      if (UI.turnStats) {
        const billy = STATE.turnTiming.perPlayer[0] || { totalMs: 0, turns: 0 };
        const billyAvg = billy.turns ? billy.totalMs / billy.turns : 0;
        const group = STATE.turnTiming.group || { totalMs: 0, turns: 0 };
        const groupAvg = group.turns ? group.totalMs / group.turns : 0;
        const perLines = [];
        for (let i = 0; i < STATE.players.length; i++) {
          const p = STATE.players[i];
          if (!p || !p.playing) continue;
          const rec = STATE.turnTiming.perPlayer[i] || { totalMs: 0, turns: 0 };
          const avg = rec.turns ? rec.totalMs / rec.turns : 0;
          perLines.push(`${p.name} avg: ${formatMs(avg)} (${rec.turns})`);
        }
        UI.turnStats.textContent = `Billy total: ${formatMs(billy.totalMs)} | Billy avg: ${formatMs(billyAvg)} | Group avg: ${formatMs(groupAvg)} | ${perLines.join(' | ')}`;
      }
    }

    // Multiplayer: render your claimed seat hand face-up in that seat's container; others as backs/count.
    const mi = mySeatIdx();
    if (NET.connected && mi != null) {
      const myHandEl = getHandElByPlayerIndex(mi);
      if (myHandEl) updateHandDom(myHandEl, STATE.players[mi]?.hand || [], false);

      for (let i = 0; i < STATE.players.length; i++) {
        if (i === mi) continue;
        const p = STATE.players[i];
        const el = getHandElByPlayerIndex(i);
        if (!el) continue;
        const want = p && p.playing ? (Number.isFinite(p.handCount) ? p.handCount : 0) : 0;
        // Safe rebuild path: ensure opponent panels show backs with correct count.
        const mismatch = Array.from(el.children).filter((x) => x.classList && x.classList.contains('cpuCardBack')).length !== Math.min(want, 14);
        if (mismatch) el.innerHTML = '';
        updateCpuHandDom(el, want);
      }
    } else {
      renderCpuHand(UI.cpu1Hand, cpu1.playing ? cpu1.hand.length : 0);
      renderCpuHand(UI.cpu2Hand, cpu2.playing ? cpu2.hand.length : 0);
      renderCpuHand(UI.cpu3Hand, cpu3.playing ? cpu3.hand.length : 0);
      renderCpuHand(UI.cpu4Hand, cpu4.playing ? cpu4.hand.length : 0);

      if (!human.playing) {
        updateHandDom(UI.humanHand, [], false);
      } else {
        updateHandDom(UI.humanHand, human.hand, !!STATE.dealing);
      }
    }

    renderMelds(UI.humanMelds, human.playing ? human.melds : [], 0);
    renderMelds(UI.cpu1Melds, cpu1.playing ? (cpu1.melds || []) : [], 1);
    renderMelds(UI.cpu2Melds, cpu2.playing ? (cpu2.melds || []) : [], 2);
    renderMelds(UI.cpu3Melds, cpu3.playing ? (cpu3.melds || []) : [], 3);
    renderMelds(UI.cpu4Melds, cpu4.playing ? (cpu4.melds || []) : [], 4);

    updateButtons();
  }

  function updateButtons() {
    const p = currentPlayer();
    const isHumanTurn = p.isHuman && STATE.currentPlayer === 0;
    const canAct = !STATE.handOver;

    const mi = mySeatIdx();
    const enabled = NET.connected ? canLocalUserActNow() : (canAct && isHumanTurn && !STATE.busy && !!STATE.players[0]?.playing);
    const humanPlaying = NET.connected ? (mi != null && !!STATE.players[mi]) : !!STATE.players[0]?.playing;

    if (UI.btnSort) UI.btnSort.disabled = STATE.handOver || STATE.busy || !humanPlaying;

    const enoughPlayers = participatingCount() >= 2;
    UI.btnNewHand.disabled = !STATE.handOver || STATE.busy || STATE.dealing || !enoughPlayers;
    if (NET.connected) {
      const seat = mySeatInfo();
      const hasTarget = !!(STATE.selectedMeldTarget && Number.isInteger(STATE.selectedMeldTarget.ownerSeatIdx) && Number.isInteger(STATE.selectedMeldTarget.meldIndex));
      const sc = selectedCount();
      const canMeld = !!seat && seat.mode === 'human' && enabled && STATE.phase === 'mustDiscard' && (sc >= 3 || (sc === 1 && hasTarget));
      UI.btnCreateMeld.disabled = !canMeld;
    } else {
      UI.btnCreateMeld.disabled = !(enabled && STATE.phase === 'mustDiscard' && selectedCount() >= 1);
    }

    if (gameOptions.noKnock) {
      UI.btnKnock.style.display = 'none';
      UI.btnKnock.disabled = true;
    } else {
      if (NET.connected) {
        const seat = mySeatInfo();
        UI.btnKnock.style.display = seat && seat.mode === 'human' ? '' : 'none';
        UI.btnKnock.disabled = true;
      } else {
        UI.btnKnock.style.display = '';
        const dropAllowed = enabled && STATE.phase === 'mustDraw';
        UI.btnKnock.disabled = !dropAllowed;
      }
    }

    if (NET.connected && UI.btnSort) {
      const seat = mySeatInfo();
      UI.btnSort.disabled = !(seat && seat.mode === 'human');
    }

    const foldBtns = [UI.btnFold0, UI.btnFold1, UI.btnFold2, UI.btnFold3, UI.btnFold4];
    for (let i = 0; i < foldBtns.length; i++) {
      const b = foldBtns[i];
      if (!b) continue;
      b.disabled = NET.connected ? NET.mySeatIdx !== i : false;
    }

    if (UI.optNoKnock) {
      const lockNoKnock = !STATE.handOver || STATE.dealing;
      UI.optNoKnock.disabled = lockNoKnock;
      const label = UI.optNoKnock.closest('label');
      if (label) label.classList.toggle('isDisabled', lockNoKnock);
    }

    if (UI.optStake) {
      const lockStake = !STATE.handOver || STATE.dealing || STATE.busy;
      UI.optStake.disabled = lockStake;
      const label = UI.optStake.closest('label');
      if (label) label.classList.toggle('isDisabled', lockStake);
    }

    const playChecks = [UI.optPlay0, UI.optPlay1, UI.optPlay2, UI.optPlay3, UI.optPlay4];
    for (const el of playChecks) {
      if (!el) continue;
      const lock = !STATE.handOver || STATE.dealing;
      if (NET.connected) {
        el.disabled = lock || !Number.isInteger(NET.mySeatIdx) || playChecks[NET.mySeatIdx] !== el;
      } else {
        el.disabled = lock;
      }
      const label = el.closest('label');
      if (label) label.classList.toggle('isDisabled', lock);
    }

    const enough = participatingCount() >= 2;
    let msg = '';
    if (STATE.handOver) {
      msg = enough ? 'Hand over. Click “New Hand” to deal again.' : 'Select at least 2 players.';
    } else if (NET.connected) {
      const seat = mySeatInfo();
      const myName = seat ? seat.name : '';
      if (!seat) msg = 'Choose a seat to play.';
      else if (seat.mode === 'sittingOut') msg = 'You are sitting out.';
      else if (seat.pendingJoin) msg = 'Waiting (joins next hand).';
      else if (seat.mode === 'cpu') msg = 'AI is playing your seat.';
      else if (!canLocalUserActNow()) msg = `${p.name} is thinking...`;
      else if (STATE.busy) msg = 'Resolving action...';
      else if (STATE.phase === 'mustDraw') msg = 'Your turn: double-click Draw or Discard.';
      else if (STATE.phase === 'mustDiscard') msg = 'Click cards to select; double-click a card to discard; Meld to lay down.';
      else msg = myName ? `You are: ${myName}` : '';
    } else if (!isHumanTurn) {
      msg = `${p.name} is thinking...`;
    } else if (STATE.busy) {
      msg = 'Resolving action...';
    } else if (STATE.phase === 'mustDraw') {
      msg = 'Your turn: double-click Draw or Discard.';
    } else if (STATE.phase === 'mustDiscard') {
      msg = 'Double-click a card to discard (you can also create spreads/hits).';
    }
    setStatus(msg);
  }

  function ensureHumanCardWired(el) {
    if (!el || el._wiredHumanCard) return;
    el.addEventListener('pointerdown', beginHumanHandReorder);
    el._wiredHumanCard = true;
  }

  function updateHandDom(container, cards, faceDown) {
    if (!container) return;
    const existing = new Map();
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const uid = child.dataset.uid;
      if (uid) existing.set(uid, child);
    }

    for (const c of cards) {
      let el = existing.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.uid = c.id;
        el.dataset.cardId = c.id;
      } else {
        existing.delete(c.id);
      }

      el.className = 'handCard' + (isRedSuit(c.suit) ? ' red' : '');
      if (STATE.selected.has(c.id)) el.className += ' selected';
      if (STATE.justDrewCardId === c.id) el.className += STATE.justDrewHold ? ' just-drew-hold' : ' just-drew';

      ensureHumanCardWired(el);

      if (faceDown) renderCardBack(el);
      else renderCardFace(el, c);

      container.appendChild(el);
    }

    for (const leftover of existing.values()) leftover.remove();
  }

  function updateCpuHandDom(container, count) {
    if (!container) return;
    const maxShown = 14;
    const show = Math.min(count, maxShown);

    const moreExisting = container.querySelector(':scope > .moreCount');
    if (moreExisting) moreExisting.remove();

    const backs = Array.from(container.querySelectorAll(':scope > .cpuCardBack'));

    for (let i = 0; i < show; i++) {
      let el = backs[i];
      if (!el) {
        el = document.createElement('div');
        el.className = 'cpuCardBack';
        container.appendChild(el);
      }
      renderCardBack(el);
    }

    for (let i = backs.length - 1; i >= show; i--) {
      backs[i].remove();
    }

    if (count > maxShown) {
      const more = document.createElement('div');
      more.className = 'moreCount';
      more.textContent = `+${count - maxShown}`;
      container.appendChild(more);
    }
  }

  function renderCpuHand(container, count) {
    updateCpuHandDom(container, count);
  }

  function toggleSelected(cardId) {
    if (STATE.selected.has(cardId)) STATE.selected.delete(cardId);
    else STATE.selected.add(cardId);
    render();
  }

  function multiplayerMeldFromSelection() {
    const mi = mySeatIdx();
    if (mi == null) return;
    if (!canLocalUserActNow()) return;
    if (STATE.phase !== 'mustDiscard') return;
    const seat = mySeatInfo();
    if (!seat || seat.mode !== 'human') return;
    const ids = Array.from(STATE.selected);
    if (ids.length === 1 && STATE.selectedMeldTarget && Number.isInteger(STATE.selectedMeldTarget.ownerSeatIdx) && Number.isInteger(STATE.selectedMeldTarget.meldIndex)) {
      multiplayerSendAction('LAYOFF', {
        cardId: ids[0],
        targetSeatIdx: STATE.selectedMeldTarget.ownerSeatIdx,
        meldIndex: STATE.selectedMeldTarget.meldIndex,
      });
    } else {
      if (ids.length < 3) return;
      multiplayerSendAction('MELD', { cardIds: ids });
    }
    STATE.selected.clear();
    render();
  }

  function clearSelection() {
    STATE.selected.clear();
    render();
  }

  function selectedCount() {
    return STATE.selected.size;
  }

  function findCardInHandById(p, id) {
    return p.hand.find((c) => c.id === id) || null;
  }

  function removeCardFromHandById(p, id) {
    const idx = p.hand.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    return p.hand.splice(idx, 1)[0] || null;
  }

  function drawFromDeck(p) {
    if (!ensureDeckNotEmpty()) {
      logLine('No cards left to draw.');
      return null;
    }
    const c = STATE.deck.pop();
    if (!c) return null;
    p.hand.push(c);
    recycleDeckIfNeeded();
    return c;
  }

  function drawFromDiscard(p) {
    const c = STATE.discard.pop();
    if (!c) return null;
    p.hand.push(c);
    return c;
  }

  function discardCard(p, card) {
    STATE.discard.push(card);
  }

  async function humanDrawFrom(source) {
    try {
      if (STATE.handOver) return;
      if (STATE.currentPlayer !== 0) return;
      if (STATE.busy) return;
      if (!STATE.players[0]?.playing) return;
      if (STATE.phase !== 'mustDraw') return;

      STATE.busy = true;
      render();

      const p = STATE.players[0];

      let c = null;
      if (source === 'discard') {
        c = drawFromDiscard(p);
        if (!c) {
          logLine('Discard pile empty.');
          STATE.busy = false;
          render();
          return;
        }
        logLine(`You took discard ${cardText(c)}.`);
        render();
        await animateFlyCard(UI.discardPileCard, UI.humanHand, cardText(c), false);
      } else {
        c = drawFromDeck(p);
        if (!c) {
          const res = stockEmptyHandling('You');
          STATE.busy = false;
          render();
          if (res === 'must_take_discard') {
            const td = topDiscard();
            const fallback = drawFromDiscard(p);
            if (fallback) {
              c = fallback;
              logLine(`You took discard ${td ? cardText(td) : ''}.`);
              render();
              await animateFlyCard(UI.discardPileCard, UI.humanHand, td ? cardText(td) : '', false);
            }
          }
          if (!c) return;
        }
        logLine('You drew from deck.');
        render();
        await animateFlyCard(UI.drawPileCard, UI.humanHand, cardText(c), true);
      }

      setJustDrew(c.id);

      STATE.phase = 'mustDiscard';
      STATE.busy = false;
      render();

      if (!gameOptions.noKnock) {
        if (checkTonkPossible(p)) {
          logLine('You can go TONK (deadwood 0 after melding).');
        }
      }
    } catch (e) {
      STATE.busy = false;
      handleError(e);
      render();
    }
  }

  function humanCreateMeld() {
    try {
      if (STATE.handOver) return;
      if (STATE.currentPlayer !== 0) return;
      if (STATE.busy) return;
      if (STATE.phase !== 'mustDiscard') return;

      const p = STATE.players[0];
      const selectedIds = Array.from(STATE.selected);
      const cards = selectedIds.map((id) => findCardInHandById(p, id)).filter(Boolean);
      if (cards.length !== selectedIds.length) {
        logLine('Selection contained a card not in your hand. Clearing selection.');
        clearSelection();
        return;
      }
      if (cards.length >= 3) {
        const val = validateMeld(cards);
        if (!val.ok) {
          logLine('Selected cards are not a valid spread (book or run).');
          return;
        }

        const meldCards = [];
        for (const id of selectedIds) {
          const removed = removeCardFromHandById(p, id);
          if (removed) meldCards.push(removed);
        }
        const meldObj = { type: val.type, cards: sortedByRankThenSuit(meldCards) };
        if (val.type === 'run') {
          meldObj.aceHigh = !!val.aceHigh;
          sortRunMeldCards(meldObj);
        }
        p.melds.push(meldObj);
        logLine(`You laid down a ${val.type.toUpperCase()} spread (${meldCards.length} cards).`);
        clearSelection();
        render();
        if (checkEmptyHandWin(0, false)) return;
        return;
      }

      if (cards.length === 1) {
        const id = selectedIds[0];
        const removed = removeCardFromHandById(p, id);
        if (!removed) {
          logLine('Could not hit: card not found.');
          clearSelection();
          return;
        }
        const hit = applyHitToFirstLegalMeld(removed);
        if (!hit.ok) {
          p.hand.push(removed);
          logLine('No legal hit found for selected card.');
          clearSelection();
          render();
          return;
        }
        logLine(`You hit ${STATE.players[hit.playerIdx].name}'s spread with ${cardText(removed)}.`);
        clearSelection();
        render();
        if (checkEmptyHandWin(0, false)) return;
        return;
      }

      logLine('Select 3+ cards to lay a spread, or 1 card to hit a spread.');
    } catch (e) {
      handleError(e);
    }
  }

  async function humanDiscardById(id, fromEl) {
    try {
      if (STATE.handOver) return;
      if (STATE.currentPlayer !== 0) return;
      if (STATE.busy) return;
      if (STATE.phase !== 'mustDiscard') return;

      const p = STATE.players[0];
      const removed = removeCardFromHandById(p, id);
      if (!removed) {
        logLine('Could not discard: card not found in hand.');
        clearSelection();
        return;
      }

      STATE.busy = true;
      STATE.selected.clear();
      render();

      discardCard(p, removed);
      logLine(`You discarded ${cardText(removed)}.`);
      render();
      await animateFlyCard(fromEl || UI.humanHand, UI.discardPileCard, cardText(removed), false);

      clearJustDrew();

      if (p.hand.length === 0) {
        STATE.busy = false;
        render();
        checkEmptyHandWin(0, true);
        return;
      }

      endTurnTimer(0);
      STATE.phase = 'mustDraw';
      STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
      startTurnTimer(STATE.currentPlayer);
      STATE.busy = false;
      render();
      maybeRunCpuTurn();
    } catch (e) {
      STATE.busy = false;
      handleError(e);
      render();
    }
  }

  function humanKnock() {
    try {
      if (STATE.handOver) return;
      if (STATE.currentPlayer !== 0) return;
      if (STATE.busy) return;
      if (STATE.phase !== 'mustDraw') return;
      if (gameOptions.noKnock) {
        logLine('Drop is disabled (No Knock enabled).');
        return;
      }
      logLine('You drop. Revealing hands...');
      settleDrop(0);
      endHand({ kind: 'drop', by: 0 });
    } catch (e) {
      handleError(e);
    }
  }

  function stockEmptyHandling(pName) {
    if (!gameOptions.noKnock) {
      logLine('Stock empty — ending hand.');
      settleStockOut();
      endHand({ kind: 'stockout', by: -1 });
      return 'ended';
    }

    if (topDiscard()) {
      logLine('Stock empty — must take discard.');
      return 'must_take_discard';
    }

    logLine('Stock empty and discard empty — hand is dead.');
    endHand({ kind: 'dead', by: -1 });
    return 'dead';
  }

  function cpuChooseDrawSource(pIdx) {
    const p = STATE.players[pIdx];
    const d = topDiscard();
    if (!d) return 'deck';

    const base = bestDeadwood(p.hand).deadwood;
    const handWithDiscard = [...p.hand, d];
    let bestAfterTake = Infinity;
    for (const c of handWithDiscard) {
      const remaining = handWithDiscard.filter((x) => x.id !== c.id);
      const dw = bestDeadwood(remaining).deadwood;
      if (dw < bestAfterTake) bestAfterTake = dw;
    }

    const improvement = base - bestAfterTake;
    if (bestAfterTake === 0) return 'discard';
    if (improvement >= 2) return 'discard';

    const wouldEnableKnock = bestAfterTake <= CONFIG.knockThreshold;
    if (wouldEnableKnock && base > CONFIG.knockThreshold) return 'discard';

    return 'deck';
  }

  function cpuChooseDiscardIndex(p) {
    if (p.hand.length === 0) return -1;

    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < p.hand.length; i++) {
      const remaining = p.hand.filter((_, j) => j !== i);
      const dw = bestDeadwood(remaining).deadwood;
      const high = cardValue(p.hand[i].rank) / 10;
      const score = dw - high * 0.08;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function cpuMaybeMeldReveal(pIdx) {
    const p = STATE.players[pIdx];
    updateRevealedMeldsForPlayer(p);
  }

  async function cpuTurn(pIdx) {
    try {
      if (STATE.handOver) return;
      const p = STATE.players[pIdx];
      if (!p || p.isHuman) return;
      if (!p.playing) {
        STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
        STATE.busy = false;
        render();
        maybeRunCpuTurn();
        return;
      }

      if (STATE.busy) return;
      STATE.busy = true;
      render();

      if (STATE.phase !== 'mustDraw') {
        logLine(`${p.name}: unexpected phase state. Forcing phase to mustDraw.`);
        STATE.phase = 'mustDraw';
      }

      if (!gameOptions.noKnock) {
        const ptsStart = handPoints(p.hand);
        if (ptsStart <= 7) {
          logLine(`${p.name} drops.`);
          STATE.busy = false;
          render();
          settleDrop(pIdx);
          endHand({ kind: 'drop', by: pIdx });
          return;
        }
      }

      const cpuHandEl = getHandElByPlayerIndex(pIdx);

      let source = cpuChooseDrawSource(pIdx);
      if (gameOptions.noKnock && STATE.deck.length === 0 && source === 'deck') source = 'discard';
      let drawn = null;
      if (source === 'discard') {
        const td = topDiscard();
        drawn = drawFromDiscard(p);
        if (!drawn) {
          drawn = drawFromDeck(p);
          logLine(`${p.name} tried to take discard but it was empty; drew from deck.`);
          render();
          await animateFlyCard(UI.drawPileCard, cpuHandEl, '', true);
        } else {
          logLine(`${p.name} took discard ${td ? cardText(td) : ''}.`);
          render();
          await animateFlyCard(UI.discardPileCard, cpuHandEl, td ? cardText(td) : '', false);
        }
      } else {
        drawn = drawFromDeck(p);
        if (!drawn) {
          const res = stockEmptyHandling(p.name);
          STATE.busy = false;
          render();
          if (res === 'must_take_discard') {
            const td = topDiscard();
            const fallback = drawFromDiscard(p);
            if (fallback) {
              drawn = fallback;
              logLine(`${p.name} took discard ${td ? cardText(td) : ''}.`);
              render();
              await animateFlyCard(UI.discardPileCard, cpuHandEl, td ? cardText(td) : '', false);
            }
          }
          if (!drawn) return;
        } else {
          logLine(`${p.name} drew from deck.`);
          render();
          await animateFlyCard(UI.drawPileCard, cpuHandEl, '', true);
        }
      }

      cpuPlaySpreadsAndHits(pIdx);
      render();
      await sleep(actionDelayMs());

      if (checkEmptyHandWin(pIdx, false)) return;

      STATE.phase = 'mustDiscard';
      render();

      const discardIdx = cpuChooseDiscardIndex(p);
      if (discardIdx < 0 || discardIdx >= p.hand.length) {
        logLine(`${p.name} could not pick a discard. (AI issue)`);
        STATE.phase = 'mustDraw';
        endTurnTimer(pIdx);
        STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
        startTurnTimer(STATE.currentPlayer);
        STATE.busy = false;
        render();
        maybeRunCpuTurn();
        return;
      }

      const removed = p.hand.splice(discardIdx, 1)[0];
      if (removed) {
        discardCard(p, removed);
        logLine(`${p.name} discarded ${cardText(removed)}.`);
        render();
        await animateFlyCard(cpuHandEl, UI.discardPileCard, cardText(removed), false);
      }

      if (p.hand.length === 0) {
        STATE.busy = false;
        render();
        checkEmptyHandWin(pIdx, true);
        return;
      }

      cpuMaybeMeldReveal(pIdx);
      render();
      await sleep(actionDelayMs());

      STATE.phase = 'mustDraw';
      endTurnTimer(pIdx);
      STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
      startTurnTimer(STATE.currentPlayer);
      STATE.busy = false;
      render();
      maybeRunCpuTurn();
    } catch (e) {
      handleError(e);
      STATE.phase = 'mustDraw';
      endTurnTimer(pIdx);
      STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
      startTurnTimer(STATE.currentPlayer);
      STATE.busy = false;
      render();
      maybeRunCpuTurn();
    }
  }

  function maybeRunCpuTurn() {
    if (STATE.handOver) return;
    const p = currentPlayer();
    if (p.isHuman) {
      if (!p.playing) {
        STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
        render();
        maybeRunCpuTurn();
      }
      return;
    }
    if (!p.playing) {
      STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
      render();
      maybeRunCpuTurn();
      return;
    }
    setTimeout(() => {
      try {
        const res = cpuTurn(STATE.currentPlayer);
        if (res && typeof res.then === 'function') {
          res.catch((e) => {
            handleError(e);
            STATE.phase = 'mustDraw';
            STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
            STATE.busy = false;
            render();
            maybeRunCpuTurn();
          });
        }
      } catch (e) {
        handleError(e);
        STATE.phase = 'mustDraw';
        STATE.currentPlayer = nextParticipatingIndex(STATE.currentPlayer);
        STATE.busy = false;
        render();
        maybeRunCpuTurn();
      }
    }, CONFIG.cpuThinkMs);
  }

  function showdownScores() {
    const results = [];
    for (let i = 0; i < STATE.players.length; i++) {
      const p = STATE.players[i];
      const res = bestDeadwood(p.hand);
      const melds = res.meldMasks.map((mask) => {
        const meldCards = [];
        for (let j = 0; j < p.hand.length; j++) {
          if (mask & (1 << j)) meldCards.push(cloneCard(p.hand[j]));
        }
        const val = validateMeld(meldCards);
        return { type: val.ok ? val.type : 'meld', cards: sortedByRankThenSuit(meldCards) };
      });
      results.push({ idx: i, name: p.name, deadwood: res.deadwood, melds });
    }
    return results;
  }

  function endHand(reason) {
    if (STATE.handOver) return;
    endTurnTimer(STATE.currentPlayer);
    STATE.handOver = true;
    STATE.phase = 'mustDraw';
    STATE.pendingKnock = false;
    STATE.busy = false;
    STATE.dealing = false;
    clearSelection();

    if (reason && (reason.kind === 'empty' || reason.kind === 'immediate')) {
      STATE.winnerIndex = Number.isInteger(reason.by) && reason.by >= 0 ? reason.by : null;
    }

    if (reason && (reason.kind === 'immediate-draw' || reason.kind === 'dead')) {
      STATE.winnerIndex = null;
    }

    if (reason.kind === 'stockout' || reason.kind === 'dead' || reason.kind === 'drop' || reason.kind === 'empty' || reason.kind === 'immediate' || reason.kind === 'immediate-draw') {
      rotateDealer();
      updateSortModeLabel();
      render();
      return;
    }

    rotateDealer();
    updateSortModeLabel();
    render();
  }

  function handleError(e) {
    STATE.lastError = e;
    const msg = e && e.message ? e.message : String(e);
    logLine(`Rule edge case / error: ${msg}`);
  }

  function startNewHand() {
    (async () => {
      try {
        if (NET.connected) {
          multiplayerSendAction('NEW_HAND');
          return;
        }
        if (!STATE.handOver && (STATE.deck.length || STATE.discard.length)) return;
        if (!STATE.players.length) initPlayers();
        syncParticipationFromUi();
        if (participatingCount() < 2) {
          render();
          return;
        }
        UI.log.innerHTML = '';
        resetHandState();
        updateSortModeLabel();
        syncOptionsFromUi();
        await dealNewHand();
      } catch (e) {
        handleError(e);
        STATE.busy = false;
        STATE.dealing = false;
        render();
      }
    })();
  }

  function cancelHumanHandReorder(pointerId, shouldRender, resetSuppressClick) {
    if (STATE.drag.placeholderEl) STATE.drag.placeholderEl.remove();
    if (STATE.drag.floatingEl) STATE.drag.floatingEl.remove();

    STATE.drag.active = false;
    STATE.drag.dragging = false;
    STATE.drag.pointerId = null;
    STATE.drag.cardId = null;
    STATE.drag.fromIndex = -1;
    STATE.drag.placeholderIndex = -1;
    STATE.drag.floatingEl = null;
    STATE.drag.placeholderEl = null;
    STATE.drag.sourceEl = null;
    STATE.drag.sourceRect = null;
    if (resetSuppressClick) STATE.drag.suppressClick = false;

    if (pointerId != null) {
      try {
        UI.humanHand.releasePointerCapture(pointerId);
      } catch (_) {}
    }

    if (shouldRender) render();
  }

  UI.humanHand.addEventListener('pointermove', (ev) => {
    try {
      if (!STATE.drag.active) return;
      if (STATE.busy) return;
      if (ev.pointerId !== STATE.drag.pointerId) return;

      const dx = ev.clientX - STATE.drag.startX;
      const dy = ev.clientY - STATE.drag.startY;
      const dist = Math.hypot(dx, dy);
      if (!STATE.drag.dragging && dist < CONFIG.dragThresholdPx) return;

      if (!STATE.drag.dragging) {
        const sourceEl = STATE.drag.sourceEl;
        const rect = STATE.drag.sourceRect;
        if (!sourceEl || !rect) return;
        if (!UI.humanHand.contains(sourceEl)) return;

        const ph = document.createElement('div');
        ph.className = 'handPlaceholder';
        STATE.drag.placeholderEl = ph;

        UI.humanHand.insertBefore(ph, sourceEl);
        sourceEl.remove();

        const float = sourceEl.cloneNode(true);
        float.className = sourceEl.className + ' dragging';
        float.style.position = 'fixed';
        float.style.left = `${rect.left}px`;
        float.style.top = `${rect.top}px`;
        float.style.width = `${rect.width}px`;
        float.style.height = `${rect.height}px`;
        float.style.margin = '0';
        float.style.transform = 'none';
        float.style.pointerEvents = 'none';
        UI.fxLayer.appendChild(float);
        STATE.drag.floatingEl = float;

        STATE.drag.dragging = true;
        STATE.drag.suppressClick = true;
      }

      if (STATE.drag.dragging) {
        ev.preventDefault();
        ev.stopPropagation();
      }

      if (STATE.drag.floatingEl) {
        STATE.drag.floatingEl.style.left = `${ev.clientX - STATE.drag.offsetX}px`;
        STATE.drag.floatingEl.style.top = `${ev.clientY - STATE.drag.offsetY}px`;
      }

      const cards = Array.from(UI.humanHand.querySelectorAll('.handCard'));
      let insertBefore = null;
      for (const node of cards) {
        const r = node.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (ev.clientX < mid) {
          insertBefore = node;
          break;
        }
      }
      if (STATE.drag.placeholderEl) {
        if (insertBefore) UI.humanHand.insertBefore(STATE.drag.placeholderEl, insertBefore);
        else UI.humanHand.appendChild(STATE.drag.placeholderEl);

        const children = Array.from(UI.humanHand.children);
        const phIndex = children.indexOf(STATE.drag.placeholderEl);
        console.log(`[DEV] drag move targetIndex=${phIndex}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

  // --- Initialization / event wiring ---
  if (UI.btnNewHand) UI.btnNewHand.addEventListener('click', startNewHand);
  if (UI.btnToggleLog) {
    UI.btnToggleLog.addEventListener('click', () => {
      STATE.ui.showLog = !STATE.ui.showLog;
      applyUiVisibility();
    });
  }
  if (UI.btnCreateMeld) {
    UI.btnCreateMeld.addEventListener('click', () => {
      if (NET.connected) multiplayerMeldFromSelection();
      else humanCreateMeld();
    });
  }
  if (UI.btnKnock) UI.btnKnock.addEventListener('click', humanKnock);
  if (UI.btnSort) {
    UI.btnSort.addEventListener('click', () => {
      if (NET.connected) sortMyHandClientSide();
      else toggleSort();
    });
  }
  if (UI.drawPile) {
    UI.drawPile.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (NET.connected) {
        const mi = mySeatIdx();
        if (mi == null) return;
        if (!canLocalUserActNow()) return;
        if (STATE.phase !== 'mustDraw') return;
        multiplayerSendAction('DRAW_DECK');
      } else {
        if (!STATE.players[0]?.playing) return;
        humanDrawFrom('deck');
      }
    });
  }
  if (UI.discardPile) {
    UI.discardPile.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (NET.connected) {
        const mi = mySeatIdx();
        if (mi == null) return;
        if (!canLocalUserActNow()) return;
        if (STATE.phase !== 'mustDraw') return;
        multiplayerSendAction('DRAW_DISCARD');
      } else {
        if (!STATE.players[0]?.playing) return;
        humanDrawFrom('discard');
      }
    });
  }

  document.addEventListener('dblclick', (ev) => {
    try {
      if (!(ev.target instanceof HTMLElement)) return;
      const cardEl = ev.target.closest('.handCard');
      if (!cardEl) return;
      const uid = cardEl.dataset.uid || cardEl.dataset.cardId;
      if (!uid) return;

      if (!NET.connected) return;
      const mi = mySeatIdx();
      if (mi == null) return;
      if (!canLocalUserActNow()) return;
      if (STATE.phase !== 'mustDiscard') return;

      const myHandEl = getHandElByPlayerIndex(mi);
      if (!myHandEl || !myHandEl.contains(cardEl)) return;

      multiplayerSendAction('DISCARD', { cardId: uid });
    } catch (e) {
      handleError(e);
    }
  });

  document.addEventListener('click', (ev) => {
    try {
      if (!NET.connected) return;
      if (!(ev.target instanceof HTMLElement)) return;
      const cardEl = ev.target.closest('.handCard');
      if (!cardEl) return;
      const uid = cardEl.dataset.uid || cardEl.dataset.cardId;
      if (!uid) return;

      const mi = mySeatIdx();
      if (mi == null) return;
      const myHandEl = getHandElByPlayerIndex(mi);
      if (!myHandEl || !myHandEl.contains(cardEl)) return;
      if (!canLocalUserSelectCards()) return;

      toggleSelected(uid);
    } catch (e) {
      handleError(e);
    }
  });

  document.addEventListener('click', (ev) => {
    try {
      if (!NET.connected) return;
      if (!(ev.target instanceof HTMLElement)) return;
      const meldEl = ev.target.closest('.meld');
      if (!meldEl) return;
      const seat = mySeatInfo();
      if (!seat || seat.mode !== 'human') return;
      if (!canLocalUserActNow()) return;

      const os = Number(meldEl.dataset.ownerSeatIdx);
      const mi = Number(meldEl.dataset.meldIndex);
      if (!Number.isInteger(os) || !Number.isInteger(mi)) return;

      const cur = STATE.selectedMeldTarget;
      if (cur && cur.ownerSeatIdx === os && cur.meldIndex === mi) STATE.selectedMeldTarget = null;
      else STATE.selectedMeldTarget = { ownerSeatIdx: os, meldIndex: mi };
      render();
    } catch (e) {
      handleError(e);
    }
  });

  const foldBtns = [UI.btnFold0, UI.btnFold1, UI.btnFold2, UI.btnFold3, UI.btnFold4];
  for (let i = 0; i < foldBtns.length; i++) {
    const b = foldBtns[i];
    if (!b) continue;
    b.addEventListener('click', () => {
      if (NET.connected) {
        // Only your claimed seat can fold.
        if (NET.mySeatIdx !== i) return;
        multiplayerSendAction('FOLD');
      } else {
        // Local fallback: mark sitting out.
        if (STATE.players[i]) STATE.players[i].playing = false;
        render();
      }
    });
  }

  const seatChoices = [UI.seatChoiceAndy, UI.seatChoiceBilly, UI.seatChoiceButch, UI.seatChoiceCurt, UI.seatChoiceMark];
  for (const b of seatChoices) {
    if (!b) continue;
    b.addEventListener('click', () => {
      const name = b.getAttribute('data-seat-name');
      requestClaimSeat(name);
    });
  }

  const playChecks = [UI.optPlay0, UI.optPlay1, UI.optPlay2, UI.optPlay3, UI.optPlay4];
  for (let i = 0; i < playChecks.length; i++) {
    const el = playChecks[i];
    if (!el) continue;

    el.addEventListener('click', (ev) => {
      try {
        if (NET.connected) {
          ev.preventDefault();
          if (NET.mySeatIdx !== i) {
            updateModeControlsFromServer();
            return;
          }
          cycleMySeatModeAndSend();
          return;
        }

        // Local fallback.
        setTimeout(() => {
          syncParticipationFromUi();
          render();
        }, 0);
      } catch (e) {
        handleError(e);
      }
    });
  }

  (function ensureResetButton() {
    try {
      const parent = document.getElementById('centerControls');
      if (!parent) return;
      if (document.getElementById('btnResetGame')) return;
      const btn = document.createElement('button');
      btn.id = 'btnResetGame';
      btn.textContent = 'Reset Game';
      btn.style.display = 'none';
      btn.addEventListener('click', () => {
        if (!NET.connected) return;
        multiplayerSendAction('RESET_ROOM');
      });
      parent.appendChild(btn);

      UI.btnResetGame = btn;
    } catch (e) {
      handleError(e);
    }
  })();

  if (!STATE.players.length) initPlayers();
  logLine('App loaded');
  console.log('Init OK');

  UI.humanHand.addEventListener('pointercancel', (ev) => {
    try {
      if (!STATE.drag.active) return;
      if (ev.pointerId !== STATE.drag.pointerId) return;

      console.log('[DEV] drag cancel');
      cancelHumanHandReorder(ev.pointerId, true, true);
    } catch (e) {
      handleError(e);
    }
  });

  UI.humanHand.addEventListener('pointerup', (ev) => {
    try {
      if (!STATE.drag.active) return;
      if (ev.pointerId !== STATE.drag.pointerId) return;

      console.log('[DEV] drag up');

      const uid = STATE.drag.cardId;
      const now = performance.now();
      const dt = now - (lastTapTime || 0);
      console.log('tap', uid, 'dragged?', STATE.drag.dragging, 'dt', dt);

      const human = STATE.players[0];

      if (STATE.drag.dragging && STATE.drag.placeholderEl) {
        const children = Array.from(UI.humanHand.children);
        const phIndex = children.indexOf(STATE.drag.placeholderEl);
        const fromIdx = STATE.drag.fromIndex;
        const toIdx = phIndex;

        STATE.drag.placeholderEl.remove();
        if (STATE.drag.floatingEl) STATE.drag.floatingEl.remove();

        moveCardInHand(human, fromIdx, toIdx);
        STATE.drag.suppressClick = true;
        render();
      } else {
        const pointerType = ev.pointerType || 'unknown';

        if (uid) {
          if (lastTapUid === uid && dt <= 320) {
            lastTapUid = null;
            lastTapTime = 0;
            lastTapPointerType = null;
            discardHumanCardByUid(uid);
          } else {
            lastTapUid = uid;
            lastTapTime = now;
            lastTapPointerType = pointerType;
            if (!STATE.handOver && !STATE.busy && STATE.currentPlayer === 0 && !STATE.drag.suppressClick) {
              toggleSelected(uid);
            }
          }
        }

        STATE.drag.suppressClick = false;
      }

      if (STATE.drag.suppressClick) {
        setTimeout(() => {
          STATE.drag.suppressClick = false;
        }, 0);
      }

      // Only prevent default if we actually dragged. This keeps native dblclick working.
      if (STATE.drag.dragging) {
        ev.preventDefault();
        ev.stopPropagation();
      }

      // Keep suppressClick true briefly after a drag to prevent accidental click/dblclick.
      cancelHumanHandReorder(ev.pointerId, false, false);
    } catch (e) {
      handleError(e);
    }
  });

  STATE.handOver = true;
  applyUiVisibility();
  connectMultiplayer();
  render();
})();
