// The Tape: a local gallery of saved snapshots and recordings, kept in this browser's IndexedDB only.
// Nothing leaves the computer unless the user downloads it. Every call works without IndexedDB (private
// windows, blocked storage): it then reports `available() === false` and keeps nothing.
const DB = 'ghostjack-tape',
  STORE = 'items';
let dbp = null;
function open() {
  dbp ??= new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () =>
        r.result.createObjectStore(STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) {
      reject(e);
    }
  });
  return dbp;
}
const run = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
};
export const available = () =>
  open().then(
    () => true,
    () => false,
  );
// item: { kind: 'image' | 'video', blob, name }
export const add = (item) =>
  run('readwrite', (s) =>
    s.add({
      ...item,
      type: item.blob.type,
      size: item.blob.size,
      created: Date.now(),
    }),
  );
export const list = () =>
  run('readonly', (s) => s.getAll()).then((a) => a.reverse());
export const remove = (id) => run('readwrite', (s) => s.delete(id));
export const clear = () => run('readwrite', (s) => s.clear());

// Local file name like ghostjack-20261108-205822.jpg
export function stamp(ext, when = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `ghostjack-${when.getFullYear()}${z(when.getMonth() + 1)}${z(when.getDate())}-${z(when.getHours())}${z(when.getMinutes())}${z(when.getSeconds())}.${ext}`;
}
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
export const bytes = (n) =>
  n > 1e6
    ? `${(n / 1e6).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1e3))} KB`;
