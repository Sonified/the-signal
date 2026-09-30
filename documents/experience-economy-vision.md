# The experience economy: streams, presets, cards, families

2026-09-29, evening riff. Product vision far ahead of the build. The only
piece being built now is the Event vs Open broadcast mode (bottom of this
document); everything else is design capital for later. Companion:
[broadcast-economics-and-av-blueprint.md](broadcast-economics-and-av-blueprint.md)
for the infrastructure this all rides on.

## The weekly stream as heartbeat

A live stream once a week (Sunday drop cadence). During the stream
everyone who scanned the QR / opened the link is synced for ~30 minutes:
one room, one breath, Robert driving. The weekly synced sit is the ritual
spine of the community; nobody else in the space has a liturgy.

## Attendance unlocks the preset

When the stream completes, the setting it introduced becomes a preset on
each attendee's device. The follower's device already holds the final
state, so the unlock is saving what the ceremony left behind, with a name
and a birthday. Proof of presence, like a ticket stub that still plays
the show. The end of stream is a handoff moment: "The stream is
complete. It's yours now."

## The share chain: a commodity that walks

Each attendee can share the preset with 3 people. Each recipient can
share with 1, and each of theirs with 1, onward forever: transmission
rate ~1, so every preset stays perpetually in motion at a controlled
speed, always somewhere, never everywhere. Every copy carries its
lineage (which stream it was born in, the chain of hands to you), shown
on the card. Received presets arrive as a gift from a specific person,
never from a store.

Rates are tunable server-side as the math teaches us (every share
resolves through our infrastructure). Power sharers can be granted more
shares, framed as being trusted, with a name from the app's own
cosmology: Beacon (the protocol already calls its sync pulses beacons),
Lantern, Keeper. Occasional random re-gifts of old presets with fresh
shares reintroduce them like a species, so old presets stay rare but
keep circulating. We can see how many presets live on each device.

## Cards

A shared preset arrives as a card. The text-message link preview is a
static rendered frame (the envelope). The opened link is the actual
engine running the preset live inside the card: not a picture of the
gift, the gift itself, already breathing. Arrival ceremony can reuse the
word-smoke tech: darkness, the card gathers out of vapor, glows with its
preset swirling inside, and the accepting tap lets the card grow into
the full-screen experience (the card does not open into the experience,
it becomes it). Card art generates itself from the preset's own visual
state; no designer touches one.

## The experience browser

Families of experience: sleep, calm, meditative, integration, energize.
Tap through families; each holds a few presets shown as cards. In deck
view the focused card runs live, the rest hold their last frame, so the
fan stays cheap. Upcoming releases show as a preview card with
"unlocks in __", dropping on the weekly cadence.

## Money

Subscribers ($) get the new preset every week automatically. Free tier
is limited (something like 5 minutes a day): a daily taste of practice.
Attendance and gifting remain paths into ownership regardless.

## The ethics line

Psychological mechanisms for belonging, specialness, being part of
something: yes, freely, that is what ritual has always done. The line
never to cross is engineered inadequacy. Every mechanism here makes
someone feel chosen (you were there, someone thought of you); none may
make anyone feel behind. The app that says "you are enough" can also say
"someone thought of you"; it must never say "act now."

## Being built now: Event vs Open broadcast mode

Per broadcast session, a mode:

- **Open** (default): a follower may start/stop freely. The stutter bug
  (a follower's tap starts, then the stored run:false snaps it back) is
  fixed by applying the broadcaster's run flag edge-triggered: only a
  change in the flag moves the follower, a stale flag never overrides a
  follower's local choice. Standing channels live here.
- **Event**: the broadcaster's pauses hold the room; a follower's tap
  does nothing but show how long until free play ("Free play unlocks in
  12:40"). The broadcaster sets an unlock time. At the unlock moment the
  session behaves as Open: the follower keeps the experience going,
  still receiving whatever is sent. (Followers have no other controls
  yet; free play beyond run/stop, and the preset unlock itself, are
  later chapters.)
