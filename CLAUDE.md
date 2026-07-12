# Tune Studio — project guide

Tune Studio is a single-file web app: everything ships as one `index.html`.
The owner is not a developer — explain decisions in plain English, choose the
simplest reliable option at decision points, and say what you chose.

## Standing rules (apply to every task)

1. **Never touch the Apps Script connection unless explicitly told to.**
   That means `SHEETS_ENDPOINT`, `apiRequest`, and anything else involved in
   talking to the Google Apps Script backend / Google Sheet.
2. **Always repack to a single working `index.html`** at the end of the task.
   The app must work exactly as one file, like before.
3. **Always verify the existing tabs still work** (all 7 of them) before
   finishing — plus every existing Edit Video feature if you worked there.
4. **Always end with a plain-English test checklist** the owner can follow.

## The bundle: how index.html is packed

`index.html` is a self-unpacking bundle, not the app source:

- A loader script decodes a **manifest** (`<script type="__bundler/manifest">`,
  gzipped base64 assets: React, ReactDOM, the design system, the DC runtime)
  and a **template** (`<script type="__bundler/template">`) — the real app
  HTML as one JSON string.
- **The quirk:** the template's JSON sits on the *same line* as its opening
  script tag, with a trailing `</script>` on that same line. When unpacking,
  strip everything from the last `</script>` on that line; when repacking,
  put the JSON back between the tag and a trailing `</script>` on one line.
- When re-serializing, escape `</script` inside the JSON as `<\/script`
  (JSON's `\/` escape) so the string can't terminate the script element.

### Unpack (node)

```js
const fs = require('fs');
const lines = fs.readFileSync('index.html', 'utf8').split('\n');
const open = '<script type="__bundler/template">';
for (const line of lines) {
  const at = line.indexOf(open);
  if (at === -1) continue;
  let json = line.slice(at + open.length);
  json = json.slice(0, json.lastIndexOf('</scr' + 'ipt>')); // the same-line quirk
  fs.writeFileSync('app.html', JSON.parse(json)); // ← edit app.html, not index.html
  break;
}
```

### Repack (node)

```js
const fs = require('fs');
const lines = fs.readFileSync('index.html', 'utf8').split('\n');
const open = '<script type="__bundler/template">';
const app = fs.readFileSync('app.html', 'utf8');
for (let i = 0; i < lines.length; i++) {
  const at = lines[i].indexOf(open);
  if (at === -1) continue;
  const close = lines[i].lastIndexOf('</scr' + 'ipt>');
  const json = JSON.stringify(app).replace(/<\/script/gi, '<\\/script');
  lines[i] = lines[i].slice(0, at) + open + json + '</scr' + 'ipt>' + lines[i].slice(close + 9);
  break;
}
fs.writeFileSync('index.html', lines.join('\n'));
```

Always verify the roundtrip (unpack the repacked file and compare) before
finishing. Only the manifest and template lines are huge; the manifest never
needs touching for app changes.

## The app source (app.html once unpacked)

- Plain HTML template using a declarative-component runtime: `sc-if`,
  `sc-for`, `{{ value }}` bindings, `x-import` design-system components
  (`AdsitDesignSystem_ab046a.Button`, `.Card`, …).
- All logic lives in one `<script type="text/x-dc">` class (`Component
  extends DCLogic`) near the bottom: `state`, handlers as arrow-function
  class fields, and `renderVals()` mapping state → template bindings.
- Inputs are uncontrolled; `componentDidUpdate*` re-fills DOM values from
  state (never while focused). High-frequency UI (sync clock, export
  progress) writes straight into the DOM via `data-*` hooks to avoid
  re-render flicker — copy that pattern for anything that ticks.

## Tabs and current features

1. **My search** ("Find a song") — AI song lookup via the backend; song
   details, structure, links; "use as template" feeds the Songwriter.
2. **Playlist** ("YouTube playlist" screen) — embedded YouTube playlist.
3. **Songwriter** — AI lyric drafting/refining, voice input, save to Sheet.
4. **Suno** ("Make music") — copy-for-Suno flow; tab can be hidden by prop.
5. **My songs** — songs saved in the Google Sheet: list, edit, delete,
   per-section AI rewrite, copy for Suno.
6. **Settings** — AI provider picker, access token, provider status.
7. **Edit Video** — lyric-video maker:
   - Load a song from My songs (lyrics + linked audio when the sheet row has
     a playable URL) or upload an MP3/WAV and paste lyrics. Audio never
     leaves the browser.
   - Lyric lines are editable; `[Section]` headers never become captions.
   - Tap-along timing sync (full-screen view), per-line −/+ 0.1 s nudges,
     preview-from-line, re-sync from a line, save/load timing file.
   - Caption styling: Classic / Bold / Karaoke / Fade, size, font, position,
     text/background colors, contrast warning; live 16:9 canvas preview
     painted every frame from the audio clock (`evRenderFrame` is the single
     renderer shared by preview, thumbnails, and the video export).
   - **Video export**: records a 1920×1080 canvas (same renderer) + the song
     into a WebM (VP9→VP8→plain fallback) via `canvas.captureStream(30)` +
     Web Audio + `MediaRecorder`. No screen capture, no page UI in the file.
     Full-screen progress view with Cancel locks the app while recording
     (recording is real time: a 3-minute song takes ~3 minutes). Auto-downloads
     as `<Title> - Lyric Video.webm` (illegal characters sanitized), then
     shows size / duration / resolution, keeps a "Download again" button until
     a different song is loaded, and warns when the file is over 35 MB (too
     big for the planned Drive auto-save).
   - Export design notes (don't undo these — each fixes a real failure):
     - Frames are painted from the **audio clock**, never wall time, so
       captions can't drift on long recordings.
     - A **clock bridge** (`performance.now()` vs `AudioContext.currentTime`,
       anchored at `rec.start()`) corrects for audio-device-clock vs
       wall-clock skew — the file's audio track is written on the sample
       clock while canvas frames are stamped with the wall clock. On real
       hardware the correction is ~0; without it, captions land late by the
       skew (measured up to ~0.5 s/3 min on virtual audio devices).
     - Painting runs on a 33 ms **timer, not rAF**, so recording survives the
       tab being hidden (audible tabs keep their timers).
     - The song is fetched into a **local blob** before recording so network
       hiccups can't stall it; a linked (My songs) audio URL that blocks
       CORS gets a plain-English "upload the MP3 instead" error.
     - `evPatchWebmDuration` writes the duration into the WebM header
       (MediaRecorder leaves it out; players would show "unknown length").
       It's a minimal EBML walk — on anything unexpected it returns the
       original blob, which still plays.
     - The finished `Blob` stays on the instance as `this.evExportBlob`,
       details in `state.evExport` — **kept for the future Save-to-Drive
       step** so it can upload without re-exporting.

## Not built yet

- **Save to Drive**: a button that sends the finished export (already held
  in `this.evExportBlob` + `state.evExport`) to Google Drive via the
  backend. Nothing on the Apps Script side exists for it yet either.

## Testing notes

- Headless Chromium + Playwright can drive the whole app, including a real
  3-minute export (upload WAV → paste lyrics → "Load timing file" with
  `{"app":"Tune Studio","kind":"lyric timings","version":1,"lines":[{"text":…,"time":…}]}`
  → Export Video → catch the download). Launch with
  `--autoplay-policy=no-user-gesture-required`.
- Headless containers have a *slow, jittery virtual audio clock* — that's
  what the clock bridge compensates. Verify sync by putting beeps in the
  test WAV at the caption times and comparing beep positions vs frame-change
  positions in the recorded file (ffmpeg).
- Export was verified in Chromium (Chrome). Firefox/Edge pass the feature
  detection on paper (WebM + captureStream + MediaRecorder) but were not
  test-run — say so honestly in checklists rather than claiming otherwise.
