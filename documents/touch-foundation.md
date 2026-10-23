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
   **phases** (see The phases below). The server computes who hears whom
   for the phase and re-tells each member its **group** on every join,
   leave and phase change, so every screen agrees without an election.
   Anything a member sends is stamped with its id and relayed by those
   routes: a stroke says what is happening now. The conductor -
   a join carrying the existing BROADCAST_KEY (`?conduct=1&key=...`) - may
   set the phase; a bad key joins as an ordinary member rather than failing.
   The time probe ({t:'time'}) answers as the Room's does, one clock per
   hall, for whatever later needs phase-locked motion. Hibernation-safe like
   the Room: per-socket state rides the socket's attachment, the phase and
   id counter live in storage, and pings are answered at the edge.

   **Sticky ids** (2026-10-22, for the show): every device joins with a
   token of its own (`?d=<token>`; touch/hall.js deviceToken, random, made
   once and kept in localStorage, in memory for a session where storage is
   refused; the main app keeps its own under another name, so a /touch/
   tab on the same machine is a separate member). The hall remembers the id
   it gave each token (`tok:<token>` keys, capped at 10000), so a device
   that blips and reconnects, or reloads, takes its old id back and lands
   in exactly the group it left, nobody else moving. A socket still holding
   that id (the old one lingering, or the same device in a second tab) is
   replaced: closed with code 4000, its later close saying nothing, and
   its client staying away rather than taking the id back. The map, the
   phase and the id counter all survive the hall emptying, so a show whose
   whole room dropped at once returns in the phase and groups it left (the
   conductor starts a new gathering with Alone); a conductor's wipe clears
   the map but for the devices still connected, and ids are never given
   twice.

   **The tape**: every stroke a member sends is also appended to the hall's
   Durable Object storage as `{at, id, s}` - ms since the hall's epoch (the
   first entry sets it), the drawer, the stroke as said (the id stored once
   beside it, not stamped in twice). Keys are `tape:` plus a zero-padded
   counter, so a prefix list walks them in order; the counter is only an
   in-memory cache, re-seeded from the last stored key after any eviction.
   The tape caps at 100000 entries (past it, recording stops silently),
   survives the hall emptying - the drawings outlive the drawers - and only
   a conductor's {t:'wipe'} clears it (key by key by prefix, since
   deleteAll would also take a live phase and id counter) and the epoch. A
   plain GET of `/touch/<name>/tape` returns the whole recording as JSON
   with open CORS.

   **The phases** (2026-10-22, for the show; broadcast-worker/src/groups.js,
   pure, so node tests the code the hall runs). In the conductor's order:

   | phase    | the drawers                                   | the conductor |
   |----------|-----------------------------------------------|---------------|
   | `solo`   | each alone                                    | alone |
   | `master` | each alone; their strokes reach nobody        | its strokes reach everyone |
   | `pairs`  | adjacent twos, an odd joiner makes the last pair a trio | hears nothing, reaches nobody |
   | `quads`  | adjacent fours (two pairs merged); the leftover 1-3 fold into the last, so 5-7 only when the roster is not a multiple of 4, never under 4 unless the whole roster is | hears nothing, reaches nobody |
   | `halves` | whole quads merged into two, never one split: the list of quads cut where the two head counts come nearest (on a tie the first half is the smaller), the earlier quads first; under 8 the roster is one quad, so one half | hears nothing, reaches nobody |
   | `all`    | everyone in one group                         | in it: hears everything, so the master screen shows the final drawing |

   **The rounds** (2026-10-23, the show's script; groups.js SCRIPT,
   planStep, liveGroups, regroup): Alone, Master, Pairs 1 (find your
   partner: adjacent twos), Pairs 2 (everyone's partner switches, found by
   a deterministic search for the grouping with the fewest old pairs; this
   pairing is the bond for the rest of the show), Fours 1 (the bonded pairs
   matched two and two), Fours 2 (your pair stays, the other changes, never
   the round-1 opposing pair again), Together. With four or more present,
   round 2 splits every round-1 pair (no repeat at all but at five, where
   none is possible and everyone still meets someone new); with four or
   more pairs, Fours 2 re-meets no round-1 opposing pair (five pairs
   excepted). The hall keeps `round` beside `phase` and the rounds'
   history (`hist`): each step of pairs or quads is planned once, from the
   drawers present when it is first reached, and found again when it is
   reached again. Within a step nobody already bonded moves: a leaver's
   place waits (the one left keeps it, for a blip), joiners pair or make
   fours among themselves as new groups at the end, or join the last group
   while too few for their own. Each later round is planned over the roster
   as it stands when it starts: a joiner since has no old partner to avoid,
   a leaver is not placed, and Fours build on the bonds as they stand
   (bonded pairs, joiners paired as new units). The wipe forgets the
   history, for a new show. Halves stays a phase of its own, outside the
   script, from the ids. The conductor's chips (/touch/ and the main app's
   Brush section): a phase's chip asks for its round 1, the lit Pairs or
   Fours tapped again its round 2, the chip naming the round the hall says
   ('Pairs 2'); Next walks the script.

   **The dealt brushes** (2026-10-23, broadcast-worker/src/deal.js): the
   conductor's Show brushes sends `{t:'brushes', on, n, a, tiles}`, the
   tiles being the current set's painted ones as its own client knows them
   (the hall cannot see the sheets), and the hall deals every member, the
   conductor included, in joining order, n tiles from one shuffle of them
   (a seed it picks per deal), dealt once: no tile ever goes to two people.
   A joiner is dealt on arrival; once the deck is dry a late joiner gets
   what is left, a shorter hand, down to none. Each hand is kept under the
   device's token, so a returning device holds the same tiles; the same
   deal sent again keeps every hand, a new count, set or deck deals afresh,
   off and the wipe let every hand go. The hall is one Durable Object, so
   the deal is atomic: no two members can draw the same card and no client
   ever claims or resolves a collision. Hands never ride strokes or the
   tape: each stroke carries its own a and m. The room's Stream and
   Smoothing (`{t:'room', ms, sm}`) sit beside the phase and are re-told
   in hello and group; every member flushes at the Stream and plays remote
   strokes at Stream + Smoothing past the sender's time.

   The groups nest strictly: every pair inside one quad, every quad inside
   one half, every half inside all, so each step up the phases only merges
   groups and nobody is torn from the people they were drawing with (ten
   drawers: quads 1-4 and 5-10, halves the same, where the old floor(n/2)
   cut tore 5 from its pair and its quad).

   The conductor is not a drawer in the groups: `phaseGroups(phase, ids)`
   groups the members' ids only (ascending, every id in exactly one group,
   no empty group), and `routes(phase, ids, conductors)` places the
   conductors by the table, returning per id `to` (who its strokes are
   relayed to) and `with` (itself plus everyone who reaches it, which is
   what `{t:'group'}` tells it). `CONDUCTOR_HEARS_GROUPS` (false) is the
   one switch: true and the conductor receives every member's stroke in
   pairs, quads and halves too. Whatever reaches nobody still lands on the
   tape - the conductor's strokes in every phase included.

2. **The stroke** (touch/strokes.js): the one message of a touch
   experience. A finger's path travels in small batches ({t:'s', k brush,
   h hue, w width, d start/middle/end, p points quantized to 1/4096 of a
   centred unit square}), so a partner watches the line grow under the hand.
   decode() refuses anything malformed - the hall relays whatever a member
   said - and **the same draw() paints local and remote batches**, so a mark
   is deterministic from its messages and every screen shows the same
   figure whatever its size. Four brushes to start: ink, ribbon (width
   breathes with speed), orbs, spark; a fifth, **motif** (k 4, appended so
   the first four keep their indices), stamps a kaleidoscope atlas tile and
   carries four more fields, all required: `a` the atlas set (integer 1-99,
   as S.kaleidoSet numbers it), `m` the tile (integer 0-63, a cell of the
   8x8 atlas), `c` copies (integer 1-24, evenly spaced around the centre),
   `f` fade (number 0-1, the sender's fade slider, so a receiver fades
   remote marks the way the sender's own fade). One more is optional: `r`
   rate (number 0-1, the sender's Rate slider; 2026-10-22). At 1, or absent
   (every stroke from before it), the stroke is continuous: a receiver
   fills the path with stamps along its length (core/brush-stamps.js,
   arc-length spacing carried across batches). Under 1 the sender has
   already chosen its prints by time (60 a second just under the top, down
   to 1 at 0), so every point of the stroke IS a print: a receiver stamps
   each point as it stands, with no fill and no carry, and the sender
   repeats no joint between batches. decodeStroke refuses a motif stroke
   with any of the four missing, non-integer where an integer is due, or
   out of range, or with an `r` that is not a number in 0-1, and decodes
   every other brush exactly as before (ignoring stray extras);
   encodeStroke takes them as an optional sixth argument `{a, m, c, f, r}`.
   Any brush may also carry `q`, its points' times (2026-10-23): q[0] the
   first point's time in whole ms on the sender's own clock (its
   performance.now, an integer 0-1e13), then for each later point the whole
   ms since the one before (0-60000), one entry per point (a batch's joint
   carries the time it had in the batch before). timesToQ builds it from
   absolute times, decodeStroke checks it (wrong length, a fraction, a
   negative or an oversized gap refuses the stroke) and hands back `times`,
   absolute ms; without q a stroke decodes as ever. The main app plays a
   timed remote stroke on the sender's own timeline (core/brush.js,
   core/brush-playback.js): each point shown at its sender time plus the
   least offset ever seen from that sender (arrival less the batch's last
   point time, no clock protocol) plus a delay of one batch and a margin
   (the room's Stream and Smoothing, 20 ms and 30 ms unless the conductor
   sets them), interpolated between points; a batch arriving after its
   first new point's play time raises the delay by the lateness, and what
   lateness added never comes off in a session. An untimed stroke glides
   as it did. Both senders flush every Stream ms (20 by default). The tape keeps q with the
   other fields, so a replay can use it; planReplay still schedules whole
   batches by their arrival `at` (a follow-up could play their points by q). The real motif rendering lives in the main
   app's WebGPU lane; /touch/ draws a small ring at each point as its
   stand-in and does not offer the brush in its picker. The tape records
   the four fields whenever a stroke carried them.

3. **The scene** (touch/scene.js): Canvas2D, no build, phone-first. Video
   feedback as two buffers taking turns - each frame repaints the last
   slightly scaled, turned and dimmed, then the frame's new marks on top -
   and the kaleidoscope **duplicates the drawn object** (each batch stamped
   N times around the centre, alternate stamps mirrored) rather than
   clipping wedges, so one finger draws a mandala and the feedback carries
   the whole figure outward. Knobs on `scene.set`: slices, mirror, zoom
   (out- or inward), spin, decay.

The page (touch/index.html + main.js) wires them: brush and hue picker,
multi-touch drawing (a batch per finger, flushed every 30 ms or 16 points,
stamped locally the moment it lands so the hand never waits on the wire),
the hall link with reconnect and a clean offline life as a solo instrument
(touch/hall.js), a one-line status, a flash when the group changes, and the
conductor's chips (Alone / Master / Pairs / Fours / Halves / Together, plus
Replay and Wipe) when the key worked.

**The replay** (touch/replay.js): the page opened with `?replay=1` (the
conductor's Replay chip navigates there, hall and key kept) skips the
picker, joins nothing, fetches the hall's tape and plays it into the same
scene by the same drawStroke - the playback is the drawing, not a film of
it. Two movements, Robert's words: individual drawings coming together -
each drawer alone in id order, the scene cleared between them, a flash
('drawer N', in their first stroke's hue), each session time-compressed to
a 12 s slot - then, after 'all together', the whole tape on its common
timeline compressed to 45 s, everyone at once. Compression only ever
speeds a session up (scale caps at 1), so a five-second doodle plays at
the pace the hand drew it. planReplay is pure - entries in, timed plans
out - so node tests the movements; the driver walking a plan against
performance.now() is the thin part.

## 2. The protocol

    join  ws  wss://<relay>/touch/<hall>?d=<device token>[&conduct=1&key=...]
    s->c  {t:'hello', you, phase, round, ms, sm, ids, conduct} on joining
          {t:'peer', id, on:1|0}                    arrivals and leaves
          {t:'hand', on, a, tiles}                  this device's dealt brushes
                                                    (on joining, and when the
                                                    deal starts or stops)
          {t:'group', phase, round, ms, sm, you, ids} you plus whoever reaches
                                                    you, re-told on
                                                    join/leave/phase
          {t:'time', c, s}                          the probe's echo
    c->s  {t:'s', k, h, w, d, p:[...]}              a stroke batch; relayed by
                                                    the phase's routes stamped
                                                    {id}, and appended to the
                                                    tape
          {t:'s', k:4, h, w, d, p, a, m, c, f[, r][, q]} a motif batch (a 1-99,
                                                    m 0-63, c 1-24 integers,
                                                    f 0-1; r 0-1 optional,
                                                    under 1 each point a
                                                    print)
          {t:'phase', p[, r]}                       conductor only; p one of
                                                    solo master pairs quads
                                                    halves all; r its round
                                                    (pairs, quads: 1-2), 1
                                                    when left out
          {t:'next'}                                conductor only; the next
                                                    step of the script (the
                                                    last stays)
          {t:'room', ms, sm}                        conductor only; Stream
                                                    10-60 ms, Smoothing 0-200
                                                    ms, re-told in group
          {t:'brushes', on, n, a, tiles}            conductor only; deal n
                                                    (1-8) of set a's paintable
                                                    tiles to everyone, or
                                                    stop (on 0)
          {t:'wipe'}                                conductor only; clears the
                                                    tape and its epoch
          'ping'                                    answered at the edge
    GET   https://<relay>/touch/<hall>/tape         the recording, plain HTTP:
                                                    {epoch, n, entries:
                                                    [{at, id, s}, ...]}, CORS *
    page  ?replay=1                                 play the tape instead of
                                                    joining the hall

## 3. What was verified

- tools/touch.test.mjs: the pairing (empty, one, odd trios, determinism
  from ids alone) and the stroke wire (round-trip to the quantum, the id
  stamp surviving relay, thirteen malformed shapes refused). Since
  2026-10-22 also: every phase over rosters 1..13 (each id placed exactly
  once, the sizes as specified, joining order kept, the same groups from
  any arrival order), the routes (master one way, the conductor apart in
  pairs/quads/halves and inside in all, the switch flipped, `with` always
  exactly the ids whose `to` names you), and the motif brush (accepted at
  both ends of every range, refused on each field missing, fractional,
  a string or out of range, other brushes unchanged, a motif tape entry
  replaying). ESM checks on
  every new file. NOT verified: a browser or a real hall - the worker was
  not deployed from this session.
- tools/touch-replay.test.mjs: the replay scheduler (an empty tape, the
  1x cap on short sessions, slot compression on long ones, a single-batch
  session not dividing by zero, drawers in id order each with their own
  zero and scale, the common timeline's scaling with offsets kept,
  malformed entries skipped from both movements). NOT verified: the tape
  end to end against a live worker - again, no deploy from this session.

## 4. What the foundation leaves open (in rough order)

- **Deploy**: `npx wrangler deploy` in broadcast-worker/ (the BROADCAST_KEY
  secret already set for the demo broadcast is the conductor key).
- A phase score: the conductor taps today; an installation wants timed
  movements (solo 2 min, pairs 3, all to the end) - a tiny conductor-page
  timer, or the hall advancing itself on a storage alarm.
- Sound: the strokes are already events on a shared room with a shared
  clock; handing them to Heart (a stroke as a gesture, the pair's strokes
  as call and answer) is the obvious next experience.
- Identity beyond hue; a gallery beyond the tape (the tape is the whole
  evening - a still or a video rendered from it, or picking one gathering
  out of a hall that hosted several, would want session marks on the tape);
  WebGPU for the scene if phones want more than Canvas2D gives; pressure
  into the stroke's w per point.
