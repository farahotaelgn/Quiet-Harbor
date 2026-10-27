
export const DEFAULT_SAMPLE_INTERVAL = 4;

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function makeSession(fields) {
  return {
    id: newId(),
    sampleInterval: DEFAULT_SAMPLE_INTERVAL,
    deviceName: null,
    rawData: null,
    rawFormat: null,
    sourceFileName: null,
    ...fields,
  };
}

export const duration = (s) => s.samples.length * s.sampleInterval;
export const isRawOnly = (s) => s.samples.length === 0 && s.rawData != null;
export const sampleDate = (s, i) => s.startDate + i * s.sampleInterval * 1000;
export function demoSession(startDate = 1_767_225_600_000) {
  let seed = 221;
  const noise = () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return ((seed >>> 16) % 3) - 1;
  };
  const dips = [[150, 158], [400, 410], [640, 646]];
  const samples = Array.from({ length: 900 }, (_, i) => {
    const inDip = dips.some(([a, b]) => i >= a && i < b);
    const spo2 = (inDip ? 88 : 96) + noise();
    const pulse = (inDip ? 72 : 62) + noise() * 2;
    return { spo2, pulse, motion: i % 97 === 0 ? 3 : 0 };
  });
  return makeSession({ startDate, samples, deviceName: 'Demo' });
}
