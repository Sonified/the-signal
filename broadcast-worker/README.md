# The Signal — demo broadcast relay

A Cloudflare Worker with one Durable Object class (`Room`) that relays the
broadcaster's settings snapshots to every follower in the room, and hands a
late joiner the latest snapshot the moment they connect. Uses WebSocket
hibernation, so an idle room costs nothing; demo-scale traffic fits inside
Cloudflare's free tier.

The client halves live in the app: `v1/platform/broadcast-socket.js` (the
socket) and `v1/core/broadcast.js` (the logic).

## Deploy (once)

```sh
cd broadcast-worker
npx wrangler login          # first time only
npx wrangler deploy         # prints the relay URL, e.g. the-signal-broadcast.<subdomain>.workers.dev
npx wrangler secret put BROADCAST_KEY   # choose the broadcast passphrase
```

Then put the printed host (no scheme, no path) into `RELAY_HOST` at the top
of `v1/platform/broadcast-socket.js` and push the site.

## Use

- **You (the broadcaster):** the drawer's Broadcast section (bottom). Enter
  the key once, add a named session, switch it on, copy its link. Each live
  session shows how many viewers are watching. Every settings change you make
  (and run/stop) goes up as it happens. The URL form
  `?broadcast=<room>&key=<passphrase>` still works and seeds a session.
- **Everyone else:** open the link you copied (`?follow=<room>`) — their
  settings glide to yours, live, exactly as a preset recall does. They still
  press Space once themselves so the browser lets sound play.
- Room names come from your session names ("Lab Demo" → `lab-demo`).
  Anyone with the link can follow; only the key can broadcast. Switching a
  session off tells its viewers the broadcast ended and clears the room, so
  the link goes quiet until you switch it on again.

## Try it locally

```sh
cd broadcast-worker
npx wrangler dev            # relay on localhost:8787 (key is 'dev', from .dev.vars)
```

With the app served on localhost as usual, the client defaults to the local
relay automatically: open one tab with `?broadcast=demo&key=dev` and another
with `?follow=demo`.

## Notes

- The latest snapshot persists in the room's storage, so followers who join
  hours later still get the last broadcast state.
- A follower can still touch their own controls; the next broadcast simply
  takes the settings back.
- `&relay=<host>` on the page URL overrides `RELAY_HOST` for one load
  (handy for testing a deployed relay before editing the constant).
- Broadcast runs on the page-thread engine (the default). With the Render
  section's Engine thread set to Worker it stays quiet.
