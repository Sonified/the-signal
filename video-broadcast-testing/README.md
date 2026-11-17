# Video broadcast test

A test page for sending a small camera picture from one device to another through the Cloudflare relay. Each device shows the other device's live picture in one window standing in a 3D space, about 2.5 metres straight in front of you. Change the settings, read the numbers, and judge how much data it takes, how good the picture looks, and how late it arrives.

Live: https://presence.now.audio/video-broadcast-testing/
On this computer: http://localhost:8000/video-broadcast-testing/

## Opening it on two devices

1. Open the page on the laptop. It makes up a room name (six letters and digits) and puts it in the address.
2. Under "Open this on the other device", tap "Copy link" and open that link on the phone. Both devices are now in the same room. You can also type the same room name into the Room box on each device.
3. Tap "Turn camera on" on each device. The browser asks for the camera the first time.
4. Each device now shows the other's picture in the window. Your own camera shows small and mirrored in the corner.

To test alone, tick "Show my own picture, sent through the relay and back". Your picture goes out to the relay and comes back to the same device, so the whole round trip can be judged with one device.

"Hide controls" leaves only the 3D view and the camera button. Every setting is remembered on each device.

## Settings

Sending:
- Picture size: how many dots wide and tall each picture is.
- Pictures a second: how many pictures the camera sends each second.
- Data rate: how much data the picture may use each second. Lower is cheaper and blurrier.
- Format: the way the picture is packed small. Only the ones this device can send are offered.
- Full picture every: how often a whole picture is sent. Between them only the changes are sent. A full picture lets a newcomer, or someone whose picture stumbled, catch up.

The space:
- Distance: how far away the window stands.
- Panel width: how wide the window is.

## What the numbers mean

Connection:
- Connected / Connecting / Reconnecting: whether this device is talking to the relay. It reconnects by itself.
- People here: how many are in the room.
- Round trip to the relay: how long a message takes to reach the relay and come back.
- Waiting to go out: data this device has handed over that has not left yet. If it keeps growing, the link is too slow for the data rate.
- Total arriving and Total leaving: all the data coming in and going out each second.

Sending (while the camera is on):
- Sending ... : the picture size, pictures a second, data rate and format actually being sent.
- Time to pack each picture: how long the device takes to squeeze one picture small.
- Camera is giving: what the camera itself delivers before it is made smaller.
- Full pictures sent: how many whole pictures have gone out.
- Pictures skipped (device too busy): pictures left out because the device could not keep up.
- Pictures refused (link too slow): pictures left out because too much was still waiting to go out.

Receiving, one group per other person:
- The first line: the size, pictures a second, data rate and format arriving from that person.
- Delay, camera to here: the time from their camera to this screen, with the worst seen.
- Time to unpack each picture: how long this device takes to open one picture.
- Stumbles: times a picture went missing and the panel had to wait for the next full picture.
- Waiting to be unpacked: pictures that have arrived but are not yet opened. If it grows, this device cannot keep up.

3D view:
- Pictures reach the screen directly, or by way of a copy (slower), depending on what this browser allows.
- If the 3D view stops, reload the page. If the browser cannot show the 3D view at all, sending and the numbers still work.

A "…" means the number is not known yet.

## Handing back results

Tap "Copy results". It copies the date and time, this device, the room, every setting and every number into one block of plain text, ready to paste.
