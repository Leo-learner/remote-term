import { describeError, login } from '/lib/auth.js';
import { passkeysSupported } from '/lib/passkey.js';

const button = document.getElementById('login');
const message = document.getElementById('message');

function say(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`;
}

if (!passkeysSupported()) {
  button.disabled = true;
  say('这个浏览器不支持通行密钥，请用 Safari 打开', 'error');
}

button.addEventListener('click', async () => {
  button.disabled = true;
  say('');
  try {
    await login();
    location.replace('/app/');
  } catch (error) {
    say(describeError(error), error.code === 'cancelled' ? '' : 'error');
    button.disabled = false;
  }
});
