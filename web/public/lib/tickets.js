// The resume ticket lives in IndexedDB. Its key is imported as a non-extractable CryptoKey before
// it is stored, so scripts on this site can use it but never read it back out.
import { fromB64u } from '/shared/bytes.js';
import { importTicketKey } from '/shared/channel.js';

const DB_NAME = 'harbor';
const STORE = 'tickets';
const CURRENT = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

// plain: { tid, k, cid } as the Mac sealed it
export async function saveTicket(plain) {
  const key = await importTicketKey(fromB64u(plain.k, 32));
  await withStore('readwrite', (store) => store.put({ tid: plain.tid, key, cid: plain.cid, savedAt: Date.now() }, CURRENT));
}

export async function loadTicket() {
  try {
    return (await withStore('readonly', (store) => store.get(CURRENT))) ?? null;
  } catch {
    return null;
  }
}

export async function clearTicket() {
  try {
    await withStore('readwrite', (store) => store.delete(CURRENT));
  } catch {
    // nothing stored
  }
}
