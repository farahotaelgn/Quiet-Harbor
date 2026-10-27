# Changelog

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
