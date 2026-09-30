# Cloudflare bandwidth and the broadcast relay

Research report, 2026-09-29. Question: the relay (a Worker with a Durable
Object room per channel, on the Workers Free plan) fans WebSocket messages
out to viewers. Today that is small JSON; it may later carry audio and
possibly low-res video (~40 KB/s per viewer, up to a few hundred viewers,
session-length streams). Is unmetered egress on Workers/DO a contractual
commitment or informal goodwill, and is there any point where Cloudflare
throttles, bills, or boots a free-plan app for bandwidth?

## Verdict

Cloudflare will not bill for bandwidth; that part is firm, since no
bandwidth price exists for Workers or Durable Objects. There is no promise
of unlimited bandwidth either: the terms have no bandwidth cap and no
video/audio ban for Workers, but they let Cloudflare limit or suspend a
Free account at its discretion, and Cloudflare has said on record that it
watches free accounts with "aggressive" egress, without naming a number.
For JSON and audio, nothing binds. At the video end (~2.6 TB/month at 300
viewers, 2 h/day), two unknowns come first: the discretionary abuse
review, and how much one Durable Object can actually push. The $5/month
Workers Paid plan removes most of the ambiguity.

## (a) Contract or goodwill? Both, in different ways

**The zero egress price is documented, not a favour.**

- Workers pricing page (updated 2026-08-28): "There are no additional
  charges for data transfer (egress) or throughput (bandwidth)." The
  sentence sits in the Workers Paid plan paragraph, which lists Durable
  Objects. https://developers.cloudflare.com/workers/platform/pricing/
- DO pricing page (updated 2026-08-25) has no egress line at all, and
  says: "There is no charge for outgoing WebSocket messages."
  https://developers.cloudflare.com/durable-objects/platform/pricing/
- Egress fees on Workers Unbound and DO were removed 2021-11-18.
  https://blog.cloudflare.com/workers-now-even-more-unbound/
- By contrast, Cloudflare Containers do bill egress per GB, so Cloudflare
  meters egress where it chooses to. No bandwidth price exists for
  Workers or DO, so bandwidth cannot be billed.

**Content is allowed.** The Developer Platform Service-Specific Terms
(updated 2026-09-28) cover Workers, Durable Objects, R2 and the rest.
https://www.cloudflare.com/service-specific-terms-developer-platform/

- Searches for "video", "non-HTML", "audio", "bandwidth", "egress",
  "large files" and "fair" find nothing in the Developer Platform
  section; the only "video" hits are in the Realtime and Stream sections.
- The old Workers carve-out ("non-HTML content ... other than video
  files", 2021 terms) is gone.
- The terms say: "Unlike most Cloudflare products, the Developer Platform
  can be used to host content." The only content limits are on illegal or
  harmful content.
- The one capacity clause: "Cloudflare may temporarily limit your storage
  and/or the number of requests you can make or receive using the
  Developer Platform if processing such requests would put an undue
  burden on the Cloudflare network..." It talks about requests, not
  bytes.

**The video restriction now applies to the CDN only.** The Application
Services terms (updated 2026-09-28), section "Content Delivery Network
(Free, Pro, or Business)":
https://www.cloudflare.com/service-specific-terms-application-services/

> "Unless you are an Enterprise customer, Cloudflare offers specific Paid
> Services (e.g., the Developer Platform, Images, and Stream) that you
> must use in order to serve video and other large files via the CDN.
> Cloudflare reserves the right to disable or limit ... if you use ...
> the CDN without such Paid Services to serve video or a disproportionate
> percentage of pictures, audio files, or other large files."

This came from the 2023-05-16 rewrite ("Goodbye, section 2.8"):
https://blog.cloudflare.com/updated-tos/

Unresolved ambiguity: the clause names the Developer Platform as a *Paid*
Service, and on Workers Free it arguably is not one. It only matters if
relay traffic counts as "via the CDN", which a DO WebSocket probably does
not. Being on the $5 plan makes the question go away.

**The goodwill part.** The Self-Serve agreement (updated 2025-09-12),
https://www.cloudflare.com/terms/ :

- §2.6: Free Services last until "termination of the Free Service by
  Cloudflare in our sole discretion", with "no liability".
- §8: "We may at our sole discretion ... Suspend or terminate your use or
  access to the Service at any time, with or without notice for any
  reason or no reason at all."

## (b) Bandwidth thresholds

- Published hard or soft limits: none. The Workers limits page (updated
  2026-09-05) says "Cloudflare does not enforce response body size
  limits" and gives no throughput cap. The DO limits page (updated
  2026-06-01) has no bandwidth limit either.
- Staff statement: Aly Cabral, then Cloudflare's developer platform
  product lead, on X, 2022-09-19: "Our developer platform TOS is meant to
  be inclusive of the cache api, and cache + our developer products.
  However, we have abuse mitigations in place that look for free accounts
  that use an aggressive amount of egress." No number given.
  https://x.com/Aly_Cabral/status/1571917591228325888 (quoted in
  https://community.cloudflare.com/t/cloudflare-r2-workers-cache-api-for-video-files/427114)
- Real cases, all 2022, under the old terms, all video files over HTTP:
  - A paid Workers + KV app serving video stream chunks had requests
    302-redirected to a "This video has been restricted" page.
    https://community.cloudflare.com/t/this-video-has-beend-restricted-issue-using-kv/391767 (2022-06-16)
  - A Pro-plan site doing ~30 TB/month with Workers in the path had its
    domain redirected to cloudflare-terms-of-service-abuse.com; Trust &
    Safety handled it, support could not.
    https://community.cloudflare.com/t/this-video-has-been-restricted-on-workers-and-our-api/359537 (2022-02)
  - A community MVP wrote in 2020 about CDN image hosting: ~50 GB/month
    is fine, but "a lot of people do get shut down once they start doing
    terabytes a month".
    https://community.cloudflare.com/t/is-it-ok-to-serve-images-from-workers-and-kv/179166
- No documented case was found of a Workers/DO WebSocket relay being
  throttled, billed or booted for bandwidth. Known enforcement works on
  HTTP video responses (URL redirects); video frames inside a WebSocket
  would probably not trip that filter, but that is inference, not
  verified.
- The current "Delivering Videos with Cloudflare" page (updated
  2026-08-25) never mentions Workers, DO or WebSockets.
  https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/
- No 2025 or 2026 staff statement specifically about sustained WebSocket
  egress was found.

## (c) What binds first on the Free plan

Free limits from the DO pricing page (2026-08-25): 100,000 requests/day
and 13,000 GB-s/day duration. Going over a limit makes further operations
fail with an error; nothing is billed. Limits reset at 00:00 UTC.

- Requests: each viewer connection costs one Worker request and one DO
  request. Incoming WebSocket messages count at 20:1; outgoing messages
  and protocol pings are free. A broadcaster sending at 30 Hz for 2 hours
  sends 216k messages, billing as 10.8k requests. Caveat: the docs say
  the 20:1 ratio is "for compute requests billing-only" and do not say
  explicitly whether it also applies to the Free 100k/day cap; if it does
  not, 216k raw messages would exceed the cap. Safe shape: keep the
  broadcaster at 10 Hz or less (~72k/day) and use
  setWebSocketAutoResponse for viewer heartbeats (the relay already does
  both).
- Duration: a 2-hour awake room uses ~7,200 s x 0.125 GB = ~900 GB-s of
  the 13,000 GB-s daily allowance, so duration binds at about 14
  two-hour rooms a day. A hibernated idle DO is not billed for duration.
- What actually binds first at the video end:
  1. Throughput of a single DO: ~12 MB/s for 300 video viewers
     (40 KB/s x 300 = ~43 GB/hour = ~2.6 TB/month at 2 h/day) from one
     single-threaded object. Cloudflare publishes no ceiling; the
     WebSocket docs warn that "sending many small messages can overwhelm
     a single Durable Object" and suggest batching. Load-test, or fan
     out across several DOs.
  2. The discretionary free-account egress review described in (b).

## (d) When to graduate video, with rough prices

- Realtime SFU (WebRTC): first 1,000 GB/month free, then $0.05/GB egress;
  ingress free (updated 2026-09-22).
  https://developers.cloudflare.com/realtime/sfu/pricing/
  2.6 TB/month would be ~$80/month. Terms describe it as for "video call
  functionality" and allow limiting concurrent calls. Whether it needs a
  paid billing profile was not verified.
- Stream (including Live): $1 per 1,000 minutes delivered, plus $5 per
  1,000 minutes stored if recorded; no egress fees (updated 2026-09-08).
  https://developers.cloudflare.com/stream/pricing/
  Billing for Stream Live WebRTC delivery starts 2026-10-15.
  300 viewers x 2 h x 30 days = ~1.08M minutes = ~$1,080/month.
- Rule of thumb: keep JSON and audio on the DO relay (audio at a few
  KB/s x 300 viewers is ~1-4 GB/hour); move to the $5 Workers Paid plan
  before the video experiments; graduate video to Realtime SFU once it is
  sustained at multi-TB/month or needs real video quality (congestion
  control, adaptive bitrate). At this bitrate Realtime is roughly 10x
  cheaper than Stream.

## Not verified

- Whether the 20:1 message ratio applies to the Free-plan request cap.
- Whether "Paid Services" in the CDN clause excludes Workers Free.
- Whether in-band WebSocket video is ever detected by abuse systems.
- Realtime's plan requirements.
- Any real throughput figure for a single Durable Object.

A third-party guide (websocket.org) claims bandwidth cost dominates on
Workers WebSockets; that contradicts Cloudflare's own pricing pages and
was ignored.
