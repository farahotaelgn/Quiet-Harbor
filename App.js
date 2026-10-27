import { SessionStore } from './Store.js';
import { RingConnection } from './RingConnection.js';
import { demoSession, duration, isRawOnly } from './Core/Session.js';
import { report } from './Core/Report.js';
import { FORMATS, canExport, csv, exportFile, fileName, importFile } from './Core/Formats.js';
import { zip } from './Core/Zip.js';
import { BRAND } from './Brand.js';

export const VERSION = '1.6.4';
const BLUEFY_URL = 'https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055';
const DISCLAIMER = `${BRAND.name} is a wellness tool, not a medical device. Discuss your results with a clinician.`;

const store = new SessionStore();
const ring = new RingConnection();
const AUTO_LOCK_AFTER = 5 * 60_000;
const EXPORT_CHOICES = [
  { id: 'dat', label: '.dat (OSCAR)' },
  { id: 'spo2', label: '.spo2' },
  { id: 'bin', label: '.bin' },
  { id: 'csv', label: 'CSV' },
];

function savedFormats() {
  try {
    const saved = JSON.parse(localStorage.getItem('exportFormats'));
    if (Array.isArray(saved) && saved.length) return new Set(saved);
  } catch { /* storage blocked: use the default */ }
  return new Set(['dat']);
}

const ui = { tab: 'device', sessionId: null, formats: savedFormats(), unlocking: false, lockError: null, ready: false };
const view = document.getElementById('view');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const one = (v) => (v == null ? '--' : v.toFixed(1));
const dateTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function hms(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.round(seconds % 60);
  return [h && `${h} hr`, m && `${m} min`, (!h && s) && `${s} sec`].filter(Boolean).join(' ') || '0 sec';
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}
async function saveFiles(files, zipName) {
  const objects = files.map((f) => new File([f.data], f.name, { type: f.type ?? 'application/octet-stream' }));
  if (navigator.canShare?.({ files: objects })) {
    try {
      await navigator.share({ files: objects });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const file = objects.length === 1 ? objects[0]
    : new File([zip(files)], zipName, { type: 'application/zip' });
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function chart(session, key, min, max, guide, color) {
  const W = 600, H = 170, L = 30, B = 20;
  const n = session.samples.length;
  const x = (i) => L + ((W - L - 4) * i) / Math.max(1, n - 1);
  const y = (v) => H - B - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * (H - B - 6);
  const segments = [];
  let current = [];
  session.samples.forEach((s, i) => {
    const v = s[key];
    if (v == null) { if (current.length) segments.push(current); current = []; return; }
    current.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (current.length) segments.push(current);
  const ticks = [min, (min + max) / 2, max];
  const times = [0, 0.5, 1].map((f) => {
    const t = new Date(session.startDate + f * duration(session) * 1000);
    return { x: L + (W - L - 4) * f, label: t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) };
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${key} chart">
    ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="label" x="0" y="${y(t) + 4}">${t}</text>`).join('')}
    ${guide != null ? `<line class="guide" x1="${L}" x2="${W}" y1="${y(guide)}" y2="${y(guide)}"/>` : ''}
    ${segments.map((p) => (p.length > 1 ? `<polyline class="line" stroke="${color}" points="${p.join(' ')}"/>` : '')).join('')}
    ${times.map((t, i) => `<text class="label" x="${t.x}" y="${H - 4}" text-anchor="${['start', 'middle', 'end'][i]}">${t.label}</text>`).join('')}
  </svg>`;
}

function deviceView() {
  if (!RingConnection.isSupported) {
    return `<section class="card warn">
      <h2>Open in Bluefy</h2>
      <p>This browser has no Bluetooth. On iPhone, install the free <b>Bluefy</b> browser and open this page in it to connect your ring.</p>
      <a class="button" href="${BLUEFY_URL}">Get Bluefy on the App Store</a>
      <p class="note">History, charts and OSCAR export still work here.</p>
    </section>`;
  }
  const status = { disconnected: 'Not connected', connecting: 'Connecting…', ready: `Connected to ${esc(ring.name)}` }[ring.state];
  let html = `<section class="card">
    <h2>Ring</h2>
    <div class="row"><span>Status</span><span>${status}</span></div>
    ${ring.lastError ? `<p class="error">${esc(ring.lastError)}</p>` : ''}
    ${ring.state === 'disconnected' ? noticeHtml() : ''}
    <div class="buttons">${ring.state === 'disconnected'
      ? `<button data-action="connect">Connect ring</button><button class="secondary" data-action="connect-all">Show all devices</button>`
      : `<button class="danger" data-action="disconnect">Disconnect</button>`}</div>
    ${ring.state === 'disconnected' ? '<p class="note">Wear the ring so it wakes up, then tap Connect and choose it in the list.</p>' : ''}
    ${ring.isDownloading && ring.state === 'disconnected' ? `<p class="note">${ring.wanted.size} night${ring.wanted.size === 1 ? '' : 's'} still to download. They carry on as soon as the ring is connected.</p>` : ''}
  </section>`;
  if (ring.state === 'ready') {
    const files = ring.ringInfo?.fileNames ?? [];
    const empty = files.filter((f) => ring.emptyFiles.has(f) && !store.hasRingFile(f));
    const fresh = files.filter((f) => !store.hasRingFile(f) && !ring.emptyFiles.has(f));
    html += `<section class="card">
      <h2>Sessions on the ring</h2>
      ${ring.live ? `<div class="row"><span>Battery</span><span>${ring.live.battery} %${ring.live.charging === 'charging' ? ', charging' : ''}</span></div>` : ''}
      <div class="row"><span>On ring</span><span>${ring.ringInfo ? files.length : '…'}</span></div>
      <div class="row"><span>Already read</span><span>${ring.ringInfo ? files.length - fresh.length - empty.length : '…'}</span></div>
      <div class="row"><span>New</span><span>${ring.ringInfo ? fresh.length : '…'}</span></div>
      ${empty.length ? `<div class="row"><span>Empty on the ring</span><span>${empty.length}</span></div>
      <p class="note">The ring has no data in ${empty.length === 1 ? 'this night' : 'these nights'} yet. This is usually the night it is recording now. Take the ring off, wait a minute, then tap Refresh.</p>` : ''}
      ${ring.download
        ? `<progress max="${ring.download.total}" value="${ring.download.received}"></progress>
           <p class="note">Downloading ${esc(ring.download.file)}${ring.download.remaining ? ` · ${ring.download.remaining} more` : ''}</p>
           ${ring.wakeLockState === 'unsupported' ? '<p class="error">Keep the screen on until it finishes. This browser cannot keep it awake.</p>' : ''}`
        : `<div class="buttons">
             <button data-action="download" ${fresh.length ? '' : 'disabled'}>Download ${fresh.length} new session${fresh.length === 1 ? '' : 's'}</button>
             <button class="secondary" data-action="refresh">Refresh</button>
           </div>
           ${store.readFiles.size ? '<button class="secondary" data-action="forget-read">Allow deleted sessions to download again</button>' : ''}
           ${ring.downloadedCount ? `<p class="note">${ring.downloadedCount} downloaded to History.</p>` : ''}`}
      <p class="note">Switching apps pauses the download. It continues when you come back.</p>
    </section>`;
  }
  return html;
}

// 1.6.4: says why no ring showed up, instead of closing the list silently
function noticeHtml() {
  if (ring.notice === 'off' || ring.available === false) {
    return `<div class="error"><p><b>Bluetooth can't be used.</b> Bluetooth is off, or iOS doesn't let Bluefy use it.</p>
      <p>On the iPhone: Settings › Bluefy › turn on Bluetooth. Then Control Center › Bluetooth on (blue). Come back and tap Connect ring.</p></div>`;
  }
  if (ring.notice === 'empty') {
    return `<div class="note"><p><b>No ring was chosen.</b> If the list was empty:</p>
      <p>1. Close Oxi Converter and ViHealth completely (swipe them away). A ring linked to another app doesn't show up.</p>
      <p>2. Wear the ring for 30 seconds so its screen wakes.</p>
      <p>3. Tap Show all devices.</p>
      <p>4. Still nothing: close Bluefy completely, open it again, then try again.</p></div>`;
  }
  return '';
}

function liveView() {
  const r = ring.live;
  const status = ring.state !== 'ready' ? 'Connect your ring on the Device tab.'
    : ring.download ? 'Live values pause while sessions download.'
    : !r ? 'Waiting for the ring…'
    : r.fingerDetected ? 'Updated every 2 seconds.' : 'No finger detected. Put the ring on.';
  return `<section class="card">
    <div class="readings">
      <div class="reading"><b>${r?.spo2 ?? '--'}</b><span>SpO₂ %</span></div>
      <div class="reading"><b>${r?.pulse ?? '--'}</b><span>Pulse bpm</span></div>
    </div>
    <p class="note">${status}</p>
  </section>
  ${r ? `<section class="card"><h2>Ring</h2>
    <div class="row"><span>Battery</span><span>${r.battery} %</span></div>
    <div class="row"><span>Signal strength</span><span>${r.signalStrength}</span></div>
    <div class="row"><span>Motion</span><span>${r.motion}</span></div></section>` : ''}
  <section class="card"><details><summary>Bluetooth packets (${ring.packetLog.length})</summary>
    <pre class="log">${esc(ring.packetLog.join('\n'))}</pre></details></section>`;
}

function historyView() {
  const items = store.sessions.map((s) => `<button class="item" data-action="open" data-id="${esc(s.id)}">
      <span class="grow">${dateTime(s.startDate)}
        <small>${isRawOnly(s) ? 'Raw file only' : hms(duration(s))}${s.deviceName ? ` · ${esc(s.deviceName)}` : ''}</small></span>
      ${s.rawFormat ? `<span class="badge">.${s.rawFormat}</span>` : ''}<span class="chevron">›</span>
    </button>`).join('');
  return `<section class="card">
    <h2>History</h2>
    <div class="buttons">
      <button data-action="import">Import file</button>
      <button class="secondary" data-action="demo">Add demo session</button>
    </div>
    ${store.db ? '' : '<p class="error">This browser blocks storage, so sessions are lost when the page closes.</p>'}
  </section>
  <section class="card">
    <h2>Export all sessions</h2>
    ${formatPicker()}
    <button class="secondary" data-action="export-all" ${store.sessions.length ? '' : 'disabled'}>Download ${store.sessions.length} session${store.sessions.length === 1 ? '' : 's'} in the chosen formats</button>
    <p class="note">Each session is its own file in each format.</p>
  </section>
  <section class="card list">${items || '<p class="note" style="padding:12px 16px">No sessions yet. Download them from the ring, import a .dat, .bin or .spo2 file, or add a demo session.</p>'}</section>`;
}

function sessionView(s) {
  const r = report(s);
  const rows = [
    ['Average SpO₂', r.averageSpO2 == null ? '--' : `${one(r.averageSpO2)} %`],
    ['Lowest SpO₂', r.lowestSpO2 == null ? '--' : `${r.lowestSpO2} %`],
    ['Time below 90 %', `${hms(r.timeBelow90)} (${one(r.percentBelow90)} %)`],
    ['Drops of 3 % or more', r.desaturationEvents],
    ['ODI (drops per hour)', one(r.odi)],
    ['Average pulse', r.averagePulse == null ? '--' : `${Math.round(r.averagePulse)} bpm`],
    ['Pulse range', r.lowestPulse == null ? '--' : `${r.lowestPulse}–${r.highestPulse} bpm`],
    ['Valid recording', hms(r.validDuration)],
  ];
  return `<button class="secondary" data-action="back">‹ History</button>
  ${isRawOnly(s)
    ? `<section class="card"><p class="note">This app can't chart this .${s.rawFormat} file's layout yet. The original file is kept byte for byte and can be exported again.</p></section>`
    : `<section class="card"><h2>SpO₂</h2>${chart(s, 'spo2', 70, 100, 90, 'var(--teal)')}</section>
       <section class="card"><h2>Pulse</h2>${chart(s, 'pulse', 40, 140, null, 'var(--pink)')}</section>
       <section class="card"><h2>Summary</h2>${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('')}</section>`}
  <section class="card">
    <h2>Recording</h2>
    <div class="row"><span>Start</span><span>${dateTime(s.startDate)}</span></div>
    <div class="row"><span>Sample interval</span><span>${s.sampleInterval} s</span></div>
    ${s.deviceName ? `<div class="row"><span>Device</span><span>${esc(s.deviceName)}</span></div>` : ''}
    ${s.rawData ? `<div class="row"><span>Original file</span><span>.${s.rawFormat}, ${s.rawData.length.toLocaleString()} bytes</span></div>` : ''}
  </section>
  <section class="card">
    <h2>Export</h2>
    ${formatPicker()}
    <button data-action="export-session">Download the chosen files</button>
    <button class="danger" data-action="delete">Delete session</button>
    <p class="note">${DISCLAIMER}</p>
  </section>`;
}

function lockView() {
  if (!store.hasPassword) {
    return `<form class="card lock" data-form="create">
      <h2>Create a password</h2>
      <p class="note">It protects this page and encrypts your saved sessions on this phone.</p>
      <input type="password" name="password" autocomplete="new-password" placeholder="Password (at least 6 characters)" minlength="6" required>
      <input type="password" name="confirm" autocomplete="new-password" placeholder="Repeat password" required>
      ${ui.lockError ? `<p class="error">${esc(ui.lockError)}</p>` : ''}
      <button type="submit" ${ui.unlocking ? 'disabled' : ''}>${ui.unlocking ? 'Setting up…' : 'Save password'}</button>
      <p class="note">There is no way to recover a forgotten password. The only option is to erase the saved sessions and start again.</p>
    </form>`;
  }
  return `<form class="card lock" data-form="unlock">
    <h2>Locked</h2>
    <input type="password" name="password" autocomplete="current-password" placeholder="Password" required autofocus>
    ${ui.lockError ? `<p class="error">${esc(ui.lockError)}</p>` : ''}
    <button type="submit" ${ui.unlocking ? 'disabled' : ''}>${ui.unlocking ? 'Unlocking…' : 'Unlock'}</button>
    <button type="button" class="danger" data-action="erase-all">Forgot password? Erase everything</button>
  </form>`;
}

function lock() {
  ring.disconnect();
  ui.sessionId = null;
  store.lock();
}

function render() {
  document.body.classList.toggle('locked', store.isLocked);
  if (!ui.ready) return;
  if (store.isLocked) {
    view.innerHTML = lockView();
    view.querySelector('input')?.focus();
    return;
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  const open = ui.tab === 'history' && ui.sessionId ? store.find(ui.sessionId) : null;
  view.innerHTML = ui.tab === 'device' ? deviceView()
    : ui.tab === 'live' ? liveView()
    : open ? sessionView(open) : historyView();
}
function exportBundle(sessions, formats) {
  const files = [];
  const used = new Set();
  let skipped = 0;
  for (const s of sessions) {
    for (const format of formats) {
      const name = format === 'csv'
        ? fileName(s, 'spo2', BRAND.filePrefix).replace(/\.spo2$/, '.csv')
        : fileName(s, format, BRAND.filePrefix);
      if (used.has(name) || (format === 'csv' ? isRawOnly(s) : !canExport(s, format))) { skipped++; continue; }
      used.add(name);
      files.push(format === 'csv'
        ? { name, data: new TextEncoder().encode(csv(s)), type: 'text/csv' }
        : { name, data: exportFile(s, format) });
    }
  }
  return { files, skipped };
}

async function exportSessions(sessions) {
  const formats = EXPORT_CHOICES.map((c) => c.id).filter((id) => ui.formats.has(id));
  if (!formats.length) return toast('Choose at least one format.');
  const { files, skipped } = exportBundle(sessions, formats);
  if (!files.length) return toast('None of these can be saved in the chosen formats.');
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await saveFiles(files, `${BRAND.filePrefix}-${stamp}.zip`);
    toast(`${files.length} file${files.length === 1 ? '' : 's'} ready${skipped ? ` (${skipped} skipped)` : ''}.`
      + (formats.includes('dat') ? ' For OSCAR: Data › Import Viatom/Wellue Data.' : ''));
  } catch (error) {
    toast(error.message);
  }
}

function formatPicker() {
  return `<div class="formats">${EXPORT_CHOICES.map((c) => `<label class="check">
      <input type="checkbox" data-format-choice="${c.id}" ${ui.formats.has(c.id) ? 'checked' : ''}> ${c.label}</label>`).join('')}</div>`;
}

const actions = {
  connect: () => ring.connect(false),
  'connect-all': () => ring.connect(true),
  disconnect: () => ring.disconnect(),
  refresh: () => ring.refresh(),
  download: () => ring.downloadFiles((ring.ringInfo?.fileNames ?? []).filter((f) => !store.hasRingFile(f) && !ring.emptyFiles.has(f))),
  'forget-read': async () => {
    if (!confirm('Allow sessions you deleted from History to be downloaded from the ring again?')) return;
    await store.forgetReadFiles();
  },
  lock: () => lock(),
  'erase-all': async () => {
    if (!confirm('Erase every saved session and the password? This cannot be undone.')) return;
    await store.eraseEverything();
    ui.lockError = null;
    render();
  },
  import: () => document.getElementById('importInput').click(),
  demo: () => store.add(demoSession(Date.now() - 3_600_000)),
  'export-all': () => exportSessions(store.sessions),
  open: (el) => { ui.sessionId = el.dataset.id; render(); window.scrollTo(0, 0); },
  back: () => { ui.sessionId = null; render(); },
  'export-session': () => exportSessions([store.find(ui.sessionId)]),
  delete: async () => {
    if (!confirm('Delete this session from this phone?')) return;
    await store.remove(ui.sessionId);
    ui.sessionId = null;
    render();
  },
};

view.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el && !el.disabled) actions[el.dataset.action]?.(el);
});

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]')?.dataset.tab;
  if (!tab) return;
  if (tab === ui.tab && tab === 'history') ui.sessionId = null;
  ui.tab = tab;
  ring.setLiveEnabled(tab === 'live');
  render();
});

document.getElementById('importInput').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  for (const file of files) {
    try {
      const result = importFile(new Uint8Array(await file.arrayBuffer()), file.name, file.lastModified);
      const added = await store.add(result.session);
      toast(!added ? `${file.name} is already in History.` : result.warning ? `Imported ${file.name}. ${result.warning}` : `Imported ${file.name}.`);
    } catch (error) {
      toast(`Could not import ${file.name}. ${error.message}`);
    }
  }
});

ring.addEventListener('file', async ({ detail }) => {
  if (store.isLocked || store.hasRingFile(detail.name)) return;
  try {
    const { session } = importFile(detail.data, `${detail.name}.dat`);
    session.deviceName = detail.ringName;
    if (store.hasSameNight(session)) { await store.markRead(detail.name); return; } // 1.6.3: already in History
    await store.add(session);
    await store.markRead(detail.name);
  } catch (error) {
    toast(`Could not read ${detail.name} from the ring. ${error.message}`);
  }
});
ring.addEventListener('change', () => { if (!store.isLocked && !(ui.tab === 'history' && ui.sessionId)) render(); });
store.addEventListener('change', render);

document.title = BRAND.name;
document.getElementById('brandName').textContent = BRAND.name;
document.getElementById('version').textContent = `v${VERSION}`;
view.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const password = form.password.value;
  ui.lockError = null;
  if (form.dataset.form === 'create') {
    if (password.length < 6) ui.lockError = 'Use at least 6 characters.';
    else if (password !== form.confirm.value) ui.lockError = 'The two passwords do not match.';
    if (ui.lockError) return render();
  }
  ui.unlocking = true;
  render();
  try {
    if (form.dataset.form === 'create') await store.createPassword(password);
    else if (!(await store.unlock(password))) ui.lockError = 'Wrong password.';
  } catch (error) {
    ui.lockError = error.message;
  }
  ui.unlocking = false;
  render();
});

view.addEventListener('change', (event) => {
  const id = event.target.dataset?.formatChoice;
  if (!id) return;
  if (event.target.checked) ui.formats.add(id);
  else ui.formats.delete(id);
  try { localStorage.setItem('exportFormats', JSON.stringify([...ui.formats])); } catch { /* not essential */ }
});
let hiddenAt = null;
let lockWhenDownloaded = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_AFTER && !store.isLocked) {
    if (ring.isDownloading) lockWhenDownloaded = true; // locking now would drop the nights still coming in
    else lock();
  }
});
ring.addEventListener('change', () => {
  if (lockWhenDownloaded && !ring.isDownloading && !store.isLocked) {
    lockWhenDownloaded = false;
    setTimeout(lock, 1500); // let the last night finish saving first
  }
});
document.getElementById('lockButton').addEventListener('click', () => lock());

ring.watchAvailability();
render();
await store.open();
ui.ready = true;
render();
