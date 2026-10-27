import { RING, RingClient } from './Core/Ring.js';

const RESPONSE_TIMEOUT = 5000;
const LIVE_POLL_INTERVAL = 2000;

export class RingConnection extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.writeCharacteristic = null;
    this.client = new RingClient();
    this.state = 'disconnected'; // disconnected | connecting | ready
    this.ringInfo = null;
    this.live = null;
    this.download = null;
    this.downloadedCount = 0;
    this.lastError = null;
    this.packetLog = [];
    this.liveEnabled = false;
    this.writeChain = Promise.resolve();
    this.timeoutTimer = null;
    this.liveTimer = null;
  }

  static get isSupported() { return 'bluetooth' in navigator; }

  get name() { return this.device?.name ?? 'ring'; }

  async connect(showAllDevices = false) {
    this.lastError = null;
    const options = showAllDevices
      ? { acceptAllDevices: true, optionalServices: [RING.service] }
      : { filters: [...RING.namePatterns.map((namePrefix) => ({ namePrefix })), { services: [RING.service] }], optionalServices: [RING.service] };
    try {
      this.device = await navigator.bluetooth.requestDevice(options);
    } catch (error) {
      if (error.name !== 'NotFoundError') this.#fail(error.message); // NotFoundError = chooser cancelled
      return;
    }
    this.device.addEventListener('gattserverdisconnected', () => this.#reset('disconnected'));
    this.state = 'connecting';
    this.#changed();
    try {
      const server = await this.device.gatt.connect();
      let service;
      try {
        service = await server.getPrimaryService(RING.service);
      } catch {
        throw new Error(`${this.name} does not offer the O2 ring service, so this app cannot talk to it.`);
      }
      const notify = await service.getCharacteristic(RING.notify);
      this.writeCharacteristic = await service.getCharacteristic(RING.write);
      notify.addEventListener('characteristicvaluechanged', (event) => {
        const v = event.target.value;
        const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
        this.#log('RX', bytes);
        this.#process(this.client.receive(bytes));
      });
      await notify.startNotifications();
      this.state = 'ready';
      this.#process(this.client.start());
      this.#updateLiveTimer();
    } catch (error) {
      this.#fail(error.message);
      this.disconnect();
    }
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.#reset('disconnected');
  }

  downloadFiles(names) {
    if (this.state !== 'ready' || !names.length) return;
    this.downloadedCount = 0;
    this.#process(this.client.download(names));
  }

  refresh() { this.#process(this.client.requestInfo()); }

  setLiveEnabled(enabled) {
    this.liveEnabled = enabled;
    this.#updateLiveTimer();
  }

  #process(outputs) {
    for (const o of outputs) {
      if (o.type === 'send') this.#write(o.data);
      else if (o.type === 'info') this.ringInfo = o.info;
      else if (o.type === 'live') this.live = o.reading;
      else if (o.type === 'progress') this.download = { file: o.file, received: o.received, total: o.total, remaining: this.client.queuedFileCount };
      else if (o.type === 'file') {
        this.downloadedCount++;
        this.dispatchEvent(new CustomEvent('file', { detail: { name: o.name, data: o.data, ringName: this.name } }));
      } else if (o.type === 'failed') this.lastError = o.message;
    }
    if (!this.client.downloadingFile && !this.client.queuedFileCount) this.download = null;
    clearTimeout(this.timeoutTimer);
    if (this.client.isBusy) this.timeoutTimer = setTimeout(() => this.#process(this.client.timeout()), RESPONSE_TIMEOUT);
    this.#changed();
  }
  #write(data) {
    const characteristic = this.writeCharacteristic;
    if (!characteristic) return;
    this.#log('TX', data);
    this.writeChain = this.writeChain.then(async () => {
      for (let i = 0; i < data.length; i += RING.writeChunkSize) {
        const chunk = data.slice(i, i + RING.writeChunkSize);
        if (characteristic.properties?.write && characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(chunk);
        else if (characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(chunk);
        else await characteristic.writeValue(chunk);
      }
    }).catch((error) => this.#fail(`Sending to the ring failed: ${error.message}`));
  }

  #updateLiveTimer() {
    clearInterval(this.liveTimer);
    this.liveTimer = null;
    if (this.liveEnabled && this.state === 'ready') {
      this.liveTimer = setInterval(() => this.#process(this.client.pollLive()), LIVE_POLL_INTERVAL);
    }
  }

  #reset(state) {
    clearTimeout(this.timeoutTimer);
    clearInterval(this.liveTimer);
    this.liveTimer = null;
    this.state = state;
    this.writeCharacteristic = null;
    this.client = new RingClient();
    this.ringInfo = null;
    this.live = null;
    this.download = null;
    this.writeChain = Promise.resolve();
    this.#changed();
  }

  #log(direction, bytes) {
    this.packetLog.unshift(`${direction} ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`);
    this.packetLog.length = Math.min(this.packetLog.length, 300);
  }

  #fail(message) {
    this.lastError = message;
    this.#changed();
  }

  #changed() { this.dispatchEvent(new Event('change')); }
}
