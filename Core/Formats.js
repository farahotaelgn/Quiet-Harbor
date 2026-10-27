import { ByteReader, ByteWriter, FileError, concatBytes, crc32, utf8 } from './Binary.js';
import { DEFAULT_SAMPLE_INTERVAL, makeSession, sampleDate, duration } from './Session.js';
import { report, countDesaturations } from './Report.js';

const INVALID = 0xff;
export const FORMATS = ['dat', 'bin', 'spo2', 'backup'];

const encodeSample = (s) => [s.spo2 ?? INVALID, s.pulse ?? INVALID, s.motion];

function decodeSample(b0, b1, b2, validate) {
  if (validate && !((b0 === INVALID || b0 <= 100) && (b1 === INVALID || b1 <= 250))) {
    throw new FileError('invalidSamples', 'The file contains out-of-range values, so it is not a valid .bin stream.');
  }
  return { spo2: b0 === INVALID ? null : b0, pulse: b1 === INVALID ? null : b1, motion: b2 };
}

const clampByte = (v) => Math.max(0, Math.min(255, Math.trunc(v)));
const clampU16 = (v) => Math.max(0, Math.min(65535, Math.trunc(v)));
const pad = (n, w = 2) => String(n).padStart(w, '0');

export const BinFile = {
  encode: (samples) => Uint8Array.from(samples.flatMap(encodeSample)),
  decode(bytes) {
    if (!bytes.length) throw new FileError('emptyFile', 'The file is empty.');
    if (bytes.length % 3) throw new FileError('invalidSamples', 'The file contains out-of-range values, so it is not a valid .bin stream.');
    const out = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(decodeSample(bytes[i], bytes[i + 1], bytes[i + 2], true));
    return out;
  },
};

const MAGIC = [0x46, 0x48, 0x53, 0x32]; // "FHS2"

function uuidBytes(id) {
  const hex = id.replace(/-/g, '');
  return Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function uuidString(bytes) {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const Spo2File = {
  encode(session) {
    const w = new ByteWriter();
    w.append(MAGIC);
    w.u16(1);
    w.u16(0);
    w.append(uuidBytes(session.id));
    w.i64(Math.round(session.startDate));
    w.u32(Math.round(session.sampleInterval * 1000));
    w.u32(session.samples.length);
    const name = utf8.encode(session.deviceName ?? '').subarray(0, 65535);
    w.u16(name.length);
    w.append(name);
    for (const s of session.samples) w.append(encodeSample(s));
    const code = session.rawData == null ? 0 : { dat: 1, bin: 2, spo2: 3 }[session.rawFormat] ?? 0;
    const raw = code ? session.rawData : new Uint8Array();
    w.u8(code);
    w.u32(raw.length);
    w.append(raw);
    w.u32(crc32(w.bytes));
    return w.toBytes();
  },
  decode(bytes) {
    if (bytes.length < 4) throw bytes.length ? new FileError('badMagic', 'This is not a valid .spo2 file.') : new FileError('emptyFile', 'The file is empty.');
    if (!MAGIC.every((b, i) => bytes[i] === b)) throw new FileError('badMagic', 'This is not a valid .spo2 file.');
    if (bytes.length < 8) throw new FileError('truncated', 'The file is shorter than its header says.');
    const r = new ByteReader(bytes);
    r.read(4);
    const version = r.u16();
    if (version !== 1) throw new FileError('unsupportedVersion', `This file uses format version ${version}, which this app version cannot read.`);
    r.u16();
    const id = uuidString(r.read(16));
    const startDate = r.i64();
    const interval = r.u32() / 1000;
    const count = r.u32();
    const name = utf8.decode(r.read(r.u16()));
    if (r.remaining < count * 3) throw new FileError('truncated', 'The file is shorter than its header says.');
    const samples = [];
    for (let i = 0; i < count; i++) {
      const b = r.read(3);
      samples.push(decodeSample(b[0], b[1], b[2], false));
    }
    const rawFormat = { 1: 'dat', 2: 'bin', 3: 'spo2' }[r.u8()] ?? null;
    const raw = r.read(r.u32());
    const stored = r.u32();
    if (r.remaining !== 0 || stored !== crc32(bytes.subarray(0, bytes.length - 4))) {
      throw new FileError('checksumMismatch', "The file's checksum does not match. It is damaged.");
    }
    return makeSession({
      id, startDate, sampleInterval: interval, samples,
      deviceName: name || null,
      rawData: rawFormat ? Uint8Array.from(raw) : null,
      rawFormat,
    });
  },
};

const DAT_HEADER = 40;
const DAT_RECORD = 5;
const DAT_INTERVALS = [1, 2, 4];
const DAT_EXPORT_VERSIONS = { 4: 3, 2: 5 };

export const DatFile = {
  fileName(session) {
    const d = new Date(session.startDate);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.dat`;
  },

  decode(bytes) {
    if (!bytes.length) throw new FileError('emptyFile', 'The file is empty.');
    if (bytes.length < DAT_HEADER) throw new FileError('truncated', 'The file is shorter than its header says.');
    const r = new ByteReader(bytes);
    const version = r.u16();
    if (version !== 3 && version !== 5) throw new FileError('unsupportedVersion', `This file uses format version ${version}, which this app version cannot read.`);
    const year = r.u16(), month = r.u8(), day = r.u8(), hour = r.u8(), minute = r.u8(), second = r.u8();
    r.u32();
    const durationSeconds = r.u16();
    const start = new Date(year, month - 1, day, hour, minute, second).getTime();
    const count = Math.floor((bytes.length - DAT_HEADER) / DAT_RECORD);
    if (count === 0) return { startDate: start, sampleInterval: DEFAULT_SAMPLE_INTERVAL, samples: [] };
    const measured = durationSeconds / count;
    const interval = DAT_INTERVALS.find((v) => Math.abs(v - measured) < 0.05);
    if (interval == null) throw new FileError('invalidSamples', 'Unexpected sample timing.');
    const samples = [];
    for (let i = 0; i < count; i++) {
      const o = DAT_HEADER + i * DAT_RECORD;
      const invalid = bytes[o + 2] !== 0 || bytes[o] < 10 || bytes[o] > 100;
      samples.push({
        spo2: invalid ? null : bytes[o],
        pulse: bytes[o + 1] === 0 || bytes[o + 1] === INVALID ? null : bytes[o + 1],
        motion: bytes[o + 3],
      });
    }
    return { startDate: start, sampleInterval: interval, samples };
  },
  record(s) {
    const spo2 = s.spo2 != null && s.spo2 >= 61 ? Math.min(s.spo2, 99) : null;
    if (spo2 == null && s.pulse == null) return [INVALID, INVALID, INVALID, s.motion, 0];
    return [spo2 ?? INVALID, s.pulse ?? INVALID, 0, s.motion, 0];
  },

  encode(session) {
    const version = DAT_EXPORT_VERSIONS[session.sampleInterval];
    const d = new Date(session.startDate);
    const year = d.getFullYear();
    if (!session.samples.length || !version || duration(session) > 65535 || year < 2015 || year > 2059) {
      throw new FileError('nothingToExport', 'This session has no data that can be saved as .dat.');
    }
    const spo2 = session.samples.map((s) => s.spo2);
    const valid = spo2.filter((v) => v != null);
    const rep = report(session);
    const drops4 = countDesaturations(spo2, session.sampleInterval, 4);
    let runsBelow90 = 0;
    spo2.forEach((v, i) => {
      const prev = i ? spo2[i - 1] : null;
      if ((v ?? 100) < 90 && (prev ?? 100) >= 90) runsBelow90++;
    });
    const w = new ByteWriter();
    w.u16(version);
    w.u16(year);
    [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].forEach((v) => w.u8(v));
    w.u32(DAT_HEADER + session.samples.length * DAT_RECORD);
    w.u16(duration(session));
    w.u16(0);
    w.u8(clampByte(Math.round(rep.averageSpO2 ?? 0)));
    w.u8(clampByte(valid.length ? Math.min(...valid) : 0));
    w.u8(clampByte(rep.desaturationEvents));
    w.u8(clampByte(drops4));
    w.u8(0);
    w.u16(clampU16(rep.timeBelow90));
    w.u8(clampByte(runsBelow90));
    w.u8(0);
    while (w.bytes.length < DAT_HEADER) w.u8(0);
    for (const s of session.samples) w.append(DatFile.record(s));
    return w.toBytes();
  },
};

// 1.6.6: the .spo2 OSCAR opens (Data › Oximetry Wizard), the same layout as the Oxi Converter's
// (OSCAR cms50_loader readSpoRFile): u16 856 at byte 0 · byte 856 = 1 · "BLE" at 864 (UTF-16)
// · year month day hour minute second at 1056 (u32 each, local time) · seconds at 1080 · one SpO2, pulse pair a second from 1084.
// 0x7F / 0xFF = no reading.
const OSCAR_POS = 856;
const OSCAR_DATA = 1084;
const NO_SPO2 = 0x7f;
const NO_PULSE = 0xff;
const putU32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
const getU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const isFhs2 = (bytes) => bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);

export const OscarSpo2File = {
  // each sample fills its whole interval (a 4 s reading = 4 seconds); a missing SpO2 or pulse = no reading
  encode(session) {
    const step = Math.round(session.sampleInterval);
    const seconds = session.samples.length * step;
    if (!seconds || step < 1) throw new FileError('nothingToExport', 'This session has no data that can be saved as .spo2.');
    const b = new Uint8Array(OSCAR_DATA + seconds * 2);
    b[0] = OSCAR_POS & 255;
    b[1] = OSCAR_POS >> 8;
    b[OSCAR_POS] = 1;
    b[864] = 0x42; b[866] = 0x4c; b[868] = 0x45;
    const d = new Date(session.startDate);
    [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].forEach((v, i) => putU32(b, 1056 + i * 4, v));
    putU32(b, 1080, seconds);
    let o = OSCAR_DATA;
    for (const s of session.samples) {
      const ok = s.spo2 != null && s.pulse != null && s.spo2 <= 100 && s.pulse <= 250;
      for (let k = 0; k < step; k++) {
        b[o++] = ok ? s.spo2 : NO_SPO2;
        b[o++] = ok ? s.pulse : NO_PULSE;
      }
    }
    return b;
  },

  // reads it back the way OSCAR does; 4 identical seconds in a row everywhere = a 4 s recording again
  decode(bytes) {
    if (!bytes.length) throw new FileError('emptyFile', 'The file is empty.');
    const pos = bytes[0] | (bytes[1] << 8);
    const data = pos + 228;
    if (pos < 2 || bytes.length < data) throw new FileError('badMagic', 'This is not a .spo2 file Quiet Harbor or OSCAR can read.');
    const count = getU32(bytes, pos + 224);
    if (!count) throw new FileError('nothingToExport', 'This .spo2 file has no readings.');
    const per = Math.floor((bytes.length - data) / count);
    if (per !== 2 && per !== 4) throw new FileError('truncated', 'The file is shorter than its header says.');
    const t = [0, 1, 2, 3, 4, 5].map((i) => getU32(bytes, pos + 200 + i * 4));
    const startDate = new Date(t[0], t[1] - 1, t[2], t[3], t[4], t[5]).getTime();
    if (!Number.isFinite(startDate) || t[0] < 2000) throw new FileError('badMagic', 'This .spo2 file has no valid start time.');
    const secs = [];
    for (let i = 0; i < count; i++) {
      const o = data + i * per + (per - 2);
      const o2 = bytes[o], pr = bytes[o + 1];
      const gone = (o2 === NO_SPO2 && pr === NO_PULSE) || o2 > 100 || o2 < 10 || pr < 25 || pr > 250;
      secs.push(gone ? { spo2: null, pulse: null, motion: 0 } : { spo2: o2, pulse: pr, motion: 0 });
    }
    const same = (a, b) => a.spo2 === b.spo2 && a.pulse === b.pulse;
    const fours = secs.length % 4 === 0 && secs.every((s, i) => same(s, secs[i - (i % 4)]));
    return {
      startDate,
      sampleInterval: fours ? 4 : 1,
      samples: fours ? secs.filter((_, i) => i % 4 === 0) : secs,
    };
  },
};

export function importFile(bytes, fileName, fileDate = Date.now()) {
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  let result;
  if (ext === 'spo2' && (isFhs2(bytes) || !bytes.length)) {
    result = { session: Spo2File.decode(bytes), warning: null };
  } else if (ext === 'spo2') {
    result = { session: makeSession({ ...OscarSpo2File.decode(bytes), rawData: bytes, rawFormat: 'spo2' }), warning: null };
  } else if (ext === 'bin') {
    result = { session: makeSession({ startDate: fileDate, samples: BinFile.decode(bytes), rawData: bytes, rawFormat: 'bin' }), warning: null };
  } else if (ext === 'dat') {
    try {
      const c = DatFile.decode(bytes);
      result = { session: makeSession({ ...c, rawData: bytes, rawFormat: 'dat' }), warning: null };
    } catch {
      if (!bytes.length) throw new FileError('emptyFile', 'The file is empty.');
      result = {
        session: makeSession({ startDate: fileDate, samples: [], rawData: bytes, rawFormat: 'dat' }),
        warning: "This .dat file uses a layout this app cannot chart yet, so the original file was kept unchanged.",
      };
    }
  } else {
    throw new FileError('unknownExtension', `“.${ext}” files are not supported. Use .dat, .bin or .spo2.`);
  }
  result.session.sourceFileName = fileName;
  return result;
}
export function exportFile(session, format) {
  if (format === 'backup') return Spo2File.encode(session);
  if (format === 'spo2') {
    if (session.rawFormat === 'spo2' && session.rawData) return session.rawData;
    return OscarSpo2File.encode(session);
  }
  if (format === 'bin') {
    if (session.rawFormat === 'bin' && session.rawData) return session.rawData;
    if (!session.samples.length) throw new FileError('nothingToExport', 'This session has no data that can be saved as .bin.');
    return BinFile.encode(session.samples);
  }
  if (session.rawFormat === 'dat' && session.rawData) return session.rawData;
  return DatFile.encode(session);
}

export function canExport(session, format) {
  try {
    exportFile(session, format);
    return true;
  } catch {
    return false;
  }
}

export function fileName(session, format, prefix = 'Session') {
  if (format === 'dat') return DatFile.fileName(session);
  const d = new Date(session.startDate);
  const base = `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return format === 'backup' ? `${base}-backup.spo2` : `${base}.${format}`;
}

function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? 'Z' : `${off > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

export function csv(session) {
  const lines = ['Time,SpO2,Pulse,Motion'];
  session.samples.forEach((s, i) => lines.push(`${isoLocal(sampleDate(session, i))},${s.spo2 ?? ''},${s.pulse ?? ''},${s.motion}`));
  return lines.join('\n') + '\n';
}

export { concatBytes };
