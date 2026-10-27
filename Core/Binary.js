
export class FileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC8_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  return c;
});
export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) c = CRC8_TABLE[c ^ b];
  return c;
}

export class ByteWriter {
  constructor() {
    this.bytes = [];
  }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >>> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16(v >>> 16); }
  i64(v) {
    let x = BigInt.asUintN(64, BigInt(v));
    for (let i = 0; i < 8; i++) { this.u8(Number(x & 0xffn)); x >>= 8n; }
  }
  append(values) { for (const v of values) this.u8(v); }
  toBytes() { return Uint8Array.from(this.bytes); }
}

export class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  get remaining() { return this.bytes.length - this.offset; }
  read(count) {
    if (count < 0 || this.remaining < count) throw new FileError('truncated', 'The file is shorter than its header says. It may be damaged or incomplete.');
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }
  u8() { return this.read(1)[0]; }
  u16() { const b = this.read(2); return b[0] | (b[1] << 8); }
  u32() { const b = this.read(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
  i64() {
    const b = this.read(8);
    let x = 0n;
    for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
    return Number(BigInt.asIntN(64, x));
  }
}

export const utf8 = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder().decode(bytes),
};

export function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
