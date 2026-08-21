const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Shared state — single source of truth for every connected overlay/control page.
// All sports' fields live side by side in one object (instead of being wiped
// on switch) so flipping the sport tab never loses in-progress game state.
// ---------------------------------------------------------------------------
const DEFAULT_STATE = {
  sport: 'soccer', // soccer | basketball | volleyball | baseball | softball
  mode: 'off', // off | scorebug | matchup | halftime | break
  // EAC is always the home side, so its identity is baked in as the default
  // here instead of being typed into the control panel every gameday.
  home: 'EAC',
  away: 'AWAY',
  // Full names shown as small text under the big abbreviation in the
  // scorebug, so long opponent names don't force the abbreviation to shrink
  // or the two sides of the bug to go lopsided.
  homeFullName: 'Eastern Arizona College',
  awayFullName: '',
  homeColor: '#4B1E78', // EAC purple — adjust to match brand exactly if needed
  awayColor: '#B3232E',
  homeLogo: '/logos/eac.png',
  awayLogo: '',
  // Crest badge backing behind a logo image — a plain white or black matte
  // reads far better than the team color, which fights with whatever's in
  // the logo itself. Operator-toggleable per side in the control panel.
  homeLogoBg: '#FFFFFF',
  awayLogoBg: '#FFFFFF',
  homeScore: 0,
  awayScore: 0,
  league: 'Arizona Community College Athletic Conference (ACCAC)',
  division: 'NJCAA Division I',
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
  // When false, the overlay hides the clock readout and shows an empty
  // placeholder in its place instead — for games where we point a camera at
  // the venue's physical scoreboard rather than keeping our own clock.
  clockVisible: true,

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
  // Box score — final score for each *completed* set, keyed by set number
  // ("1".."5"). Populated by VOLLEYBALL_NEXT_SET when the operator locks in
  // a set (or hand-edited via SET_VOLLEYBALL_SET_SCORE for corrections).
  // The in-progress set isn't stored here — its live score is just
  // homeScore/awayScore, same as always.
  volleyballSetScores: {},

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
  // Which timer preset is currently armed (e.g. 180 for volleyball's 3:00
  // between-sets break, or 75 for a 1:15 timeout). Tapping the halftime/
  // "Set Break" live-scene button (re)starts halftimeEndsAt from this value,
  // so a single tap both cuts to the break scene and starts its countdown.
  intermissionSelectedSeconds: null,

  // Scorebug position/size on the overlay canvas, adjustable via the overlay
  // page's own edit mode. x/y are pixel offsets from the default centered
  // position; scale is a uniform multiplier. {0,0,1} reproduces the default.
  scoreFlashPosition: 'top',
  scorebugLayout: { x: 0, y: 0, scale: 1 }
};

// Persistence layer — load/save state to disk so process restarts don't
// wipe all in-game data.
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let saveTimer = null;

function loadState() {
  const base = JSON.parse(JSON.stringify(DEFAULT_STATE));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Could not create data directory, starting with defaults:', e);
    return base;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    return Object.assign(base, loaded);
  } catch (e) {
    console.warn('No valid saved state found, starting with defaults:', e.message);
    return base;
  }
}

let state = loadState();

// Fallback timer length when the halftime/"Set Break" scene is cut to
// without an explicit preset armed first (e.g. right after switching sport).
const DEFAULT_INTERMISSION_SECONDS = {
  soccer: 900, basketball: 900, volleyball: 180, baseball: 900, softball: 900
};

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATE_FILE, JSON.stringify(state), (err) => {
      if (err) console.error('Failed to persist state:', err);
    });
  }, 750);
}

function broadcastState() {
  const msg = JSON.stringify({ type: 'STATE', state });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
  scheduleSave();
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
      // Cutting to the halftime/"Set Break" scene (re)starts its countdown
      // from whatever preset is armed, every time — so the operator never
      // has to separately start a timer, and re-tapping the scene button
      // (e.g. for the next set's break) always resets the clock.
      if (action.mode === 'halftime') {
        const seconds = state.intermissionSelectedSeconds || DEFAULT_INTERMISSION_SECONDS[state.sport] || 900;
        state.intermissionSelectedSeconds = seconds;
        state.halftimeEndsAt = Date.now() + seconds * 1000;
      }
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

    // Full game reset — for back-to-back games on the same sport. Clears
    // score, clock, and every sport-specific in-game field, but leaves team
    // identity (names/colors/logos/records) and league/event info alone
    // since those usually carry over or get set once per broadcast.
    case 'FULL_RESET': {
      const sport = action.sport || state.sport;

      state.homeScore = 0;
      state.awayScore = 0;

      state.clockSeconds = 0;
      state.clockRunning = false;
      state.clockAnchorMs = null;
      state.clockDirection = 'down';

      if (sport === 'soccer') {
        state.half = '1st Half';
      } else if (sport === 'basketball') {
        state.quarter = 'Q1';
        state.fouls = { home: 0, away: 0 };
        state.timeouts = { home: 5, away: 5 };
      } else if (sport === 'volleyball') {
        state.volleyballSet = 1;
        state.setsWon = { home: 0, away: 0 };
        state.servingSide = 'home';
        state.volleyballSetScores = {};
      } else if (sport === 'baseball' || sport === 'softball') {
        state.inning = 1;
        state.inningHalf = 'Top';
        state.outs = 0;
        state.balls = 0;
        state.strikes = 0;
        state.bases = { first: false, second: false, third: false };
      }
      break;
    }

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

    case 'SET_CLOCK_VISIBLE':
      state.clockVisible = !!action.visible;
      break;

    case 'SET_HALF':
      state.half = action.text;
      break;

    case 'START_HALFTIME_TIMER':
      state.halftimeEndsAt = Date.now() + action.seconds * 1000;
      // Keep the preset highlight in sync: a custom duration shouldn't leave
      // a stale preset button lit up as if it were the one running.
      state.intermissionSelectedSeconds = Math.max(1, Math.round(action.seconds));
      break;

    case 'SELECT_INTERMISSION_TIMER':
      state.intermissionSelectedSeconds = Math.max(1, Math.round(action.seconds));
      // If the break scene is already live, switching presets should restart
      // the on-air countdown right away rather than waiting for another tap.
      if (state.mode === 'halftime') {
        state.halftimeEndsAt = Date.now() + state.intermissionSelectedSeconds * 1000;
      }
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

    // Locks the current live score in as the just-finished set's box-score
    // entry, tallies the set win, and starts the next set at 0-0 — the
    // single-tap version of what used to be three separate operator actions
    // (reset score, bump sets won, change set number).
    case 'VOLLEYBALL_NEXT_SET': {
      const setNum = state.volleyballSet;
      state.volleyballSetScores[setNum] = { home: state.homeScore, away: state.awayScore };
      if (state.homeScore > state.awayScore) state.setsWon.home += 1;
      else if (state.awayScore > state.homeScore) state.setsWon.away += 1;
      state.homeScore = 0;
      state.awayScore = 0;
      state.volleyballSet = Math.min(5, state.volleyballSet + 1);
      break;
    }

    // Manual correction for a single box-score cell (e.g. Next Set was
    // tapped a beat late, or a set needs backfilling by hand).
    case 'SET_VOLLEYBALL_SET_SCORE': {
      const entry = state.volleyballSetScores[action.set] || { home: 0, away: 0 };
      entry[action.side] = Math.max(0, Math.round(action.value));
      state.volleyballSetScores[action.set] = entry;
      break;
    }

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

    case 'SET_SCORE_FLASH_POSITION':
      state.scoreFlashPosition = action.position === 'bottom' ? 'bottom' : 'top';
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

function flushStateSync() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to persist state on shutdown:', e);
  }
}

// Graceful shutdown — flush any pending writes before exit.
process.on('SIGINT', () => { flushStateSync(); process.exit(0); });
process.on('SIGTERM', () => { flushStateSync(); process.exit(0); });

// Crash resilience — unhandled errors don't crash the process (which would
// trigger Render to restart and wipe in-memory state before the next boot
// has a chance to load from disk). All applyAction cases are simple
// synchronous field assignments, so the tradeoff (continuing after an
// unknown error) is reasonable — state can't be left half-updated.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process staying up):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process staying up):', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Broadcast control server running on http://localhost:${PORT}`);
  console.log(`  Overlay:  http://localhost:${PORT}/overlay.html`);
  console.log(`  Control:  http://localhost:${PORT}/control.html`);
});
