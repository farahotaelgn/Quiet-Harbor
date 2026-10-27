import { ByteReader, ByteWriter, FileError, concatBytes, crc32, utf8 } from './Binary.js';
import { DEFAULT_SAMPLE_INTERVAL, makeSession, sampleDate, duration } from './Session.js';
import { report, countDesaturations } from './Report.js';

const INVALID = 0xff;
export const FORMATS = ['dat', 'bin', 'spo2'];

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
    const code = session.rawData == null ? 0 : { dat: 1, bin: 2 }[session.rawFormat] ?? 0;
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
    const rawFormat = { 1: 'dat', 2: 'bin' }[r.u8()] ?? null;
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

export function importFile(bytes, fileName, fileDate = Date.now()) {
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  let result;
  if (ext === 'spo2') {
    result = { session: Spo2File.decode(bytes), warning: null };
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
  if (format === 'spo2') return Spo2File.encode(session);
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
  return `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${format}`;
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
