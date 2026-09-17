// Copies the browser builds of xterm.js into web/app/vendor (served only after login). No bundler:
// the app loads plain ES modules, which keeps the CSP at script-src 'self'.
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = `${root}web/node_modules/@xterm/`;
const to = `${root}web/app/vendor/`;

const files = [
  ['xterm/lib/xterm.mjs', 'xterm.mjs'],
  ['xterm/css/xterm.css', 'xterm.css'],
  ['addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['addon-unicode11/lib/addon-unicode11.mjs', 'addon-unicode11.mjs'],
  ['addon-webgl/lib/addon-webgl.mjs', 'addon-webgl.mjs'],
];

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
for (const [source, target] of files) await cp(from + source, to + target);
console.log(`copied ${files.length} files to web/app/vendor`);
