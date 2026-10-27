
const ITERATIONS = 310_000;
const CHECK = 'vault-ok';

const toBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const serialize = (value) => JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? { $bytes: toBase64(v) } : v));
const deserialize = (text) => JSON.parse(text, (_, v) => (v && typeof v === 'object' && typeof v.$bytes === 'string' ? fromBase64(v.$bytes) : v));

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(serialize(value))));
  return { iv: toBase64(iv), data: toBase64(data) };
}

export async function unseal(key, sealed) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
  return deserialize(new TextDecoder().decode(plain));
}
export async function createVault(password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, iterations);
  return { vault: { salt: toBase64(salt), iterations, check: await seal(key, CHECK) }, key };
}
export async function openVault(vault, password) {
  const key = await deriveKey(password, fromBase64(vault.salt), vault.iterations);
  try {
    return (await unseal(key, vault.check)) === CHECK ? key : null;
  } catch {
    return null;
  }
}
