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
   - **Auto-caption (AI)**: sends the loaded audio to the backend's
     `transcribe_audio` (Gemini listens to the song and returns timed lines).
     Two paths: with existing lyrics (My songs / pasted) the caption lines
     ride along as `knownLyrics` and the AI only aligns timings — the
     high-accuracy path; at the paste step with no lyrics, an "Auto-caption"
     option transcribes the words too. Audio is fetched to a local blob (same
     as export, same CORS-link error) and sent as base64 — client cap 13 MB
     raw, server cap 18 MB base64 (Gemini's inline-audio ceiling; a 3-min MP3
     is ~4 MB, big WAVs get a plain-English "use an MP3" error).
     **RULE — never bypass this: transcription results must ALWAYS pass
     through the mandatory full-screen review screen.** There the owner
     rewords lines, deletes junk lines, and plays any line from 2 s before
     its stamp; only "Accept captions" applies them, "Discard" (with confirm)
     leaves everything untouched. Accepted captions are ordinary timings —
     nudges, re-sync-from-a-line, styles, preview, export and Drive save all
     work unchanged — and the ascending-order guardrail is enforced at every
     step (server parse, client receive, accept). When the AI aligned the
     song's own lyrics one-to-one, review rows carry `srcIdx` back to their
     `evItems` line, so accepting keeps `[Section]` headers and drops
     review-deleted lines; transcribed rows replace the line list wholesale.
     The tap-sync flow is untouched and remains the fallback for a bad AI
     result. While the review screen is open, the audio `timeupdate`
     re-render is suppressed (like sync mode) so the reword box can't be
     wiped mid-typing by a re-render during spot-check playback.
   - **Background photo**: "Add a background photo" in the styling panel takes
     any picture (iPhone camera roll included — iOS hands HEIC over as JPEG);
     it's pre-cropped once into a 1920×1080 cover-fit canvas on the instance
     (`this.evBgImg`, flag `state.evBgPhoto`) and painted behind the captions
     by `evRenderFrame`, so preview, thumbnails and export always match. The
     photo never leaves the browser and is session-only (megabytes don't fit
     localStorage). Comes with a **"Darken photo" slider** (`evBgDim`, 0–90 %;
     mid-drag the value lives on the instance so no re-render can rebuild the
     slider under the finger) and a **"Slow zoom" toggle** (`evBgMotion`,
     1×→1.08× across the clip, a plain canvas transform so it records). Over
     a photo every caption style gets a dark drop shadow for readability and
     the color-contrast warning is suppressed. Dim/zoom prefs persist in the
     caption localStorage bundle; the photo itself does not.
   - **Intro title card** (`evIntro` toggle, persisted): the song title fades
     in/out at the start of the clip. `evIntroWindow` guarantees it never
     overlaps a caption — it ends at the first caption after the clip start
     (4.5 s max) and is skipped entirely when a caption is already up at the
     clip start or there's under 1.4 s of room (the panel says so).
   - **Trim** (`evTrimStart`/`evTrimEnd`, 0/0 = whole song): a row under the
     preview scrubber — scrub anywhere, tap "Start here" / "End here" (3 s
     minimum with a friendly guardrail note; "Whole song" resets). The
     clipped-off ends show as dark shading on the scrubber and the Export
     button becomes "Export Clip (m:ss)". Export seeks to the clip start, a
     33 ms watcher ends the recording at the clip end (the audio element's
     "ended" never fires mid-song), progress and the WebM duration patch use
     the clip length, and the paint clock is clamped to the clip end so the
     sealing grace beat can't flash the caption stamped right at it. Captions
     keep their absolute stamps — a clip starting mid-song simply opens on
     whatever caption is current there. Trim resets whenever new audio loads.
   - Caption styling: Classic / Bold / Karaoke / Fade / Anthem / Handwritten /
     Neon, size, font, position, text/background colors, contrast warning;
     live 16:9 canvas preview painted every frame from the audio clock
     (`evRenderFrame` is the single renderer shared by preview, thumbnails,
     and the video export). The three newer styles are canvas-drawn
     animations, so they record into the export like everything else:
     **Anthem** = huge all-caps that punches in with a quick scale-up on each
     new line (canvas transform, 80%→100% in ~0.22 s); **Handwritten** = a
     gentle ~0.7 s fade-in per line; **Neon** = a colored glow (canvas
     shadowBlur in the text color) reusing the karaoke wipe timing.
   - **Karaoke experience** (Karaoke + Neon styles — the app's flagship, the
     whole point is singing along): word-level timing doesn't exist, so each
     word gets a share of its line weighted by word length, and the fill
     sweeps left-to-right *through* each word (canvas clip-rect wipe) in the
     **"Sung words turn" color** (`evHl`, own swatch row shown only for
     these two styles, persisted with the look; when it equals the text
     color the wipe falls back to brightness alone — that's the Neon
     template's tube-warming look, and the contrast warning checks `evHl`
     too). The **next line** shows small and dim under the current one
     (always part of the block layout so nothing jumps), and gaps get a
     **"get ready" display** (`evDrawNextUp`): the upcoming line dim plus
     3·2·1 countdown dots in the final 3 s — before the first line and after
     instrumental breaks. A line followed by a long gap (> its natural pace
     + 4 s, `natural = 0.42 s × words + 0.6`) doesn't crawl across the
     silence: it lights at natural pace, holds 1.8 s, fades out and hands
     off to the get-ready display; lines in continuous singing keep their
     full span exactly as before. All of it flows from `evSceneAt`'s fields
     (`nextText`, `nextIn`, `span`) through `evRenderFrame`, so preview,
     thumbnails and export can never disagree; scenes without `span` (style
     thumbnails) fall back to plain `frac`. Other styles are untouched — no
     preview line, no dots.
   - **Preview player**: the preview behaves like a phone video editor — tap
     the video itself to play/pause (a big play badge overlays while paused),
     drag the bar under it to jump anywhere (`evBindScrubber`: hand-bound
     pointer-capture drag; mid-drag the thumb/fill/clock are painted straight
     into the DOM with re-renders suppressed via `this.evScrubbing`, state
     catches up on release), and small ticks on the bar mark each timed
     caption line. The preview rAF loop also glides the scrubber every frame.
     On phones (≤720 px) the preview + player block is sticky under the
     header (`.ev-preview-sticky`) so the live result stays visible while
     scrolling the styling controls. The old standalone audio card now shows
     only outside the editor (paste step — `evShowMiniPlayer`).
   - **Templates**: a "Templates" row at the top of the styling area
     (`EV_TEMPLATES`) with four complete pre-designed looks — Karaoke Night
     (first, and the first-run default: white words turning warm yellow on
     deep navy), Anthem, Handwritten, Neon — each shown as a live mini-canvas
     rendering "The Quick Brown" in that template's own style/font/size/colors
     (painted by `evRenderFrame`, like every other thumbnail). One tap applies
     the whole bundle (style, size, font, text/highlight/background colors,
     position) by setting the ordinary styling state — every manual control
     still works afterwards. A subtle "Template: Anthem" badge sits next to the header
     and switches to "(edited)" the moment any control differs from the
     template's look (derived by comparison in `evTemplateState()`, never
     stored, so it can't go stale). The picked template id rides along in the
     same localStorage bundle as the other caption settings, so the last-used
     look — template included — is the default for the next song.
   - Flow hint: once lyrics are loaded but nothing is timed yet (and no
     summary banner is up), one small line above the timing toolbar says
     "Next: Auto-caption (AI) or tap Sync lyrics to time your captions."
   - **Video export**: records a 1920×1080 canvas (same renderer) + the song
     via `canvas.captureStream(30)` + Web Audio + `MediaRecorder`. Format is
     picked per device (`evPickMime`): Apple devices/browsers (iPhone, iPad,
     Safari — `evPreferMp4`) get **MP4 first** (H.264+AAC, the format the
     iPhone Photos app accepts); everything else keeps the proven **WebM
     first** (VP9→VP8→plain) — each side falls back to the other, so nothing
     capable is ever refused. No screen capture, no page UI in the file.
     Full-screen progress view with Cancel locks the app while recording
     (recording is real time: a 3-minute song takes ~3 minutes); a best-effort
     screen **wake lock** keeps phones from sleeping mid-recording. The file
     is `<Title> - Lyric Video.mp4|webm` (illegal characters sanitized).
     The finish differs by device (`evCanShareFiles`): iPhones/iPads (any
     device whose share sheet takes files) do NOT auto-download — they get a
     **"Save to iPhone Photos"** button (`evSaveToPhotos`: `navigator.share`
     with the file; one tap on "Save Video" in the sheet lands it in Photos —
     Apple allows no more-automatic path, a share needs a user gesture) plus
     a "Download instead" fallback; desktops auto-download as before with
     "Download again". Both then show size / duration / resolution / format,
     keep their buttons until a different song is loaded, and warn when the
     file is over 35 MB (too big for the Drive auto-save — the warning tells
     the owner to drag the downloaded file into the Drive folder instead).
   - **Save to Google Drive**: after a successful export, a "Save to Google
     Drive" button (next to "Download again") sends `this.evExportBlob` to the
     backend's `save_video`, which files it in a Drive folder named
     **"Tune Studio Videos"** and logs a row on the Sheet's **"Videos"** tab
     (Video ID, Song ID, Date Created, Caption Style, Drive Link, YouTube
     Link, Notes, Title — folder and tab are auto-created). Optional YouTube
     link + notes inputs feed the log. Upload uses `XMLHttpRequest` (not
     fetch) purely for upload progress, written into `data-ev-save-pct` DOM
     hooks; over 35 MB nothing is uploaded and a plain-English message points
     at the manual drag-into-folder path. Success shows the Drive link;
     failure keeps the app and the downloaded copy untouched and offers retry.
     The loaded song's sheet ID rides along as `state.evSongId` ('' for
     uploads).
   - **My videos**: a card under the editor lists everything from the Videos
     tab via `list_videos` (newest first) — title, date, caption style, and
     Drive / YouTube links.
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
       original blob, which still plays. MP4 recordings skip the patch
       (Safari writes the duration itself).
     - The finished `Blob` stays on the instance as `this.evExportBlob`,
       details in `state.evExport` — that's what Save-to-Drive uploads, so no
       re-export is ever needed.

## The backend (Google Apps Script)

- The full script lives in `apps-script/Code.gs` (install/redeploy steps in
  `apps-script/README.md`). The deployed copy runs in the owner's Google
  account, bound to the "Tune Studio Database" sheet — changing the repo copy
  does nothing until the owner pastes it into Apps Script and deploys a
  **New version** on the existing deployment (same URL).
- Request types: `status`, `ai_search`, `ai_write`, `original`,
  `list_originals`, `update_original`, `delete_original`, `save_video`,
  `list_videos`, `transcribe_audio`. Body `{ type, data, provider, token }` →
  `{ ok: true, … }`.
- `transcribe_audio` always uses Gemini (`GEMINI_API_KEY`) regardless of the
  picked provider — it's the only configured provider wired for audio input.
  It takes `{ audioBase64, mimeType, knownLyrics }`, asks for strict JSON
  (`responseMimeType: application/json`), parses defensively
  (`parseTranscription`: fences stripped, numbers validated, times must never
  decrease, ties nudged +0.1 s, count must match `knownLyrics` when given)
  and retries once with a blunt format reminder before giving up with a
  plain-English error that points at tap-sync.
- Song/video IDs (`MS-###` / `VID-###`) come from a forward-only counter in
  Script properties, seeded from the highest ID in the sheet — deleting rows
  can't cause duplicate IDs. Sheet writes go through `withLock`; the optional
  `AI_TOKEN` script property gates every type except `status`.
- Videos land in the Drive folder **"Tune Studio Videos"** and the Sheet tab
  **"Videos"**; both are created automatically when missing.

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
