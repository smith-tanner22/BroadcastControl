const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const VOLLEYBALL_BETWEEN_SETS_SECONDS = 180;
const VOLLEYBALL_TIMEOUT_SECONDS = 75;

// Fallback timer length when a non-volleyball intermission scene is cut to.
// Volleyball is explicit: Set Break is always 3:00, Timeout is always 1:15.
const DEFAULT_INTERMISSION_SECONDS = {
  soccer: 900,
  basketball: 900,
  volleyball: VOLLEYBALL_TIMEOUT_SECONDS,
  baseball: 900,
  softball: 900
};

// ---------------------------------------------------------------------------
// Shared state — single source of truth for every connected overlay/control page.
// All sports' fields live side by side in one object (instead of being wiped
// on switch) so flipping the sport tab never loses in-progress game state.
// ---------------------------------------------------------------------------
const DEFAULT_STATE = {
  sport: 'soccer', // soccer | basketball | volleyball | baseball | softball
  mode: 'scorebug', // off | scorebug | matchup | halftime | timeout | water | final
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
  kickoff: '7:00 PM',

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

  // Guest bug — persisted so the operator types it once and can re-trigger
  // the on-air pulse repeatedly without retyping. The commentator bug is
  // hardcoded client-side and needs no state.
  guestName: '',
  guestTitle: '',

  // Halftime/intermission countdown, same fixed-end-time trick as the clock.
  halftimeEndsAt: null, // epoch ms
  // Last manually selected/custom intermission duration. Volleyball scene
  // buttons ignore this and start their fixed timers directly.
  intermissionSelectedSeconds: null,

  // Scorebug position/size on the overlay canvas, adjustable via the overlay
  // page's own edit mode. x/y are pixel offsets from the default centered
  // position; scale is a uniform multiplier. {0,0,1} reproduces the default.
  scoreFlashPosition: 'bottom',
  homeScoreFlashColor: '#D4AF37',
  homeScoreFlashOutline: '#000000',
  awayScoreFlashColor: '#D4AF37',
  awayScoreFlashOutline: '#000000',
  challengeBugLayout: { x: 0, y: 0 },
  scorebugLayout: { x: 0, y: 0, scale: 1 },
  // Sport-specific default positions for the scorebug — saved separately per
  // sport so switching doesn't lose the customized position for that sport.
  scorebugLayouts: {
    soccer: { x: 0, y: 0, scale: 1 },
    basketball: { x: 0, y: 0, scale: 1 },
    volleyball: { x: 0, y: 0, scale: 1 },
    baseball: { x: 0, y: 0, scale: 1 },
    softball: { x: 0, y: 0, scale: 1 }
  },
  challengeBugLayouts: {
    soccer: { x: 0, y: 0 },
    basketball: { x: 0, y: 0 },
    volleyball: { x: 0, y: 0 },
    baseball: { x: 0, y: 0 },
    softball: { x: 0, y: 0 }
  }
};

// Persistence layer — load/save state to disk so process restarts don't
// wipe all in-game data.
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let saveTimer = null;

function normalizeStateShape(s) {
  if (s.mode === 'break') s.mode = 'scorebug';
  ['breakMode', 'breakTitle', 'sponsor', 'sponsorTag', 'footer', 'qr'].forEach((key) => {
    delete s[key];
  });
  const sports = ['soccer', 'basketball', 'volleyball', 'baseball', 'softball'];
  if (!s.scorebugLayouts) s.scorebugLayouts = {};
  if (!s.challengeBugLayouts) s.challengeBugLayouts = {};
  sports.forEach((sport) => {
    s.scorebugLayouts[sport] = Object.assign({ x: 0, y: 0, scale: 1 }, s.scorebugLayouts[sport] || {});
    s.challengeBugLayouts[sport] = Object.assign({ x: 0, y: 0 }, s.challengeBugLayouts[sport] || {});
  });
  s.challengeBugLayout = Object.assign({ x: 0, y: 0 }, s.challengeBugLayout || {});
  if (!Number.isFinite(Number(s.intermissionSelectedSeconds)) || Number(s.intermissionSelectedSeconds) <= 0) {
    s.intermissionSelectedSeconds = DEFAULT_INTERMISSION_SECONDS[s.sport] || 900;
  } else {
    s.intermissionSelectedSeconds = Math.max(1, Math.round(Number(s.intermissionSelectedSeconds)));
  }
  return s;
}

function loadState() {
  const base = JSON.parse(JSON.stringify(DEFAULT_STATE));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Could not create data directory, starting with defaults:', e);
    return normalizeStateShape(base);
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    const merged = Object.assign(base, loaded);
    return normalizeStateShape(merged);
  } catch (e) {
    console.warn('No valid saved state found, starting with defaults:', e.message);
    return normalizeStateShape(base);
  }
}

let state = loadState();

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

function volleyballSetTarget(setNum) {
  return setNum >= 5 ? 15 : 25;
}

function volleyballCurrentSetWinner(homeScore, awayScore, setNum) {
  const target = volleyballSetTarget(setNum);
  if (homeScore >= target && homeScore - awayScore >= 2) return 'home';
  if (awayScore >= target && awayScore - homeScore >= 2) return 'away';
  return null;
}

function volleyballSetPointSideForScores(homeScore, awayScore, setNum) {
  if (volleyballCurrentSetWinner(homeScore, awayScore, setNum)) return null;
  const target = volleyballSetTarget(setNum);
  if (homeScore >= target - 1 && homeScore - awayScore >= 1) return 'home';
  if (awayScore >= target - 1 && awayScore - homeScore >= 1) return 'away';
  return null;
}

function volleyballMatchClincher() {
  if (state.setsWon.home >= 3 || state.setsWon.away >= 3) return null;

  const setNum = state.volleyballSet;
  const currentWinner = volleyballCurrentSetWinner(state.homeScore, state.awayScore, setNum);
  if (currentWinner && state.setsWon[currentWinner] >= 2) {
    return { side: currentWinner, finalHome: state.homeScore, finalAway: state.awayScore };
  }

  const setPointSide = volleyballSetPointSideForScores(state.homeScore, state.awayScore, setNum);
  if (!setPointSide || state.setsWon[setPointSide] < 2) return null;

  return {
    side: setPointSide,
    finalHome: state.homeScore + (setPointSide === 'home' ? 1 : 0),
    finalAway: state.awayScore + (setPointSide === 'away' ? 1 : 0)
  };
}

// ---------------------------------------------------------------------------
// Action reducer — every control-panel button press sends one of these.
// ---------------------------------------------------------------------------
function applyAction(action) {
  switch (action.type) {
    case 'SET_SPORT':
      state.sport = action.sport;
      // Load the sport-specific scorebug layout, or default if not set
	      if (state.scorebugLayouts && state.scorebugLayouts[action.sport]) {
	        state.scorebugLayout = Object.assign({}, state.scorebugLayouts[action.sport]);
	      }
	      if (state.challengeBugLayouts && state.challengeBugLayouts[action.sport]) {
	        state.challengeBugLayout = Object.assign({}, state.challengeBugLayouts[action.sport]);
	      }
	      break;

    case 'SET_MODE':
      state.mode = action.mode === 'break' ? 'scorebug' : action.mode;
      // Cutting to an intermission scene starts the clock automatically.
      // Volleyball is intentionally simple: Set Break is always 3:00 and
      // Timeout is always 1:15, with no preset arming in between.
      if (action.mode === 'halftime' || action.mode === 'timeout') {
        let seconds = DEFAULT_INTERMISSION_SECONDS[state.sport] || 900;
        if (state.sport === 'volleyball') {
          seconds = action.mode === 'timeout' ? VOLLEYBALL_TIMEOUT_SECONDS : VOLLEYBALL_BETWEEN_SETS_SECONDS;
        }
        state.intermissionSelectedSeconds = seconds;
        state.halftimeEndsAt = Date.now() + seconds * 1000;
      }
      break;

    case 'SCORE_DELTA': {
      const key = action.side === 'home' ? 'homeScore' : 'awayScore';
      state[key] = Math.max(0, state[key] + action.delta);
      if (action.delta > 0) {
        broadcastState();
        broadcastEvent({ type: 'SCORE', side: action.side, delta: action.delta });
        return;
      }
      break;
    }

    case 'RESET_SCORES':
      state.homeScore = 0;
      state.awayScore = 0;
      break;

    // Full game reset — for back-to-back games on the same sport. Clears
    // score and every sport-specific in-game field, but leaves team identity
    // (names/colors/logos) and league/event info alone since those usually
    // carry over or get set once per broadcast.
    case 'FULL_RESET': {
      const sport = action.sport || state.sport;

      state.homeScore = 0;
      state.awayScore = 0;

      // Back-to-back games usually mean a new opponent — reset the away
      // side's identity to the blank defaults so the previous opponent's
      // name/logo/color doesn't carry over. Home (always EAC) is left
      // alone: it's the broadcast's own fixed identity, not opponent-
      // dependent, so there's nothing to reset there.
      state.away = 'AWAY';
      state.awayFullName = '';
      state.awayColor = '#B3232E';
      state.awayLogo = '';
      state.awayLogoBg = '#FFFFFF';

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
        state.halftimeEndsAt = null;
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

    case 'SET_HALF':
      state.half = action.text;
      break;

    case 'START_HALFTIME_TIMER':
      state.halftimeEndsAt = Date.now() + action.seconds * 1000;
      // Remember the latest custom duration for non-volleyball intermission
      // scenes. Volleyball's Set Break/Timeout buttons override this.
      state.intermissionSelectedSeconds = Math.max(1, Math.round(action.seconds));
      break;

    case 'SELECT_INTERMISSION_TIMER':
      state.intermissionSelectedSeconds = Math.max(1, Math.round(action.seconds));
      // Compatibility for older control pages that still send preset picks.
      if (state.mode === 'halftime' || state.mode === 'timeout') {
        state.halftimeEndsAt = Date.now() + state.intermissionSelectedSeconds * 1000;
      }
      break;

    // Explicit stop for the operator's timer controls —
    // separate from cutting away from the scene, since the countdown should
    // be pauseable without also having to leave Set Break/Timeout on air.
    case 'STOP_HALFTIME_TIMER':
      state.halftimeEndsAt = null;
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

    case 'VOLLEYBALL_END_MATCH': {
      const clincher = volleyballMatchClincher();
      if (!clincher) break;

      const setNum = state.volleyballSet;
      state.homeScore = clincher.finalHome;
      state.awayScore = clincher.finalAway;
      state.volleyballSetScores[setNum] = { home: state.homeScore, away: state.awayScore };
      state.setsWon[clincher.side] = Math.max(state.setsWon[clincher.side], 3);
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

	    case 'SAVE_SCOREBUG_LAYOUT_FOR_SPORT': {
	      const sport = action.sport || state.sport;
	      if (!state.scorebugLayouts) state.scorebugLayouts = {};
	      if (!state.challengeBugLayouts) state.challengeBugLayouts = {};
	      const challengeX = Number.isFinite(action.challengeX) ? action.challengeX : state.challengeBugLayout.x;
	      const challengeY = Number.isFinite(action.challengeY) ? action.challengeY : state.challengeBugLayout.y;
	      state.scorebugLayouts[sport] = { x: action.x, y: action.y, scale: action.scale };
	      state.scorebugLayout = { x: action.x, y: action.y, scale: action.scale };
	      state.challengeBugLayouts[sport] = { x: challengeX, y: challengeY };
	      state.challengeBugLayout = { x: challengeX, y: challengeY };
	      break;
	    }

    case 'RESET_SCOREBUG_LAYOUT':
      state.scorebugLayout = { x: 0, y: 0, scale: 1 };
      break;

	    case 'RESET_SCOREBUG_LAYOUT_FOR_SPORT': {
	      const sport = action.sport || state.sport;
	      if (!state.scorebugLayouts) state.scorebugLayouts = {};
	      if (!state.challengeBugLayouts) state.challengeBugLayouts = {};
	      state.scorebugLayouts[sport] = { x: 0, y: 0, scale: 1 };
	      state.scorebugLayout = { x: 0, y: 0, scale: 1 };
	      state.challengeBugLayouts[sport] = { x: 0, y: 0 };
	      state.challengeBugLayout = { x: 0, y: 0 };
	      break;
	    }

    case 'SET_CHALLENGE_BUG_LAYOUT':
      state.challengeBugLayout = { x: action.x, y: action.y };
      break;

    case 'RESET_CHALLENGE_BUG_LAYOUT':
      state.challengeBugLayout = { x: 0, y: 0 };
      break;

    case 'SET_SCORE_FLASH_POSITION':
      state.scoreFlashPosition = action.position === 'bottom' ? 'bottom' : 'top';
      break;

    case 'UPDATE_SCORE_FLASH_STYLE':
      Object.assign(state, action.data);
      break;

    case 'UPDATE_TEAMS':
      Object.assign(state, action.data);
      break;

    case 'UPDATE_GUEST':
      Object.assign(state, action.data);
      break;

    // ---------------- Commentator / Guest bugs ----------------
    // Pure one-shot triggers — no state to mutate, so return early instead
    // of falling through to the trailing broadcastState()/save below.
    case 'SHOW_COMMENTATOR_BUG':
      broadcastEvent({ type: 'COMMENTATOR_BUG' });
      return;

    case 'SHOW_GUEST_BUG':
      broadcastEvent({ type: 'GUEST_BUG' });
      return;

    case 'SHOW_CHALLENGE_IN_PROGRESS':
      broadcastEvent({ type: 'CHALLENGE', status: 'progress' });
      return;

    case 'SHOW_CHALLENGE_SUCCESS':
      broadcastEvent({ type: 'CHALLENGE', status: 'success' });
      return;

    case 'SHOW_CHALLENGE_FAILED':
      broadcastEvent({ type: 'CHALLENGE', status: 'failed' });
      return;

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
