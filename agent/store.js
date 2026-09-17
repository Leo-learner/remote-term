// Small JSON state files in the agent's config directory: written atomically, mode 600, and
// serialized per file so a slow write can never land after a newer one.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.value = structuredClone(fallback);
    this.tail = Promise.resolve();
  }

  async load() {
    this.value = await readJson(this.file, structuredClone(this.fallback));
    return this.value;
  }

  // Captures the value now, writes it after any earlier write finishes.
  save() {
    const snapshot = structuredClone(this.value);
    this.tail = this.tail.then(() => writeJson(this.file, snapshot));
    return this.tail;
  }
}
