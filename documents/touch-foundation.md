# The group touch foundation

2026-10-23. The underlying foundation for experiences a room of people make
together with their fingers, and the first experience on it: pick a brush,
draw - the mark duplicates into a kaleidoscope and rides video feedback -
then the hall pairs you with a stranger, and in the end everyone draws into
one figure. Live at /touch/ once deployed; **the worker half needs one
`npx wrangler deploy` from broadcast-worker/** (the page half rides the
ordinary Pages push).

## 1. The shape

Three layers, each usable without the ones above it:

1. **The hall** (broadcast-worker/src/index.js, `Hall`): WebSocket rooms at
   `wss://<relay>/touch/<name>`, the Room's sibling. Everyone may speak, so
   it is not a broadcast: the server assigns each member an id in joining
   order, tells everyone of arrivals and leaves, and moves the room through
   **phases** - `solo`, `pairs`, `all`. The server computes each member's
   **group** for the phase (itself; its pair, an odd joiner folding into the
   last pair as a trio; everyone) and re-tells the groups on every join,
   leave and phase change, so every screen agrees without an election.
   Anything a member sends is stamped with its id and relayed to exactly its
   group, never stored: a stroke says what is happening now. The conductor -
   a join carrying the existing BROADCAST_KEY (`?conduct=1&key=...`) - may
   set the phase; a bad key joins as an ordinary member rather than failing.
   The time probe ({t:'time'}) answers as the Room's does, one clock per
   hall, for whatever later needs phase-locked motion. Hibernation-safe like
   the Room: per-socket state rides the socket's attachment, the phase and
   id counter live in storage, pings are answered at the edge, and an
   emptied hall forgets itself so the next gathering starts fresh.

2. **The stroke** (touch/strokes.js): the one message of a touch
   experience. A finger's path travels in small batches ({t:'s', k brush,
   h hue, w width, d start/middle/end, p points quantized to 1/4096 of a
   centred unit square}), so a partner watches the line grow under the hand.
   decode() refuses anything malformed - the hall relays whatever a member
   said - and **the same draw() paints local and remote batches**, so a mark
   is deterministic from its messages and every screen shows the same
   figure whatever its size. Four brushes to start: ink, ribbon (width
   breathes with speed), orbs, spark.

3. **The scene** (touch/scene.js): Canvas2D, no build, phone-first. Video
   feedback as two buffers taking turns - each frame repaints the last
   slightly scaled, turned and dimmed, then the frame's new marks on top -
   and the kaleidoscope **duplicates the drawn object** (each batch stamped
   N times around the centre, alternate stamps mirrored) rather than
   clipping wedges, so one finger draws a mandala and the feedback carries
   the whole figure outward. Knobs on `scene.set`: slices, mirror, zoom
   (out- or inward), spin, decay.

The page (touch/index.html + main.js) wires them: brush and hue picker,
multi-touch drawing (a batch per finger, flushed every 45 ms or 16 points,
stamped locally the moment it lands so the hand never waits on the wire),
the hall link with reconnect and a clean offline life as a solo instrument
(touch/hall.js), a one-line status, a flash when the group changes, and the
conductor's three words (Alone / Pairs / Together) when the key worked.

## 2. The protocol

    join  ws  wss://<relay>/touch/<hall>[?conduct=1&key=...]
    s->c  {t:'hello', you, phase, ids, conduct}     on joining
          {t:'peer', id, on:1|0}                    arrivals and leaves
          {t:'group', phase, you, ids}              who you draw with, re-told
                                                    on join/leave/phase
          {t:'time', c, s}                          the probe's echo
    c->s  {t:'s', k, h, w, d, p:[...]}              a stroke batch; relayed to
                                                    the group stamped {id}
          {t:'phase', p}                            conductor only
          'ping'                                    answered at the edge

## 3. What was verified

- tools/touch.test.mjs: the pairing (empty, one, odd trios, determinism
  from ids alone) and the stroke wire (round-trip to the quantum, the id
  stamp surviving relay, thirteen malformed shapes refused). ESM checks on
  every new file. NOT verified: a browser or a real hall - the worker was
  not deployed from this session.

## 4. What the foundation leaves open (in rough order)

- **Deploy**: `npx wrangler deploy` in broadcast-worker/ (the BROADCAST_KEY
  secret already set for the demo broadcast is the conductor key).
- A phase score: the conductor taps today; an installation wants timed
  movements (solo 2 min, pairs 3, all to the end) - a tiny conductor-page
  timer, or the hall advancing itself on a storage alarm.
- Sound: the strokes are already events on a shared room with a shared
  clock; handing them to Heart (a stroke as a gesture, the pair's strokes
  as call and answer) is the obvious next experience.
- Identity beyond hue; a gallery of what a hall drew (the hall stores
  nothing today, on purpose); WebGPU for the scene if phones want more than
  Canvas2D gives; pressure into the stroke's w per point.
