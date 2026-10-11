// MIDI in, first light: every note that reaches Chrome from any MIDI input
// (Max's [noteout] into the Mac's IAC bus, say) is printed to the console as
// [midi] lines. Nothing acts on them yet. Page thread only: Web MIDI lives
// on the window, whichever thread the engine runs on.
//
// Chrome asks permission for any MIDI access, so it is opt-in: always on
// localhost, and on the live site once the page is opened with ?midi (this
// machine then remembers; ?midi=0 forgets).

let midiOn = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
try {
  const q = new URLSearchParams(location.search).get('midi');
  if (q === '0') localStorage.removeItem('signal.midi');
  else if (q !== null) localStorage.setItem('signal.midi', '1');
  if (localStorage.getItem('signal.midi') === '1') midiOn = true;
} catch (e) {}

if (!midiOn) {
  // opt-in only; see above
} else if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(access => {
    const listen = input => {
      input.onmidimessage = e => {
        const [st, note, vel] = e.data;
        const kind = st & 0xf0, ch = (st & 0x0f) + 1;
        if (kind === 0x90 && vel > 0) console.log(`[midi] note ON  ${note} vel ${vel} ch ${ch} from "${input.name}"`);
        else if (kind === 0x80 || kind === 0x90) console.log(`[midi] note off ${note} ch ${ch} from "${input.name}"`);
      };
    };
    access.inputs.forEach(listen);
    console.log('[midi] listening to: ' + (Array.from(access.inputs.values()).map(i => i.name).join(', ') || 'no inputs yet'));
    // a port that appears later (the IAC bus switched on, Max opened) is
    // picked up as it arrives
    access.onstatechange = e => {
      if (e.port.type === 'input' && e.port.state === 'connected' && !e.port.onmidimessage) {
        listen(e.port);
        console.log(`[midi] new input: "${e.port.name}"`);
      }
    };
  }, err => console.log('[midi] access refused: ' + err.message));
} else {
  console.log('[midi] this browser has no Web MIDI');
}
