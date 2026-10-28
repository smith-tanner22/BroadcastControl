# Broadcast Control — Backend

Shared state server for multi-sport broadcast overlays + control panel. One `mode` and `sport` live on
the server; every connected page (the overlay feeding YoloBox, and the control
panel on your phone/tablet) stays in sync over WebSocket.

Supports soccer, basketball, volleyball, baseball, and softball with sport-specific
statistics and overlays.

## Run it

```
npm install
npm start
```

This starts a server on port 3000 (override with `PORT=8080 npm start`) serving:

- `http://<host>:3000/overlay.html` — put this URL into YoloBox Extreme's
  **Web URL Overlay** source. This is the one single overlay page — it shows
  scorebug / matchup / halftime / timeout / water break / final based on server state, nothing else
  to add.
- `http://<host>:3000/control.html` — open this on your phone or tablet during
  the game. Tap a scene button, bump the score, and it updates the overlay
  live.

## Where to run it

Both the YoloBox and whatever device you're using for control need to reach
this server, so you have two options:

1. **Same local network as the YoloBox** (simplest for gameday): run this on
   a laptop connected to the same Wi-Fi/Ethernet as the YoloBox Extreme, then
   use that laptop's local IP (e.g. `http://192.168.1.42:3000/overlay.html`)
   for the Web URL Overlay, and open the control panel on your phone on the
   same network.
2. **Cloud host** (currently deployed on Fly.io): deploy to a stable public URL
   that works from any network. Every push to `main` automatically deploys via
   GitHub Actions — no manual deployment needed.

## Deployment

This app is deployed on [Fly.io](https://fly.io) and uses GitHub Actions for
continuous deployment. Every push to the `main` branch automatically triggers
a deploy via the `.github/workflows/deploy.yml` workflow.

**Public URLs:**
- Overlay: https://broadcast-backend.fly.dev/overlay.html
- Control: https://broadcast-backend.fly.dev/control.html

State is persisted to disk and will survive server restarts.

## Stream Deck integration (next step)

Elgato's Stream Deck app has a built-in "Website" action that fires a
GET/POST request when a button is pressed. Point those buttons at small API
endpoints on this server (e.g. `/api/mode/halftime`, `/api/score/home/+1`) and
they'll do exactly what the control panel buttons do. That's a small addition
to `server.js` — happy to add it once you're ready to wire up physical
buttons instead of (or alongside) the touch control panel.

## What's editable live

- **Sport**: soccer, basketball, volleyball, baseball, softball (each sport remembers its own scorebug position)
- **Scene**: off / scorebug / matchup / halftime / timeout / water break / final (defaults to scorebug on startup)
- **Score, period/half/quarter/set label**. Soccer and basketball have no game clock — the scorebug always
  shows the two team panels flush together with a half/quarter strip underneath.
- **Halftime/intermission countdown** with sport-specific behavior. For volleyball, Set Break starts 3:00 and Timeout starts 1:15 automatically.
- **Scorebug layout & positioning**: adjustable per-sport, with a draggable challenge-bug position control
- **Score flash animation**: toggle between top and bottom position (defaults to bottom), with editable home/away fill and outline colors
- **Team names, colors, league/event text, kickoff/tip-off time**
- **Sport-specific stats**:
  - Soccer: half (1st/2nd)
  - Basketball: quarter, fouls, timeouts
  - Volleyball: sets, serving side, box score per set, and a match-ending button when a team with 2 sets won is at match point
  - Baseball/Softball: inning, count (balls/strikes/outs), baserunners
- **On-air bugs**: commentator/guest lower-third bugs and basketball/volleyball challenge review bug

## Home / away teams and the team roster

EAC is the default home side (name `EAC`, purple, `public/logos/eac.png`),
but EAC doesn't play every game it broadcasts, so **both** Home and Away are
picked from the same roster in the control panel's Team Setup section. EAC
itself is an entry in `teams.json`, so it can be put on either side.

- **EAC's logo** lives at `public/logos/eac.png`. Replace that file to update
  the crest everywhere. There's no logo-URL field in the control panel for
  either side — logos come from the roster pick (or stay blank for a Custom
  team), never hand-typed.
- **Teams** live in `public/teams.json` — a plain array, no server
  restart needed:

  ```json
  [
    { "name": "Some High School", "abbr": "SHS", "color": "#123456", "logo": "/logos/some-high-school.png" }
  ]
  ```

  `abbr` is the short label shown big in the scorebug (keeps both sides of
  the bar the same size no matter how long a team's real name is); `name` is
  the full name shown in small text underneath it. Drop each team's logo
  image into `public/logos/`, add a matching entry to `teams.json`, and it
  shows up in both the "Home Team" and "Away Team" dropdowns. Selecting a
  team auto-fills that side's abbreviation/full name/color/logo and locks
  the name fields; pick "Custom / Other…" to type in a team that isn't in
  the list yet. **⇄ Swap Home / Away** flips everything between the two
  sides. Roster picks and swaps only go on air when you hit Save Team Info.

  Notes on specific entries:
  - "Missouri State University-West Plains" (`MSU-WP`) uses the logo file
    `missouristateuniversity.webp` — it's the West Plains Grizzlies (blue),
    not the main Missouri State campus.

- **Full reset** clears whichever side isn't EAC back to blank. If EAC
  wasn't playing, home goes back to EAC and away is cleared.

- **Color swatches**: Home leads with EAC's own colors (purple, gold, black,
  white, and pink for breast cancer awareness games) followed by the general
  palette, for games where EAC isn't home; Away offers the general palette.
  Either side's hex field can still be typed by hand for an exact match.
  Picking a roster team fills in its default color, but it's never locked —
  tweak it and hit Save like any other field.

- **Crest background**: each side's logo badge sits on a plain white or
  black matte (not the team color) so the logo itself stays legible instead
  of fighting a random background color. Toggle it per side in the Team
  Setup section ("Home/Away Logo Background") — it applies instantly, no
  need to hit Save.
