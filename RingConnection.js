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
    this.wanted = new Set(); // ring files asked for and not received yet; kept across a pause or a dropped link
    this.wakeLock = null;
    this.wakeLockState = 'off'; // off | on | unsupported
    this.resumeCount = 0;
    this.emptyFiles = new Set(); // 1.6.2: nights the ring reports as 0 bytes (usually the one it is recording now)
    this.notice = null; // 1.6.4: 'off' | 'empty' | null · 1.6.5: 'none' (no ring remembered)
    this.available = null; // 1.6.4: true | false | null (browser can't say)
    this.notifyCharacteristic = null;
    this.onNotify = (event) => {
      const v = event.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      this.#log('RX', bytes);
      this.#process(this.client.receive(bytes));
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.#resumeAfterPause();
    });
    // 1.6.5: let go of the ring when the page closes or reloads, so a hidden link in this
    // browser can't stop the ring from showing up in the next search (switching apps is visibilitychange, not this)
    window.addEventListener('pagehide', () => {
      try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch { /* already gone */ }
    });
    this.onDisconnected = () => this.#reset('disconnected');
  }

  static get isSupported() { return 'bluetooth' in navigator; }

  // 1.6.4: why no ring came back from the device list
  //   'off'   = Bluetooth is off, or iOS doesn't let this browser use it
  //   'empty' = the list was closed or found no ring (asleep, or held by another app)
  static noticeFor(error) {
    const text = `${error?.name ?? ''} ${error?.message ?? ''}`;
    if (/adapter|not available|unavailable|powered|turned off|unauthori[sz]ed|permission|denied|not allowed/i.test(text)) return 'off';
    if (error?.name === 'NotFoundError' || /cancel/i.test(text)) return 'empty';
    return 'other';
  }

  // 1.6.4: asks the browser once whether Bluetooth can be used (not every browser can say)
  async watchAvailability() {
    const bt = navigator.bluetooth;
    if (!bt?.getAvailability) return;
    const apply = (ok) => { this.available = ok; if (ok && this.notice === 'off') this.notice = null; this.#changed(); };
    try { apply(await bt.getAvailability()); } catch { return; }
    try { bt.addEventListener('availabilitychanged', (e) => apply(e.value)); } catch { /* no live updates: the next Connect tells */ }
  }

  get name() { return this.device?.name ?? 'ring'; }

  get isDownloading() { return this.wanted.size > 0; }

  // 1.6.2: names the owner picked from Show all devices, so Connect ring finds them next time
  static savedNames() {
    try { const v = JSON.parse(localStorage.getItem('ringNames')); return Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n) : []; } catch { return []; }
  }
  static rememberName(name) {
    if (!name) return;
    try { localStorage.setItem('ringNames', JSON.stringify([...new Set([name, ...RingConnection.savedNames()])].slice(0, 5))); } catch { /* storage blocked: Show all devices still works */ }
  }
  static filters() {
    const saved = RingConnection.savedNames();
    const prefixes = [...new Set([...RING.namePatterns, ...saved.map((n) => n.split(/[\s_-]/)[0]).filter((p) => p.length >= 2)])];
    return [...saved.map((name) => ({ name })), ...prefixes.map((namePrefix) => ({ namePrefix })), { services: [RING.service] }];
  }

  async connect(showAllDevices = false) {
    this.lastError = null;
    const options = showAllDevices
      ? { acceptAllDevices: true, optionalServices: [RING.service] }
      : { filters: RingConnection.filters(), optionalServices: [RING.service] };
    this.pickedFromAll = showAllDevices;
    this.notice = null;
    try {
      this.device = await navigator.bluetooth.requestDevice(options);
    } catch (error) {
      // 1.6.4: "not found" is also what Bluefy answers when Bluetooth is off or not allowed; that was silent before
      this.notice = RingConnection.noticeFor(error);
      if (this.notice === 'other') { this.notice = null; this.#fail(error.message); }
      else this.#changed();
      return;
    }
    this.#useDevice(this.device);
    await this.#openGatt();
  }

  // 1.6.5: the browser can hand back a ring picked before (no scan needed). Only some browsers can.
  static get canReconnect() { return typeof navigator.bluetooth?.getDevices === 'function'; }

  async reconnect() {
    this.lastError = null;
    this.notice = null;
    let devices = [];
    try { devices = await navigator.bluetooth.getDevices(); } catch (error) { this.notice = RingConnection.noticeFor(error) === 'off' ? 'off' : 'none'; this.#changed(); return; }
    const saved = RingConnection.savedNames();
    const named = (d) => d?.name && (saved.includes(d.name) || RING.namePatterns.some((p) => d.name.startsWith(p)));
    const device = devices.find(named) ?? (devices.length === 1 ? devices[0] : null);
    if (!device) { this.notice = 'none'; this.#changed(); return; }
    this.pickedFromAll = false;
    this.#useDevice(device);
    await this.#openGatt();
  }

  #useDevice(device) {
    if (this.listenedDevice && this.listenedDevice !== device) this.listenedDevice.removeEventListener('gattserverdisconnected', this.onDisconnected);
    if (this.listenedDevice !== device) device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.listenedDevice = device;
    this.device = device;
  }

  async #openGatt() {
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
      this.notifyCharacteristic?.removeEventListener('characteristicvaluechanged', this.onNotify);
      this.notifyCharacteristic = notify;
      notify.addEventListener('characteristicvaluechanged', this.onNotify); // one listener, even after a reconnect
      await notify.startNotifications();
      this.state = 'ready';
      this.lastError = null;
      this.notice = null;
      if (this.pickedFromAll) RingConnection.rememberName(this.device?.name);   // it offers the ring service: remember it
      this.#process(this.client.start());
      this.#updateLiveTimer();
    } catch (error) {
      this.#fail(error.message);
      this.disconnect();
    }
  }

  disconnect() {
    this.wanted.clear();
    this.emptyFiles.clear();
    this.#releaseWakeLock();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.#reset('disconnected');
  }

  downloadFiles(names) {
    if (this.state !== 'ready' || !names.length) return;
    this.downloadedCount = 0;
    for (const n of names) this.wanted.add(n);
    this.#keepScreenOn();
    this.#process(this.client.download(names));
  }

  refresh() {
    // 1.6.2: nights that were empty are checked again (the ring may have finished recording)
    if (this.emptyFiles.size && this.state === 'ready') {
      const again = [...this.emptyFiles];
      this.emptyFiles.clear();
      this.downloadFiles(again);
      return;
    }
    this.#process(this.client.requestInfo());
  }

  setLiveEnabled(enabled) {
    this.liveEnabled = enabled;
    this.#updateLiveTimer();
  }

  #process(outputs) {
    let resume = null;
    for (const o of outputs) {
      if (o.type === 'send') this.#write(o.data);
      else if (o.type === 'info') {
        this.ringInfo = o.info;
        for (const n of this.wanted) if (!o.info.fileNames.includes(n)) this.wanted.delete(n); // gone from the ring
        const left = [...this.wanted].filter((n) => n !== this.client.downloadingFile);
        if (left.length) resume = left; // picks up where it stopped
      }
      else if (o.type === 'live') this.live = o.reading;
      else if (o.type === 'progress') this.download = { file: o.file, received: o.received, total: o.total, remaining: this.client.queuedFileCount };
      else if (o.type === 'file') {
        this.downloadedCount++;
        this.wanted.delete(o.name);
        this.dispatchEvent(new CustomEvent('file', { detail: { name: o.name, data: o.data, ringName: this.name } }));
      } else if (o.type === 'failed') this.lastError = o.message;
      else if (o.type === 'empty') { this.emptyFiles.add(o.name); this.wanted.delete(o.name); }
    }
    if (resume) {
      this.#keepScreenOn();
      this.#process(this.client.download(resume));
      return;
    }
    if (!this.client.downloadingFile && !this.client.queuedFileCount) {
      this.download = null;
      if (!this.client.isBusy && this.wanted.size && this.state === 'ready' && document.visibilityState === 'visible') {
        // a night timed out while the link was up: it stays wanted and is tried again once
        const retry = [...this.wanted].filter((n) => !this.retried?.has(n));
        this.retried = new Set([...(this.retried ?? []), ...retry]);
        if (retry.length) { this.#process(this.client.download(retry)); return; }
        this.wanted.clear();
      }
      if (!this.wanted.size) { this.retried = null; this.#releaseWakeLock(); }
    }
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

  async #resumeAfterPause() {
    if (!this.wanted.size) return;
    this.#keepScreenOn();
    this.resumeCount++;
    this.retried = null;
    if (this.state === 'ready' && this.device?.gatt?.connected) {
      clearTimeout(this.timeoutTimer);
      this.lastError = null;
      this.client = new RingClient(); // drop half-read packets from before the pause
      this.#process(this.client.start()); // ask the ring again; the info reply restarts the wanted nights
    } else if (this.device && this.state === 'disconnected') {
      await this.#openGatt(); // same ring, no chooser
      if (this.state !== 'ready') this.lastError = 'The ring link was lost while you were away. Tap Connect ring to carry on; the download continues on its own.';
      this.#changed();
    }
  }

  async #keepScreenOn() {
    if (this.wakeLock) return;
    if (!navigator.wakeLock?.request) { this.wakeLockState = 'unsupported'; return; }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLockState = 'on';
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; if (this.wakeLockState === 'on') this.wakeLockState = 'off'; this.#changed(); });
    } catch {
      this.wakeLockState = 'unsupported';
    }
    this.#changed();
  }

  #releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (this.wakeLockState === 'on') this.wakeLockState = 'off';
    lock?.release().catch(() => {});
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
