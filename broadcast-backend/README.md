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
  scorebug / matchup / halftime / break based on server state, nothing else
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
- **Scene**: off / scorebug / matchup / halftime / break (defaults to scorebug on startup)
- **Score, clock text, period/half/quarter/set label**
- **Halftime/intermission countdown** with sport-specific presets
- **Scorebug layout & positioning**: adjustable per-sport — save custom positions as defaults for each sport
- **Score flash animation**: toggle between top and bottom position
- **Team names, colors, records, league/event text, kickoff/tip-off time**
- **Sport-specific stats**:
  - Soccer: half (1st/2nd/Extra Time)
  - Basketball: quarter, fouls, timeouts
  - Volleyball: sets, serving side, box score per set
  - Baseball/Softball: inning, count (balls/strikes/outs), baserunners
- **Break screen**: type (timeout/BRB/sponsor), title, sponsor name + tagline, footer text, QR code image URL

## Home team (EAC) and the opponent roster

Since this overlay is only ever used for EAC broadcasts, the home side's name
(`EAC`), color, and logo are baked in as defaults in `server.js` rather than
typed in every gameday. Name/color are still editable in the control panel's
Team Setup section if you ever need to override them for a special event.

- **EAC's logo** lives at `public/logos/eac.png`. Replace that file to update
  the crest everywhere (control panel + overlay pick it up automatically).
  There's no logo-URL field in the control panel for either side — home is
  always that file, and away comes from the roster pick below (or stays
  blank for a Custom opponent), never hand-typed.
- **Opponents** live in `public/teams.json` — a plain array, no server
  restart needed:

  ```json
  [
    { "name": "Some High School", "abbr": "SHS", "color": "#123456", "logo": "/logos/some-high-school.png" }
  ]
  ```

  `abbr` is the short label shown big in the scorebug (keeps both sides of
  the bar the same size no matter how long the opponent's real name is);
  `name` is the full name shown in small text underneath it. Drop each
  opponent's logo image into `public/logos/`, add a matching entry to
  `teams.json`, and it shows up in the "Away Opponent" dropdown on the
  control panel. Selecting a team auto-fills the away abbreviation/full
  name/color/logo and locks those fields; pick "Custom / Other…" from the
  dropdown to type in an opponent that isn't in the list yet.

  The abbreviations currently in `teams.json` are placeholders I guessed
  from each school's name — edit the `abbr` value for any team if you'd
  rather use something else (e.g. a mascot name or conference shorthand).

- **Color swatches** are split by side: Home only offers EAC's own colors
  (purple, gold, black, white, and pink for breast cancer awareness games),
  while Away offers a much larger general-purpose palette to cover whatever
  opponent's brand colors don't already match. Either side's hex field can
  still be typed by hand for an exact match. Picking a roster team fills in
  a default away color, but it's never locked — tweak it and hit Save like
  any other field.

- **Crest background**: each side's logo badge sits on a plain white or
  black matte (not the team color) so the logo itself stays legible instead
  of fighting a random background color. Toggle it per side in the Team
  Setup section ("Home/Away Logo Background") — it applies instantly, no
  need to hit Save.
