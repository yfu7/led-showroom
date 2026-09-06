/** Short, collision-resistant ids for entities and documents. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix = ''): string {
  let s = '';
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  } else {
    for (let i = 0; i < 10; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return prefix ? `${prefix}_${s}` : s;
}
