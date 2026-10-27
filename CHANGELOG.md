# Changelog

## 1.6.6 — 2026-10-27 · .spo2 that OSCAR opens
- 🛠 Fixed: **.spo2** files opened empty in OSCAR. Quiet Harbor's .spo2 was its own backup format (it starts with "FHS2"), which OSCAR can't read. **.spo2 (OSCAR)** now saves the layout OSCAR reads (Data › Oximetry Wizard › import a file), the same as the Oxi Converter's .spo2.
- ✨ New: **Harbor backup (.spo2, opens only in Quiet Harbor)** keeps the old format as its own choice, saved as "…-backup.spo2". Every backup you saved before still opens.
- ✨ New: importing an OSCAR .spo2 (from Quiet Harbor or the Oxi Converter) now works too.
- 🛠 Fixed: a ring file Quiet Harbor can't chart now keeps the night's start time as its name instead of the download time.
- Kept: .dat (OSCAR), .bin and CSV unchanged. .dat goes into OSCAR with Data › Import Viatom/Wellue Data.

**🔧 Behind the scenes:** the owner sent 3 files (Harbor-2026-10-26-0202, -10-27-0131, -10-26-1421). All were FHS2 backups holding normal WearO2 ring data (sig 0x0003, 4 s, 3961 / 16 / 5 readings). OSCAR's `CMS50Loader::readSpoRFile` reads bytes 0–1 as the header position ("FH" = 18502, past the end of the file), so it found no readings. New `OscarSpo2File` in `Core/Formats.js` writes u16 856 · byte 856 = 1 · "BLE" at 864 · local start at 1056 (6 × u32) · seconds at 1080 · SpO₂/pulse pairs from 1084, with each 4 s reading spread over 4 seconds and 0x7F/0xFF for no reading. That is byte-identical to the Oxi Converter's `buildBytes` on the owner's night. `decode` reads it back the way OSCAR does (2- or 4-byte records), turning 4 equal seconds back into a 4 s reading. `importFile` picks backup by the FHS2 magic, otherwise OSCAR .spo2; the backup format keeps an imported OSCAR file's bytes as raw code 3. The ring `file` handler passes `ringNameTime(name)` as the start time for a layout it can't chart. Proof: 35 checks on the owner's 3 files under New York time (a line-by-line copy of readSpoRFile: 15,844 / 64 / 20 seconds, start = the night's start, every second = the ring reading, avg SpO₂ 97.1; round trip; byte-for-byte re-export; backups open; 1 s data; errors refused; .bin and demo unchanged). On the real page in Chromium: the 3 files import, the new choices show, the export zip holds 9 files, and the browser's own .spo2 and .dat pass the OSCAR checks with no JS errors. The 1.6.4 and 1.6.5 page checks were run again: 22 ✅. Only OSCAR on the Mac can confirm the final import.

## 1.6.5 — 2026-10-27 · Ring that stays hidden
- 🛠 Fixed: when the page closed or reloaded while the ring was connected, Bluefy could keep a hidden link to it, and a ring with a link stops showing up in any search. The page now lets go of the ring when it closes. Switching apps still pauses and carries on as before.
- ✨ New: **Reconnect my ring** (only in browsers that can do it) connects to a ring you picked before without searching for it. If none is remembered it says so.
- 🛠 Clearer steps when the device list is empty: turn Bluetooth off for ViHealth and Oxi Converter in iPhone Settings (closing them is not enough), reopen Bluefy, wake the ring, then Show all devices.
- Kept: Connect ring, Show all devices, the saved ring name and the 1.6.4 notes.

**🔧 Behind the scenes:** owner (Bluefy, Bluetooth on, other devices listed, ring missing) → the ring isn't advertising: asleep or held by a connection on the phone. `pagehide` now calls `device.gatt.disconnect()` (not `disconnect()`, so the nights still wanted survive a back-forward return). `reconnect()` uses `navigator.bluetooth.getDevices()` when it exists (guarded by `RingConnection.canReconnect`), picks a saved/known ring name or the only device, and opens GATT without the chooser; `notice: 'none'` when nothing is remembered. One `gattserverdisconnected` listener per device (`#useDevice`). Proof: 10 checks on the real page in Chromium with a pretend ring (button only when supported, reconnect connects, page close releases the ring, nothing remembered note, empty-list steps, normal Connect, one listener after Disconnect → Reconnect, no JS errors) + the 1.6.4 checks again (12). Only the iPhone can show whether Bluefy has getDevices and whether the ring was held by another link.

## 1.6.4 — 2026-10-27 · Says why no ring shows up
- 🛠 Fixed: when Bluetooth was off, or iOS didn't let Bluefy use it, tapping Connect ring did nothing at all. The Device screen now says **Bluetooth can't be used** and how to turn it on (Settings › Bluefy › Bluetooth, then Control Center).
- 🛠 Fixed: an empty or closed device list now shows short steps (close Oxi Converter and ViHealth, wear the ring, Show all devices, reopen Bluefy) instead of nothing.
- ✨ New: when the page opens it asks the browser whether Bluetooth can be used, and shows the note before you tap.
- Kept: Connect ring, Show all devices and the saved ring name work as before.

**🔧 Behind the scenes:** `requestDevice` answers `NotFoundError` both when the list is cancelled and when there is no Bluetooth adapter ("Bluetooth adapter not available", proven in real Chromium); 1.6.0–1.6.3 treated every `NotFoundError` as a cancel and showed nothing. `RingConnection.noticeFor(error)` now sorts it into `off` (adapter / not available / permission / denied / not allowed) or `empty` (cancel / other not-found); any other error still shows its own text. `watchAvailability()` uses `navigator.bluetooth.getAvailability()` + `availabilitychanged` when the browser has them (guarded; the note then comes from Connect). The filters were checked in real Chromium: valid, no TypeError. Proof: 8 checks on the real page in Chromium (no adapter, Show all devices, cancelled list, unavailable at open, permission denied, other error) + a pretend ring: note after an empty list, connects on the next try, note cleared, no JS errors. Only the iPhone can confirm Bluefy's exact error words and whether it supports getAvailability.

## 1.6.3 — 2026-10-27 · No night is read twice
- 🛠 Fixed: a night already in History is never read from the ring again, even when it came in another way (a .dat or .spo2 you imported by hand, under a different name). It counts as **Already read**, not **New**, and Download skips it.
- 🛠 Fixed: if a night still comes in and History already has one with the same start time and the same length, it is not saved a second time.
- Kept: **Allow deleted sessions to download again** still brings back only the nights you deleted from History.

**🔧 Behind the scenes:** before reading, the ring only gives each night's name, which is its start time (yyyyMMddHHmmss, local). `Store.hasRingFile` now also asks `hasNightAt(ringNameTime(name))` (a History night starting in the same second), so the New / Already read / Download lists and the file handler all skip it. After reading, `App.js` checks `store.hasSameNight(session)` (same start second + same length) and only marks the name read. Proof: 9 direct checks (imported night skipped, 1 s later still read, same start + other length still saved, deleted night back only after Allow re-download), the ring stand-in 19/19 fifteen runs in a row (two timing races in the test itself fixed: the pause and the dropped link now happen the moment the first night lands), and the real page in Chromium with a .spo2 imported first: Already read 1 before connecting, 2 downloaded instead of 3, no errors. Only the iPhone can confirm it with the real WearO2 in Bluefy.

## 1.6.2 — 2026-10-27 · Empty nights shown, ring found by name
- 🛠 Fixed: a night the ring reports as empty (0 bytes, usually the night it is recording now) was skipped without a word and kept counting as "New". The Device screen now shows **Empty on the ring** with a short note, and New / Download / Already read count only nights with data.
- ✨ New: **Refresh** checks the empty nights again and downloads them once they have data.
- ✨ New: the first time you pick your ring from **Show all devices**, Quiet Harbor saves its Bluetooth name; **Connect ring** then looks for that name too.

**🔧 Behind the scenes:** the owner's ring answered one night's file-open with size 0; Core/Ring.js closed the file and sent no output, so the night stayed wanted and "New". Ring.js now emits `{type:'empty'}`; RingConnection keeps `emptyFiles` (not retried, cleared on Disconnect, re-checked by Refresh). `RingConnection.filters()` adds saved names (exact `name` + first-word `namePrefix`) from localStorage `ringNames`, saved only after a Show-all-devices connect that offered the ring service. Stand-in ring 19/19 three runs in a row (incl. an empty night and the saved name in the next search); the real page in Chromium: 3 downloaded, Empty on the ring 1, New 0, Already read 3, no errors. Only the iPhone can confirm Bluefy's search with the saved name and that the real night is empty.

## 1.6.1 — 2026-10-27 · Download survives switching apps
- ✨ New: the screen stays awake while nights download (screen wake lock). If the browser can't do that, the Device screen says "Keep the screen on until it finishes."
- ✨ New: switching apps pauses the download, and it picks up by itself when you come back. Only the missing nights are fetched again; a night that was cut off starts over.
- ✨ New: if the ring's link dropped while you were away, the same ring is reconnected without the chooser. If that fails, tapping Connect ring carries on with the same nights.
- 🛠 Fixed: the 5-minute auto-lock no longer locks (and drops the nights still coming in) in the middle of a download; it locks right after it finishes.
- 🛠 Fixed: a night that stopped answering once is tried again once before it is given up.
- 🛠 Fixed: after a reconnect the ring's replies were read twice; there is now one reply listener.
- Device screen note: "Switching apps pauses the download. It continues when you come back."

**🔧 Behind the scenes:** iOS freezes Bluefy a few seconds after the page is hidden, so Web Bluetooth stops; a website can't keep it running. `RingConnection` now keeps a `wanted` set of ring files not yet received (kept across `#reset`), re-asks the ring for its info on `visibilitychange → visible` (fresh `RingClient`), or reopens GATT on the same device when the link dropped, and re-queues the wanted nights from the info reply. Tested with a stand-in WearO2 (pause + silence, dropped link, no wake lock): 13/13, and the real page in Chromium with a pretend ring (3 nights downloaded, no errors). Only the iPhone can confirm Bluefy's wake-lock support and the reconnect after a real pause.

## 1.6.0
- First version in this repo.
