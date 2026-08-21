# URLs
Overlay: https://broadcast-backend.fly.dev/overlay.html
Control: https://broadcast-backend.fly.dev/control.html

# Broadcast Control — Backend

Shared state server for the soccer overlay + control panel. One `mode` lives on
the server; every connected page (the overlay feeding YoloBox, and the control
panel on your phone/tablet) stays in sync over WebSocket.

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
2. **Small always-on host** (Render, Railway, a cheap VPS, etc.): deploy this
   folder there so you get a stable public URL that works from any network —
   useful once you're doing this for a whole season and don't want to
   re-find a local IP every gameday.

## Stream Deck integration (next step)

Elgato's Stream Deck app has a built-in "Website" action that fires a
GET/POST request when a button is pressed. Point those buttons at small API
endpoints on this server (e.g. `/api/mode/halftime`, `/api/score/home/+1`) and
they'll do exactly what the control panel buttons do. That's a small addition
to `server.js` — happy to add it once you're ready to wire up physical
buttons instead of (or alongside) the touch control panel.

## What's editable live

- Scene: off / scorebug / matchup / halftime / break
- Score, clock text, half label
- Halftime countdown (15:00 / 10:00 / 5:00 presets)
- Team names, colors, records, league/event text, kickoff time
- Break screen: type (timeout/BRB/sponsor), title, sponsor name + tagline,
  footer text, QR code image URL
