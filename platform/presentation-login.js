// The presentation page's one login. A tab opened with ?presentation (or its
// first name, ?remote) asks for the show's password before the show remote's
// receiver joins anything (platform/presentation-receiver.js) and before the
// page broadcasts to its livestream room (core/broadcast.js
// broadcastGoLive). The same password opens all of it: the relay's mirror
// rooms, the broadcast, the hall the broadcaster conducts, and the drawer's
// Presentation mode. No password is written anywhere in the code: the relay
// is the only judge, through POST /auth, which answers 200 for the right one
// and 403 for any other.
//
// Two relays can judge, and the login passes if EITHER accepts: the cloud
// relay (broadcast-worker/, RELAY_HOST, or ?relay=) and the laptop's local
// one (tools/mirror-local.mjs on localhost:8800, or ?relaylocal=), which
// reads its password from the ignored file .mirror-key. Both are asked at
// once; the first 'ok' settles it. With no 'ok', any 403 is a refusal, and
// with neither answering (a timeout, no network, no local relay running) the
// verdict is 'down', which is never a refusal.
//
// At boot (presentationLogin):
//   a held password (localStorage 'mirror.pw', or ?pw= seeding it) that a
//     relay accepts, or that no relay answers about: the page goes on at
//     once, as it always has (a browser that logged in once opens offline);
//   a held password a relay refuses: forgotten, and the prompt asks again;
//   none held: the prompt asks.
// The prompt is a plain DOM card over the page, in the controller's look
// (controller.html #lock): one password field and Unlock. A typed password
// goes to the relays; 'ok' keeps it as mirror.pw and lifts the card, 'no'
// says Wrong password, 'down' says no relay answered, and it asks again.
// While its field has focus the canvas owns no keys (platform/web.js
// canvasOwnsKeys), so typing never reaches the app's shortcuts.
//
// The pure parts (the room the URL names, the relays' addresses, the verdict,
// the boot's choice, the check itself with its fetch handed in) are exported
// for tools/presentation-login.test.mjs; only presentationLogin touches the
// page.
import { RELAY_HOST } from './broadcast-socket.js';

export const PW_KEY = 'mirror.pw';
const LOCAL_RELAY = 'localhost:8800';
const CHECK_MS = 5000;
const LOCAL_RE = /^(localhost|127\.0\.0\.1|\[::1\])/;

// ?presentation[=<room>] (or ?remote[=<room>]): the flag's name and the show's
// room, as the receiver names it ('show' unless given; mirror- prefixes
// dropped, 40 characters at most). null when the page is no presentation.
export function presentationRoom(search) {
  const P = new URLSearchParams(search || '');
  const flag = P.has('presentation') ? 'presentation' : P.has('remote') ? 'remote' : '';
  if (!flag) return null;
  const room = (P.get(flag) || 'show').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^mirror-/, '') || 'show';
  return { flag, room: room.slice(0, 40) };
}

// The two /auth addresses, from the same parameters the receiver's sockets
// use (?relay=, ?relaylocal=): the cloud relay over https (plain http only
// for a relay on this machine, wrangler dev), the laptop's relay always over
// plain http, as the receiver reaches it over plain ws.
export function authUrls(search) {
  const P = new URLSearchParams(search || '');
  const cloud = P.get('relay') || RELAY_HOST, local = P.get('relaylocal') || LOCAL_RELAY;
  const c = (LOCAL_RE.test(cloud) ? 'http://' : 'https://') + cloud + '/auth', l = 'http://' + local + '/auth';
  return c === l ? [c] : [c, l];
}

// Every relay's answer ('ok', 'no', 'down') to one verdict.
export function loginVerdict(answers) {
  if (answers.indexOf('ok') >= 0) return 'ok';
  if (answers.indexOf('no') >= 0) return 'no';
  return 'down';
}

// What a boot does with the password it holds and the relays' verdict on it:
// 'go' as the page always has, 'ask' with the prompt.
export function loginStart(held, verdict) {
  if (!held) return 'ask';
  return verdict === 'no' ? 'ask' : 'go';
}

// One relay's answer: 200 'ok', 403 'no', anything else or nothing 'down'.
async function askOne(url, pw, fetchFn, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : 0;
  try {
    const r = await fetchFn(url, { method: 'POST', body: pw, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    return r.status === 200 ? 'ok' : r.status === 403 ? 'no' : 'down';
  } catch (e) {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The relays' verdict on a password: 'ok' as soon as any accepts, else, once
// all have answered or timed out, 'no' if any refused, else 'down'.
export function checkPassword(pw, urls, fetchFn = fetch, ms = CHECK_MS) {
  return new Promise(resolve => {
    const got = [];
    let left = urls.length;
    if (!left) { resolve('down'); return; }
    for (const u of urls) {
      askOne(u, pw, fetchFn, ms).then(a => {
        got.push(a);
        if (a === 'ok') resolve('ok');
        else if (--left === 0) resolve(loginVerdict(got));
      });
    }
  });
}

function readHeld() { try { return localStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; } }
export function storePassword(pw) { try { localStorage.setItem(PW_KEY, pw); } catch (e) {} }
function forgetPassword() { try { localStorage.removeItem(PW_KEY); } catch (e) {} }

// The boot's login (see the top). Resolves to the password once the page may
// go on; never rejects. Page thread only.
export async function presentationLogin() {
  const P = new URLSearchParams(location.search);
  const pr = presentationRoom(location.search);
  const urls = authUrls(location.search);
  let held = readHeld();
  // ?pw= seeds it, and is wiped from the address bar once kept
  const seed = P.get('pw');
  if (seed) {
    held = seed;
    storePassword(seed);
    P.delete('pw');
    const flag = pr ? pr.flag : 'presentation';
    const qs = P.toString().replace(new RegExp('(^|&)' + flag + '=(?=&|$)'), '$1' + flag);
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (e) {}
  }
  let note = '';
  if (held) {
    const v = await checkPassword(held, urls);
    if (loginStart(held, v) === 'go') {
      if (v === 'down') console.warn('[login] no relay answered; going on with the password this browser holds');
      return held;
    }
    forgetPassword();
    note = 'That password no longer works.';
  }
  return prompt(urls, note);
}

// ---------- the card ----------
// controller.html's #lock, its colours and sizes, in a style element of its
// own so nothing of the app's page styles reaches it.
const CSS = '#present-login{position:fixed;inset:0;z-index:1100;display:grid;place-items:center;padding:16px;' +
  'background:#0b0d12;color:#e8ecf4;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
  '#present-login *{box-sizing:border-box}' +
  '#present-login form{display:grid;gap:12px;width:min(340px,100%);text-align:center}' +
  '#present-login h1{font-size:22px;margin:0 0 4px}' +
  '#present-login input{height:54px;font:inherit;font-size:20px;text-align:center;border-radius:8px;' +
  'border:1px solid #262c3a;background:#0f1219;color:#e8ecf4;padding:0 10px}' +
  '#present-login button{height:54px;padding:0 18px;border-radius:10px;border:1px solid #262c3a;background:#1d2230;' +
  'color:#e8ecf4;font:inherit;font-weight:600;font-size:16px;touch-action:manipulation}' +
  '#present-login .msg{min-height:20px;color:#ff7a7a;font-size:14px}';

function prompt(urls, note) {
  return new Promise(resolve => {
    const style = document.createElement('style');
    style.textContent = CSS;
    const card = document.createElement('div');
    card.id = 'present-login';
    card.innerHTML = '<form autocomplete="on"><h1>Presentation</h1>' +
      '<input type="password" placeholder="password" autocomplete="current-password" aria-label="Presentation password">' +
      '<button type="submit">Unlock</button><div class="msg" role="status"></div></form>';
    document.head.appendChild(style);
    document.body.appendChild(card);
    const form = card.querySelector('form'), input = card.querySelector('input'), msg = card.querySelector('.msg');
    msg.textContent = note || '';
    input.focus();
    let busy = false;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const pw = input.value;
      if (busy || !pw) return;
      busy = true;
      msg.style.color = '#8a93a6';
      msg.textContent = 'checking…';
      const v = await checkPassword(pw, urls);
      msg.style.color = '';
      busy = false;
      if (v === 'ok') {
        storePassword(pw);
        card.remove();
        style.remove();
        resolve(pw);
        return;
      }
      msg.textContent = v === 'no' ? 'Wrong password.' : 'Can\'t reach the relay. Check the internet, or start the local relay.';
      input.select();
    });
  });
}
