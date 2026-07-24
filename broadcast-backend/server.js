const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Shared state — single source of truth for every connected overlay/control page.
// All sports' fields live side by side in one object (instead of being wiped
// on switch) so flipping the sport tab never loses in-progress game state.
// ---------------------------------------------------------------------------
let state = {
  sport: 'soccer', // soccer | basketball | volleyball | baseball | softball
  mode: 'off', // off | scorebug | matchup | halftime | break
  home: 'HOME',
  away: 'AWAY',
  homeColor: '#1F5FAE',
  awayColor: '#B3232E',
  homeLogo: '',
  awayLogo: '',
  homeScore: 0,
  awayScore: 0,
  league: 'SRV Conference',
  event: 'Regular Season',
  homeRecord: '0-0',
  awayRecord: '0-0',
  kickoff: '7:00 PM',

  // Game clock — shared engine used by soccer + basketball. Rather than
  // ticking on the server, we store an anchor timestamp + direction and let
  // every connected client compute the live value from Date.now(), the same
  // trick already used for the halftime countdown below.
  clockSeconds: 0,
  clockRunning: false,
  clockAnchorMs: null, // server epoch ms when the clock was last (re)started
  clockDirection: 'down', // 'down' | 'up'

  // Soccer
  half: '1st Half',

  // Basketball
  quarter: 'Q1',
  fouls: { home: 0, away: 0 },
  timeouts: { home: 5, away: 5 },

  // Volleyball
  volleyballSet: 1,
  setsWon: { home: 0, away: 0 },
  servingSide: 'home',

  // Baseball / Softball (shared fields — same sport mechanically)
  inning: 1,
  inningHalf: 'Top', // 'Top' | 'Bottom'
  outs: 0,
  balls: 0,
  strikes: 0,
  bases: { first: false, second: false, third: false },

  // Break screen
  breakMode: 'brb', // timeout | brb | sponsor
  breakTitle: "We'll Be Right Back",
  sponsor: 'Sponsor Name',
  sponsorTag: 'Thanks for supporting local sports',
  footer: 'LIVE COVERAGE',
  qr: '',

  // Halftime/intermission countdown, same fixed-end-time trick as the clock.
  halftimeEndsAt: null, // epoch ms

  // Scorebug position/size on the overlay canvas, adjustable via the overlay
  // page's own edit mode. x/y are pixel offsets from the default centered
  // position; scale is a uniform multiplier. {0,0,1} reproduces the default.
  scorebugLayout: { x: 0, y: 0, scale: 1 }
};

function broadcastState() {
  const msg = JSON.stringify({ type: 'STATE', state });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

function broadcastEvent(event) {
  const msg = JSON.stringify({ type: 'EVENT', event });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Resolves the game clock to a concrete integer-second value *right now*,
// whether it's running (computed from the anchor) or paused (stored as-is).
function currentClockSeconds() {
  if (!state.clockRunning || state.clockAnchorMs == null) return state.clockSeconds;
  const elapsed = (Date.now() - state.clockAnchorMs) / 1000;
  const value = state.clockDirection === 'down'
    ? state.clockSeconds - elapsed
    : state.clockSeconds + elapsed;
  return Math.max(0, value);
}

// Ends the current half-inning: clears the count, flips Top/Bottom, and
// advances the inning number once play returns to the top.
function endHalfInning() {
  state.outs = 0;
  state.balls = 0;
  state.strikes = 0;
  state.bases = { first: false, second: false, third: false };
  if (state.inningHalf === 'Top') {
    state.inningHalf = 'Bottom';
  } else {
    state.inningHalf = 'Top';
    state.inning += 1;
  }
}

// ---------------------------------------------------------------------------
// Action reducer — every control-panel button press sends one of these.
// ---------------------------------------------------------------------------
function applyAction(action) {
  switch (action.type) {
    case 'SET_SPORT':
      state.sport = action.sport;
      break;

    case 'SET_MODE':
      state.mode = action.mode;
      break;

    case 'SCORE_DELTA': {
      const key = action.side === 'home' ? 'homeScore' : 'awayScore';
      state[key] = Math.max(0, state[key] + action.delta);
      if (action.delta > 0) broadcastEvent({ type: 'SCORE', side: action.side, delta: action.delta });
      break;
    }

    case 'RESET_SCORES':
      state.homeScore = 0;
      state.awayScore = 0;
      break;

    // ---------------- Game clock (soccer + basketball) ----------------
    case 'SET_CLOCK':
      state.clockSeconds = Math.max(0, Math.round(action.seconds));
      state.clockRunning = false;
      state.clockAnchorMs = null;
      break;

    case 'START_CLOCK':
      if (!state.clockRunning) {
        state.clockRunning = true;
        state.clockAnchorMs = Date.now();
      }
      break;

    case 'PAUSE_CLOCK':
      if (state.clockRunning) {
        state.clockSeconds = Math.round(currentClockSeconds());
        state.clockRunning = false;
        state.clockAnchorMs = null;
      }
      break;

    case 'SET_CLOCK_DIRECTION':
      // Freeze the current value first so switching direction mid-run
      // doesn't jump the clock.
      state.clockSeconds = Math.round(currentClockSeconds());
      state.clockDirection = action.direction;
      if (state.clockRunning) state.clockAnchorMs = Date.now();
      break;

    case 'SET_HALF':
      state.half = action.text;
      break;

    case 'START_HALFTIME_TIMER':
      state.halftimeEndsAt = Date.now() + action.seconds * 1000;
      break;

    // ---------------- Basketball ----------------
    case 'SET_QUARTER':
      state.quarter = action.quarter;
      break;

    case 'FOUL_DELTA':
      state.fouls[action.side] = Math.max(0, state.fouls[action.side] + action.delta);
      break;

    case 'TIMEOUT_DELTA':
      state.timeouts[action.side] = Math.max(0, state.timeouts[action.side] + action.delta);
      break;

    // ---------------- Volleyball ----------------
    case 'SET_VOLLEYBALL_SET':
      state.volleyballSet = action.set;
      break;

    case 'SETS_WON_DELTA':
      state.setsWon[action.side] = Math.max(0, state.setsWon[action.side] + action.delta);
      break;

    case 'SET_SERVE':
      state.servingSide = action.side;
      break;

    // ---------------- Baseball / Softball ----------------
    case 'BB_BALL':
      if (state.balls >= 3) {
        // walk — batter takes first, count resets
        state.balls = 0;
        state.strikes = 0;
      } else {
        state.balls += 1;
      }
      break;

    case 'BB_STRIKE':
      if (state.strikes >= 2) {
        // strikeout
        state.strikes = 0;
        state.balls = 0;
        state.outs += 1;
        if (state.outs >= 3) endHalfInning();
      } else {
        state.strikes += 1;
      }
      break;

    case 'OUT_DELTA':
      state.outs = Math.max(0, state.outs + action.delta);
      if (action.delta > 0) {
        state.balls = 0;
        state.strikes = 0;
        if (state.outs >= 3) endHalfInning();
      }
      break;

    case 'BB_RESET_COUNT':
      state.balls = 0;
      state.strikes = 0;
      break;

    case 'SET_INNING':
      state.inning = Math.max(1, action.inning);
      state.inningHalf = action.half;
      state.outs = 0;
      state.balls = 0;
      state.strikes = 0;
      state.bases = { first: false, second: false, third: false };
      break;

    case 'TOGGLE_BASE':
      state.bases[action.base] = !state.bases[action.base];
      break;

    case 'SET_SCOREBUG_LAYOUT':
      state.scorebugLayout = { x: action.x, y: action.y, scale: action.scale };
      break;

    case 'RESET_SCOREBUG_LAYOUT':
      state.scorebugLayout = { x: 0, y: 0, scale: 1 };
      break;

    case 'UPDATE_TEAMS':
      Object.assign(state, action.data);
      break;

    case 'UPDATE_BREAK':
      Object.assign(state, action.data);
      break;

    default:
      console.warn('Unknown action', action);
      return;
  }
  broadcastState();
}

wss.on('connection', (ws) => {
  // send current state immediately so a freshly-opened overlay/control page
  // is in sync without waiting for the next change.
  ws.send(JSON.stringify({ type: 'STATE', state }));

  ws.on('message', (raw) => {
    let action;
    try {
      action = JSON.parse(raw);
    } catch (e) {
      return;
    }
    applyAction(action);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Broadcast control server running on http://localhost:${PORT}`);
  console.log(`  Overlay:  http://localhost:${PORT}/overlay.html`);
  console.log(`  Control:  http://localhost:${PORT}/control.html`);
});
