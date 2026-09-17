import { fromB64u } from '/shared/bytes.js';
import { describeError, pair } from '/lib/auth.js';
import { passkeysSupported } from '/lib/passkey.js';

const message = document.getElementById('message');
const button = document.getElementById('create');
const nameInput = document.getElementById('device-name');

function say(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`;
}

// The secret is only ever in the fragment, which the browser does not send to the server.
// Take it out of the address bar and history right away.
let secret = null;
try {
  secret = fromB64u(location.hash.slice(1), 32);
} catch {
  secret = null;
}
history.replaceState(null, '', location.pathname);

const ua = navigator.userAgent;
nameInput.value = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Browser';

if (!secret) {
  button.disabled = true;
  say('二维码不完整，请在电脑上重新生成后再扫描', 'error');
} else if (!passkeysSupported()) {
  button.disabled = true;
  say('这个浏览器不支持通行密钥，请用 Safari 打开这个页面', 'error');
}

button.addEventListener('click', async () => {
  button.disabled = true;
  say('');
  try {
    await pair(secret, nameInput.value.trim() || 'iPhone');
    secret = null;
    document.getElementById('step-start').hidden = true;
    document.getElementById('step-done').hidden = false;
  } catch (error) {
    say(describeError(error), error.code === 'cancelled' ? '' : 'error');
    button.disabled = ['pairing-closed', 'already-registered'].includes(error.code);
  }
});
