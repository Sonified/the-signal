# Broadcast: the cost model, what was built, and the A/V blueprint

2026-09-29. One day's thinking and building on the broadcast relay: how
Cloudflare actually charges, the features that came out of understanding
it, and the agreed design for live audio and video when we build it.
Companion document: [cloudflare-egress-research.md](cloudflare-egress-research.md)
holds the sourced terms-of-service research behind the claims here.

## The mental model (the part worth re-reading)

Cloudflare bills the relay on exactly two axes, and bytes are not one of
them:

1. **Incoming messages.** Everything arriving at a room counts, at a
   20:1 hibernation discount. Outgoing messages are free, which means
   fan-out is free: one message from the broadcaster reaching 300
   followers costs the same as reaching 3. The audience listens for
   free; only speaking counts, once.
2. **Awake time.** A room is a small computer that wakes when a message
   arrives and hibernates after ~10 s of quiet. Awake seconds are the
   metered thing, and they are content-blind: JSON, audio and video all
   cost the same while flowing at the same cadence. Sockets stay
   connected at the edge while the room sleeps; hibernation never means
   disconnection. Keepalive pings are answered at the edge
   (setWebSocketAutoResponse in the worker) without waking the room.

Free plan allowances (as of 2026-08): 100k requests/day, 13,000
GB-s/day of awake time, which works out to roughly **29 awake
room-hours per day**. Overage does not bill; it errors until 00:00 UTC.
The $5/month Workers Paid plan multiplies everything and removes the one
documented ambiguity (whether the 20:1 ratio applies to the free cap or
only to paid billing).

Capacity in practice: an hour of live streaming to any audience size is
~1% of daily messages and ~3.5% of awake time. The free tier funds one
24/7 always-awake room (83% of duration) OR ~29 hours of live sessions
spread across any number of rooms. Viewer chat is negligible (10k
messages/day = ~500 requests). The residual risk at scale is not
billing but discretionary review of free accounts moving terabytes per
month of video; see the research doc.

## What was built today (all in v1, Robert tests in Chrome)

- **Watcher gating** (core/broadcast.js): state snapshots, phase
  beacons and relayed words go only to sessions with watchers > 0. An
  empty room hears nothing but the 10 s clock probe and the 20 s ping
  and hibernates between them. A first watcher's count transition
  (0 to n) triggers an immediate state send.
- **Idle doze** (broadcast.js + drawer.js): 10 minutes with no state
  actually sent closes each live session's socket WITHOUT the end
  message, status 'doze', drawer label "resting", dot stays green. The
  room keeps the stored snapshot for late joiners; followers notice
  nothing (they belong to the room, not the broadcaster). Any touch
  (control change, run/stop, journey step) reopens sockets via the
  queueSend choke point; reconnect is sub-second. Deliberately closing
  a dozing session opens a one-shot socket to send end so the stored
  snapshot clears. Consequence: standing channels are effectively free
  forever, each holding its last scene.
- **Seeded shared word walk** (words.js + broadcast.js): inside a room,
  every screen deals words locally and deterministically. Seed =
  hash(room slug); step = floor(shared room clock / step length);
  word, rests, fades, dwell and opacity phase are each pure functions
  of hash(seed, step, purpose tag), splitmix32-based, stateless, so a
  joiner mid-stream lands on the current word at its true age with no
  history replay. Words flow forever through a dozed socket and a
  hibernating room. Live relayed words still override (walk-dealt words
  carry their step k so walking followers drop duplicates). Outside a
  room, local random behavior is unchanged: two neighbors not sharing a
  room see different words. Known deviations, commented in words.js:
  strobe-linked word timing approximates using set frequency rather
  than per-screen cycle wraps; variance spread is even rather than
  local mode's exact distribution.
- **Worker**: prose comment above the existing ping auto-response, and
  a defensive early return for 'ping' in webSocketMessage. Deploy
  optional (npx wrangler deploy from broadcast-worker/); both changes
  are documentation/defense, not behavior.
- **Drawer**: the Rings header's live "(drawn / total)" count is
  retired; ringsTitle in drawer.js remains for reconnection.

## The A/V blueprint (agreed design, not yet built)

Voice and camera through the same relay, same rooms, same economics.

- **Capture and mux**: MediaRecorder on a stream holding mic and camera
  tracks muxes both into one webm stream natively. One chunk stream,
  audio and video interleaved. Suggested: 320x240 at 15 fps, VP8,
  ~200-300 kbps combined; chunk sizes ~50-100 KB, far under the 1 MiB
  message cap.
- **The mode switch is one number**: MediaRecorder's timeslice.
  - Live mode: ~200 ms chunks, ~1 s behind live, for chat-responsive
    sessions. 5x the message spend, still small.
  - Long stream mode: 1-2 s chunks, ~2-3 s behind, marathon-priced
    (a 5-hour day = ~18k raw messages at 1 s chunks, unambiguous under
    every cap reading). Followers need no setting; they play whatever
    cadence arrives, so mode can switch mid-session (restart recorder
    with new timeslice).
  - Slots into the schema as a broadcaster-side segment control.
- **Worker change**: webSocketMessage currently returns on non-string
  messages. Binary frames from the broadcaster must fan out to
  followers and never be written to the stored snapshot.
- **Follower playback**: decode to a GPU texture (WebCodecs VideoFrame
  or a hidden video element via importExternalTexture) and draw as a
  quad inside the frame, honoring the no-DOM-over-canvas rule. The
  camera is in the scene, so it can fade, glow, be composited with the
  journey. Audio via a jitter buffer of ~0.5 s.
- **Chat** (if wanted): the worker currently ignores follower messages
  except time probes; a chat message type fanned to the room is a
  modest worker addition. Cost is negligible. The real questions are
  community ones: names, moderation, what the space allows.
- **Graduation path**: session-length video to dozens of viewers is
  free and unambiguous. Sustained video to hundreds (terabytes/month)
  is when to move to the $5 plan and then Cloudflare Realtime SFU
  (~$80/month at 300 viewers), per the research doc. Audio never needs
  to graduate.

## Design principles that emerged today

- The room, not the connection, is the broadcast. The broadcaster's
  socket is a pen, not a lifeline; the stored snapshot is the channel.
- Determinism replaces transmission: anything all screens can compute
  from a shared seed and a shared clock never needs sending. The word
  walk is the first instance; journeys played locally against the
  shared clock would be the second.
- Spend awake time only at the tempo the moment requires: gate on
  watchers, doze on silence, size chunks to the session's latency
  needs.
