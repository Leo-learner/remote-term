// The browser modules that are pure logic: key encoding and the compose bar's danger check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dangerReason } from '../web/app/js/danger.js';
import { KEYS, cursorKey, withModifiers } from '../web/app/js/keys.js';

test('ctrl turns letters and a few symbols into control codes; alt prefixes ESC', () => {
  assert.equal(withModifiers('c', { ctrl: true }), '\x03');
  assert.equal(withModifiers('C', { ctrl: true }), '\x03');
  assert.equal(withModifiers('[', { ctrl: true }), '\x1b');
  assert.equal(withModifiers(' ', { ctrl: true }), '\x00');
  assert.equal(withModifiers('?', { ctrl: true }), '\x7f');
  assert.equal(withModifiers('b', { alt: true }), '\x1bb');
  assert.equal(withModifiers('x', { ctrl: true, alt: true }), '\x1b\x18');
  assert.equal(withModifiers('hello', { ctrl: true }), 'hello', 'ctrl does not apply to a paste or IME commit');
  assert.equal(withModifiers('中', { ctrl: true }), '中');
  assert.equal(withModifiers('a'), 'a');
});

test('cursor keys follow application cursor mode and encode modifiers like xterm', () => {
  assert.equal(cursorKey('A'), '\x1b[A');
  assert.equal(cursorKey('A', { applicationCursor: true }), '\x1bOA');
  assert.equal(cursorKey('D', { alt: true }), '\x1b[1;3D');
  assert.equal(cursorKey('C', { ctrl: true }), '\x1b[1;5C');
  assert.equal(cursorKey('B', { ctrl: true, alt: true, applicationCursor: true }), '\x1b[1;7B');
});

test('the key bar has the keys the brief promises', () => {
  const ids = KEYS.map((key) => key.id);
  for (const id of ['esc', 'tab', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'shift-tab', 'ctrl-c', 'pipe', 'slash', 'tilde', 'paste']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('commands that would cut the Mac off ask first', () => {
  const dangerous = [
    'networksetup -setairportpower en0 off',
    'sudo networksetup -setairportpower Wi-Fi off',
    'ifconfig en0 down',
    'sudo shutdown -h now',
    'reboot',
    'cd /tmp && sudo halt',
    'pmset sleepnow',
    'osascript -e \'tell app "System Events" to shut down\'',
    'killall "Clash Verge"',
    'pkill -f clash-verge',
    'osascript -e \'quit app "Clash Verge"\'',
    'pkill -f node',
    'killall RemoteTerm',
    'launchctl bootout gui/501/dev.remote-term.agent',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -fr $HOME',
    'sudo rm -rf /',
  ];
  for (const line of dangerous) assert.ok(dangerReason(line), `should ask before: ${line}`);
});

test('everyday commands pass without a prompt', () => {
  const everyday = [
    'networksetup -setairportpower en0 on',
    'git status',
    'npm run build',
    'rm -rf node_modules',
    'rm -rf ~/Downloads/old',
    'echo shutdown is scheduled',
    'claude',
    'node agent/index.js',
    'cat ~/.ssh/config',
    'brew upgrade',
    'ls -la /',
  ];
  for (const line of everyday) assert.equal(dangerReason(line), null, `should not ask before: ${line}`);
});
