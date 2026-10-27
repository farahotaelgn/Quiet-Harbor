import { ByteWriter, crc8, utf8 } from './Binary.js';

export const RING = {
  service: '14839ac4-7d7e-415c-9a42-167340cf2339',
  notify: '0734594a-a8e7-4b1a-a6b1-cd5243059a57',
  write: '8b00ace7-eb0b-49b0-bbe9-9aee0a26e1a3',
  writeChunkSize: 20,
  namePatterns: ['O2Ring', 'Checkme_O2', 'CheckO2', 'SleepU', 'SleepO2', 'WearO2', 'KidsO2', 'BabyO2', 'Oxylink'],
};

export const COMMAND = { fileOpen: 0x03, fileRead: 0x04, fileClose: 0x05, info: 0x14, ping: 0x15, config: 0x16, readSensors: 0x17 };

const pad = (n) => String(n).padStart(2, '0');
export function request(command, block = 0, payload = new Uint8Array()) {
  const w = new ByteWriter();
  w.u8(0xaa);
  w.u8(command);
  w.u8(~command);
  w.u16(block);
  w.u16(payload.length);
  w.append(payload);
  w.u8(crc8(w.bytes));
  return w.toBytes();
}

export const formatClock = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())},${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const setTimeRequest = (ms) => request(COMMAND.config, 0, utf8.encode(`{"SetTIME":"${formatClock(ms)}"}`));
export const fileOpenRequest = (name) => request(COMMAND.fileOpen, 0, utf8.encode(name + '\0'));
export class ResponseAssembler {
  constructor() { this.buffer = []; }
  reset() { this.buffer = []; }
  append(chunk) {
    this.buffer.push(...chunk);
    const b = this.buffer;
    if (!b.length) return null;
    if (b[0] !== 0x55) { this.reset(); throw new Error('The ring sent data that is not a response packet.'); }
    if (b.length < 7) return null;
    if (b[2] !== (~b[1] & 0xff)) { this.reset(); throw new Error("The ring's response header is damaged."); }
    const total = (b[5] | (b[6] << 8)) + 8;
    if (b.length < total) return null;
    const packet = b.slice();
    this.reset();
    if (packet.length !== total) throw new Error("The ring sent more data than its response header announced.");
    if (crc8(packet.slice(0, -1)) !== packet[total - 1]) throw new Error("The ring's response failed its checksum.");
    return { status: packet[1], block: packet[3] | (packet[4] << 8), payload: Uint8Array.from(packet.slice(7, total - 1)) };
  }
}
export function parseLive(payload) {
  if (payload.length < 12) return null;
  const finger = payload[11] !== 0;
  return {
    spo2: finger && payload[0] >= 10 && payload[0] <= 100 ? payload[0] : null,
    pulse: finger && payload[1] >= 25 && payload[1] <= 250 ? payload[1] : null,
    battery: Math.min(payload[7], 100),
    charging: ({ 0: 'no', 1: 'charging', 2: 'full' })[payload[8]] ?? 'unknown',
    motion: payload[9],
    signalStrength: payload[10],
    fingerDetected: finger,
  };
}

export function parseInfo(payload) {
  const text = utf8.decode(payload).replace(/[\s\0]+$/g, '').replace(/^[\s\0]+/g, '');
  const json = JSON.parse(text);
  const fields = Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v)]));
  const fileNames = (fields.FileList ?? '').split(',').filter(Boolean);
  let deviceTime = null;
  const m = /^(\d{4})-(\d{2})-(\d{2}),(\d{2}):(\d{2}):(\d{2})$/.exec(fields.CurTIME ?? '');
  if (m) deviceTime = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return { fields, fileNames, deviceTime };
}
export class RingClient {
  static clockTolerance = 60_000;

  constructor() {
    this.step = null;
    this.assembler = new ResponseAssembler();
    this.queue = [];
    this.fileData = [];
    this.fileSize = 0;
    this.block = 0;
  }

  get isBusy() { return this.step !== null; }
  get downloadingFile() { return this.step && ['fileOpen', 'fileRead'].includes(this.step.kind) ? this.step.name : null; }
  get queuedFileCount() { return this.queue.length; }

  start() {
    this.step = null;
    this.queue = [];
    this.assembler.reset();
    return this.#send({ kind: 'info' }, request(COMMAND.info));
  }

  requestInfo() {
    if (this.step || this.queue.length) return [];
    return this.#send({ kind: 'info' }, request(COMMAND.info));
  }

  pollLive() {
    if (this.step || this.queue.length) return [];
    return this.#send({ kind: 'live' }, request(COMMAND.readSensors));
  }

  download(names) {
    for (const n of names) if (!this.queue.includes(n) && n !== this.downloadingFile) this.queue.push(n);
    return this.#nextFile();
  }

  timeout() {
    const stalled = this.step;
    this.step = null;
    this.assembler.reset();
    const what = !stalled ? 'a request'
      : ['fileOpen', 'fileRead'].includes(stalled.kind) ? `downloading ${stalled.name}`
      : { live: 'reading live values', info: 'reading ring info', setTime: 'setting the clock', fileClose: 'closing a file' }[stalled.kind];
    return [{ type: 'failed', message: `The ring stopped answering while ${what}.` }, ...this.#nextFile()];
  }

  receive(chunk, now = Date.now()) {
    let response;
    try {
      response = this.assembler.append(chunk);
      if (!response) return [];
    } catch (error) {
      return [{ type: 'failed', message: error.message }];
    }
    const current = this.step;
    if (!current) return [];
    this.step = null;
    const ok = response.status === 0;

    switch (current.kind) {
      case 'info': {
        let info;
        try {
          if (!ok) throw new Error();
          info = parseInfo(response.payload);
        } catch {
          return [{ type: 'failed', message: "The ring's info could not be read." }];
        }
        const out = [{ type: 'info', info }];
        if (info.deviceTime != null && Math.abs(info.deviceTime - now) > RingClient.clockTolerance) {
          return [...out, ...this.#send({ kind: 'setTime' }, setTimeRequest(now))];
        }
        return [...out, ...this.#nextFile()];
      }
      case 'setTime':
        return [...(ok ? [] : [{ type: 'failed', message: "The ring's clock could not be set." }]), ...this.#nextFile()];
      case 'live': {
        const reading = ok ? parseLive(response.payload) : null;
        return [...(reading ? [{ type: 'live', reading }] : []), ...this.#nextFile()];
      }
      case 'fileOpen': {
        const p = response.payload;
        if (!ok || p.length < 4) {
          return [{ type: 'failed', message: `${current.name} could not be opened on the ring.` }, ...this.#send({ kind: 'fileClose' }, request(COMMAND.fileClose))];
        }
        this.fileSize = (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0;
        this.fileData = [];
        this.block = 0;
        if (this.fileSize === 0) return this.#send({ kind: 'fileClose' }, request(COMMAND.fileClose));
        return [{ type: 'progress', file: current.name, received: 0, total: this.fileSize },
          ...this.#send({ kind: 'fileRead', name: current.name }, request(COMMAND.fileRead, this.block))];
      }
      case 'fileRead': {
        if (!ok || !response.payload.length) {
          return [{ type: 'failed', message: `Downloading ${current.name} failed.` }, ...this.#send({ kind: 'fileClose' }, request(COMMAND.fileClose))];
        }
        this.fileData.push(...response.payload);
        if (this.fileData.length >= this.fileSize) {
          return [{ type: 'progress', file: current.name, received: this.fileSize, total: this.fileSize },
            { type: 'file', name: current.name, data: Uint8Array.from(this.fileData.slice(0, this.fileSize)) },
            ...this.#send({ kind: 'fileClose' }, request(COMMAND.fileClose))];
        }
        this.block = (this.block + 1) & 0xffff;
        return [{ type: 'progress', file: current.name, received: this.fileData.length, total: this.fileSize },
          ...this.#send({ kind: 'fileRead', name: current.name }, request(COMMAND.fileRead, this.block))];
      }
      case 'fileClose':
        return this.#nextFile();
    }
    return [];
  }

  #nextFile() {
    if (this.step || !this.queue.length) return [];
    const name = this.queue.shift();
    return this.#send({ kind: 'fileOpen', name }, fileOpenRequest(name));
  }

  #send(step, data) {
    this.step = step;
    return [{ type: 'send', data }];
  }
}
