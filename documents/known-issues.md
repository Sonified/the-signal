# Known issues

## Red WebSocket errors in the console when the local relay is off

Opening the presentation (`/?presentation`) with no local relay running prints
red `WebSocket connection to 'ws://localhost:8800/...' failed` lines in the
console, repeating as the connection retries, with the relay key visible in
each URL.

**This is cosmetic.** The presentation receiver (platform/presentation-receiver.js)
always dials two paths at once — the cloud relay and the laptop's own local
relay (`node tools/mirror-local.mjs`, port 8800) — and whichever delivers a
command first wins. When the local relay is not running, those attempts fail
and retry on a backoff, and the *browser itself* prints each failed attempt's
full URL in red; no page code can suppress a failed connection's console line,
and the key rides the URL because that is where the relay reads it.

The cloud path is unaffected: `cloud follow mirror-show open` in the console
means the controller is heard. To stop the red lines, run the local relay.

On the key being visible: since 2026-10-22 the relay key is the same word as
the presentation drawer's password, which sits in plain text in
core/presentation.js in a public repository — show chrome, not security. The
console reveals nothing the repo does not. If the relay key is ever made a
real secret again (different word, seeded per device), these printed URLs
would expose it to anyone reading the console, and the doze-and-retry of the
local path should be revisited then.
