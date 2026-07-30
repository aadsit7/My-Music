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
   per-section AI rewrite, copy for Suno. A **"+ New song"** button (list
   header and empty state) opens the same detail editor on a blank, unsaved
   song (`myNew` flag, `mySel` null) so the owner can type/paste a title,
   lyrics and style by hand — no AI needed; Save writes it via the `original`
   endpoint (like the Songwriter's Save) then folds it into the list as a
   normal saved song. Delete and per-section AI are gated off until it's saved.
   - **Files kept with a song** (a **"Files"** box at the bottom of the song
     detail): anything that belongs with the song — the finished track, a video,
     cover art, a photo of a handwritten lyric sheet. The file goes to Google
     Drive (folder **"Tune Studio Files"**, one sub-folder per song named
     `<Song ID> - <Title>`) and a row goes on the Sheet's **"Files"** tab, so
     it's still there next time the song is opened, on any device. Endpoints:
     `save_song_file` / `list_song_files` / `get_song_file` /
     `delete_song_file`.
     **One metadata call covers the whole library** — `loadMyFiles` runs once
     when the tab opens (`state.myFiles`, a flat list for every song), so
     opening a song needs no fetch and the song *list* can show a per-song file
     count (`myFileCounts` in `renderVals`). Bytes are only moved when a file is
     actually viewed or downloaded.
     **Viewing happens inside the song**: photos, songs, videos, PDFs and text
     files (`MY_FILE_KINDS`) open under their row — one at a time — by fetching
     the bytes back through `get_song_file` into a blob URL cached on the
     instance (`this.myFileBlobs`, dropped by `myDropFileBlobs` whenever a
     different song is opened, since a few of these run to tens of MB). Going
     through the backend rather than a Drive link is deliberate: **nothing has
     to be shared publicly to be viewable**, and no Google sign-in is needed in
     the browser. Media addresses go in through `data-src` and are copied to
     `src` by `syncMediaSrc()` for the same reason the two iframes do it —
     `src="{{ … }}"` makes the browser fetch the literal placeholder and paints
     a red "[bundle] error" panel over the app; the comparison guard also stops
     a re-render restarting a song mid-listen.
     Anything else (a .zip, say) still uploads, lists and downloads — it just
     gets no View button. **Download** saves the fetched blob with its real
     name; on a phone whose share sheet takes files the sheet is offered
     instead (the route into Photos/Files), but only when the bytes are already
     in hand — fetching first uses up the tap a share needs, so the first tap
     on an un-fetched file just downloads it and a second one opens the sheet.
     Uploads are **sequential**, several files per pick, progress written
     straight into `data-my-file-pct` (a re-render per percent would rebuild the
     card — same reason as the export progress and sync clock), and never
     retried: a repeat could file a second copy.
     **30 MB per file** (`MY_FILE_MAX_BYTES`), checked in the browser before
     anything is sent and again in the backend. The limit is deliberately the
     same in both directions — a file that went up can always come back — and
     the note points anything bigger at the Drive folder by hand.
     The whole box is gated on the song being **saved** (a file is filed under
     the song's Sheet ID), same as Delete and the per-section AI; a new song
     shows a plain-English "save it first" note instead.
     Removing a file sends the Drive copy to the **trash**, not a hard delete.
     Deleting a *song* leaves its files alone — an upload is never thrown away
     as a side effect — and the confirm box says so when there are any.
     **When the deployed script is older than the app** (the very first thing
     that happened in the wild: the owner's Apps Script still predated this
     feature, so all four endpoints answered `Unknown request type`), the box
     says so and gives the redeploy steps — `state.myFilesOutdated`, set from
     `loadMyFiles` and from a refused upload, hides the pointless "Add a file"
     button (`myFilesCanAdd`, a separate gate from `myFilesCanAttach` so the
     explanation itself is never hidden with it) and suppresses the "Checking
     Google Drive…" note. Every per-file failure goes through
     `myFileFailMessage`, so an out-of-date script explains itself there too
     instead of looking like a broken file. See the `apiRequest` section for why
     this is classified as its own kind of failure.
6. **Settings** — AI provider picker, access token, provider status, plus
   **"Test the AI connections"** (`testProviders`): the Ready / No key badge
   only ever meant "a key is saved", which is not the same as "this works" —
   a key whose credit has run out, or one whose model the provider has since
   retired, still showed as Ready and then failed every song. The button sends
   a one-line real request to each AI that has a key (failover deliberately
   OFF — the point is to hear from *that* one) and reports what actually came
   back, per provider.
   Above it sits **"Google Sheet connection"** (`testSheet`, steps in
   `SHEET_TEST_STEPS`), for the complaint that used to be unanswerable — "it
   isn't connecting to my Sheet" — because every way of failing looked
   identical: a spinner, then one short red line. Five separate things sit
   between the owner and their songs, each needing a different fix, so the test
   walks them one at a time and names the one that broke:
   **online** (the device itself) → **reach** (a plain GET of the script's
   address, via `sheetPing` — deliberately not `apiRequest`: no retries, no
   failover, just one clean yes/no, cache-busted so a stale cached answer can't
   sail through) → **sheet** (the app's real POST, which Apps Script answers
   with a redirect the browser must follow and which a blocker or VPN stops even
   when a plain read works) → **songs** (the sheet tab itself) →
   **version** (is the deployed script as new as this app?).
   That last step exists because the app updates itself on every page load while
   the Apps Script only changes when the owner deploys it by hand, so the two
   drift apart — which is how the first four steps can all pass green and a
   newer feature still fails. It asks with the newest request type there is
   (`list_song_files`); an older script answers `Unknown request type` and gets
   the copy-and-paste redeploy steps instead of a shrug. `sheetFailMessage`
   turns each failure into one sentence the owner can act on, and `reached`
   changes the advice for the POST step completely (address fine + POST blocked
   ⇒ blocker/VPN, not a dead deployment).
7. **Edit Video** — lyric-video maker:
   - **Staged editor (`state.evStage`, `onEvStage`)**: once a song is loaded
     and `evStep === 'ready'`, the controls are split into two focused stages
     behind a segmented switcher that sits under the always-visible preview —
     **Captions** (`evStageCaptions`: the lyric list + all its timing tools)
     and **Style** (`evStageStyle`: templates + the whole look). Only one
     stage's controls mount at a time, so the phone never shows the whole
     wall of buttons at once (the "too many buttons" fix). The preview canvas,
     player and Export button stay outside the switcher so they're visible on
     both stages; the styling thumbnails are painted on-mount by `evDrawThumbs`
     when the Style stage appears (querySelectorAll → no-op when hidden), and
     the preview loop keeps running because its canvas is never unmounted.
     `evStage` resets to `'captions'` on every song load / accept. Switching
     stages first commits any open line edit (`evCommitEdit`) so a half-typed
     line can't be stranded off-screen.
   - Load a song from My songs (lyrics + linked audio when the sheet row has
     a playable URL) or upload an MP3/WAV and paste lyrics. Audio never
     leaves the browser.
   - Lyric lines are editable; `[Section]` headers never become captions. A
     resting timed line shows just its number, words, time pill and −/+/▶
     nudges; **"Re-sync from here" moved off every row into the open line
     editor** (`data-ev-act="resync"` → `onEvLineAction` → `evResyncFrom`,
     which folds in the edit and no-ops without audio) to keep the list clean.
   - Tap-along timing sync (full-screen view): live "x of y timed" counter,
     stamped lines show ✓, the waiting line sits on a brand-soft pill.
     **Back a line** (footer button, or Backspace/Z) un-stamps the last tap of
     the current session only (`evSyncStartIdx` guards re-sync runs), puts the
     highlight back and replays from 2.5 s before the bad stamp. Pausing turns
     the big button into Resume, and any resume mid-sync rewinds 2 s first
     (`evSyncTogglePause`, gated on `evSync` so the auto-caption review's
     pause button is unaffected). Taps give a `navigator.vibrate` tick where
     supported; hints never mention the keyboard on coarse-pointer devices.
     Per-line −/+ 0.1 s nudges, plus an **"Every caption" − / + row**
     (`evShiftAll`, shown once ≥2 lines are timed) that shifts every timed
     line 0.1 s at once — the fix for "each tap landed a touch late" — blocked
     with a plain-English note at 0:00 and the song's end. Preview-from-line,
     re-sync from a line, save/load timing file.
   - **Auto-caption — LOCAL engine (the primary caption timer)**: a small
     Whisper speech model runs ON THE DEVICE via transformers.js — no API
     key, no backend call, no quota, and the song never leaves the browser.
     Constants `EV_WHISPER_LIB_URL` (`@xenova/transformers@2.17.2` from
     jsDelivr) and `EV_WHISPER_MODEL` (`Xenova/whisper-tiny.en` — tested
     against base.en: 1.8× faster, ~⅓ the download, equal line-timing
     accuracy after alignment). The library + model load **lazily, only when
     Auto-caption first runs — never on page load** (~45 MB one time; the
     busy card says so and shows a real download %). After that the browser's
     own cache serves it, so later runs start in seconds and work offline.
     The engine runs in a **Web Worker built from a string**
     (`EV_WHISPER_WORKER_SRC`, module worker from a blob URL — single-file
     app friendly), so the page stays responsive and **Cancel really works**
     (`terminate()`); the worker is dropped after every run to give the
     memory back. Audio is fetched to a local blob (same as export, same
     CORS-link error), decoded to 16 kHz mono via Web Audio
     (`evDecodeAudio16k`), and Whisper returns word-level timestamps
     (30 s windows, 5 s stride). Progress %: `data-ev-ac-*` DOM hooks
     (`evAcSetPct`), phase text in `evAcPhase` state.
     Two paths: with existing lyrics (My songs / pasted), **the owner's lines
     are gospel** — `evAlignLines` fuzzy-aligns them to Whisper's word stream
     (Needleman-Wunsch over `evWordSim` word similarity; Whisper only
     supplies timing). Weakly-matched lines (< 50 % of words, guards against
     stolen neighbours when Whisper drops a line) are filled in between the
     timed neighbours **weighted by syllable count** (`evSyllableCount`, the
     same duration model the no-AI onset fallback uses) rather than evenly by
     line number — a dropped 2-word interjection and a dropped 12-word line
     don't take equal time to sing, so even spacing landed the hard,
     instrument-heavy songs' dropped lines visibly off; syllable-weighting cut
     synthetic dropped-line error ~34 % with the confidently-heard lines left
     byte-identical. A run with overall match quality < 0.35 fails with a
     plain-English message instead of applying garbage.
     **Global lag de-bias (`evEstimateGlobalLag`, the systematic-offset fix —
     runs BEFORE the onset snap)**: every world-class lyric syncer takes the
     ASR's CONSTANT timestamp bias out of the whole track before any per-line
     work. whisper-tiny reports each sung word's start a fairly constant
     fraction of a second LATE (it must hear into a word before it fires), so
     every caption inherits the same lag — "the words are right but everything's
     a beat behind." The per-line onset snap below only fixes a line when a
     vocal onset lands inside its tight window, so a soft vocal entry, a line
     buried under the band, or an unheard (interpolated) line keeps the full lag
     and the result feels un-synced. So we measure the lag ONCE: for each
     confidently-heard (`placed`) line with a vocal onset within ±0.7 s, record
     (alignedStart − onset); the **median** of those deltas (robust to the few
     lines that snapped to the wrong onset — a mean would be dragged around) is
     the systematic lag, trusted only with ≥ 6 samples and clamped to ±0.6 s so
     a freak estimate can't wreck a good run. That single constant is subtracted
     from EVERY line (the interpolated and missed-onset lines the local snap
     can't reach included), then the local snap re-locks the confident lines to
     the millisecond — global de-bias then local refine, the two-stage fix pro
     forced aligners use. Verified on 40-song synthetic batches: on a constant
     0.35 s late bias (the classic Whisper symptom) mean line error falls
     **0.315 s → 0.087 s (−73 %)**; heavy 0.5 s bias −54 %; a negative/early
     bias is detected and corrected too; and on a near-zero-bias song it's a
     strict no-op (1 %), so it can't harm a song that isn't lagged, and max line
     error never worsened in any scenario. The no-AI onset fallback
     (`evDistributeToOnsets`) and the manual "Tighten timing" path don't use it
     — they carry no ASR bias to remove.
     **Onset-refined line starts (the accuracy-fusion step)**: the aligner
     knows WHICH line each start belongs to, but Whisper's word timestamps are
     coarse (tiny quantizes to ~20 ms frames and rounds a sung onset a few
     tenths early/late). So after the de-bias above, `evRefineLinesToOnsets` snaps each
     confidently-heard line start onto the nearest real sound onset
     (`evDetectOnsets`) within a tight ±0.35 s window — ASR picks the line, the
     onset pins the millisecond, the exact fuse professional forced aligners
     use. **The onsets here are VOCAL-shaped** (`evDetectOnsets(blob, true)`:
     sub-bass cut to 220 Hz, a +6 dB lift at the 2.7 kHz vocal-presence band,
     top rolled off at 3.6 kHz) so the snap targets are SUNG attacks, not drum
     hits — this matters because a percussion onset sitting inside the window
     would otherwise yank a caption a few tenths off the voice. Measured on
     synthetic songs with a percussion grid: full-mix onsets cut mean error but
     could push an individual line's error ABOVE the un-refined estimate
     (max 0.86 s → 1.01 s — the refinement occasionally hurting); vocal-shaped
     onsets cut mean line error further (0.16 s → 0.11 s) AND never worsen a
     line past the aligned baseline (max stays 0.86 s). The manual "Tighten
     timing" button keeps the plain full-mix `evDetectOnsets(blob)` — it aligns
     the owner's taps to any musical beat, not only the voice. Kept
     conservative so it can only help: a directly-heard line (the aligner's
     `placed` flag) moves at most **0.35 s** — a correction to Whisper's coarse
     timestamp; an interpolated line (Whisper never heard it, so its
     syllable-spread time is the least certain we have) may reach a real vocal
     attack within a wider **0.5 s**, because for those a nearby onset is
     stronger evidence than the guess. Both are order-preserving, one onset
     serves one line, and it's best-effort (audio unreadable for onsets, or too
     few vocal onsets found → keep the aligned times). The interpolated-line
     snap is passed as `evRefineLinesToOnsets`'s optional fifth arg
     (`interpWindow`); omitting it keeps the old placed-only behaviour, which
     the manual "Tighten timing" path still uses. Verified on synthetic songs:
     heard lines stay byte-identical to before, dropped-line error falls a
     further ~15 % on top of the syllable-weighting, and the worst-case line is
     unchanged (a gap-extrapolation line with no nearby onset, caught in the
     mandatory review). Verified on synthetic coarse/late
     word streams: mean line error drops from ~0.25 s to ~0.02 s (max ~0.32 s →
     ~0.11 s); with the earlier back-projection the plain aligner already
     reaches ~0.25 s, so the two stack. Per-word karaoke timing was evaluated and deliberately NOT wired
     in: word-to-word stamps are not reliable enough inside lines
     (first-word-after-silence stretching, dropped words), so the karaoke wipe
     keeps its length-weighted estimate — but the wipe anchors to each line's
     start, so tighter line starts sharpen the karaoke sweep too.
     With no lyrics (paste step), `evWordsToRows` breaks Whisper's own words
     into caption-sized lines (gap > 1.2 s, ≥ 9 words, or sentence end).
     Feature detection: no WebAssembly/Worker → with known lyrics we don't
     need the model at all (see the no-AI onset fallback below); with none we
     hand to the cloud AI. **iPhone Safari is untested** in this environment —
     the failure path is graceful, but test on a real iPhone.
     **NO-AI onset fallback (known lyrics) — the primary safety net now**:
     when the on-device model can't run (old phone, out of memory) or matches
     the lyrics poorly (align quality < 0.35 after the vocal-boost rescue),
     and the words are already known (My songs / pasted), the app places the
     lines from the song's own sound onsets instead of reaching for the cloud
     — `evAcOnsetFallback` → `evDistributeToOnsets(known, onsets)`, which
     spreads the lines between the first and last onset weighted by syllable
     count (`evSyllableCount`) and snaps each onto the nearest onset (≤ 1.5 s)
     that keeps the order. Reuses `evDetectOnsets` (the same pure Web Audio the
     "Tighten timing" feature uses) — no model download, no network, works on
     every phone, never fails. It's a deliberately rough first pass (verified
     ~0.3 s line error on beat-marked test audio) that the owner refines in the
     mandatory review, per-line nudges and Tighten timing. This is the fix for
     "make Auto-caption work without relying on the online AI". Cloud is only
     reached if even onset detection can't run (near-silent audio) or there are
     no known lyrics to place.
     **Gemini demoted, not deleted**: the backend's `transcribe_audio` is
     never called on the default path. It survives as `evAutoCaptionCloud`,
     offered as a "Try cloud captioning instead" button on the local engine's
     failure card (`evAcCloudOffer`) and as the last-resort automatic fallback
     when there are no known lyrics, with its old 13 MB cap. The backend's
     `geminiGenerate` now retries a transient overload (503 "high demand", 429,
     500) with exponential backoff and walks the fallback models if one stays
     jammed (`isTransientGeminiError`, total-call budget), so the cloud backup
     actually lands instead of dying on the first 503 — the reason it "never
     worked" before.
     Both engines share `evAcBegin` (job token, busy card) / `evAcFinish`
     (guardrails, review) — a new `evAcBegin` also terminates any older
     worker BEFORE minting the new job token, so a superseded run can never
     kill its successor's worker (real bug, don't reintroduce).
     **RULE — never bypass this: transcription results must ALWAYS pass
     through the mandatory full-screen review screen.** There the owner
     rewords lines, deletes junk lines, and plays any line from 2 s before
     its stamp; only "Accept captions" applies them, "Discard" (with confirm)
     leaves everything untouched. Accepted captions are ordinary timings —
     nudges, re-sync-from-a-line, styles, preview, export and Drive save all
     work unchanged — and the ascending-order guardrail is enforced at every
     step (engine result, `evAcFinish`, accept). When the run aligned the
     song's own lyrics one-to-one, review rows carry `srcIdx` back to their
     `evItems` line, so accepting keeps `[Section]` headers and drops
     review-deleted lines; transcribed rows replace the line list wholesale.
     The tap-sync flow is untouched and remains the manual fallback for a
     bad result. While the review screen is open, the audio `timeupdate`
     re-render is suppressed (like sync mode) so the reword box can't be
     wiped mid-typing by a re-render during spot-check playback.
     Any new full-width screens for this feature must follow the mobile
     rules: cover or clear the tab bar (`position:fixed;inset:0;z-index:5000`
     like sync/review/export), respect `--safe-bottom`, 44 px touch targets,
     inputs ≥ 16 px font.
     **Auto-start**: captions kick off by themselves — `evMaybeAutoCaption`
     runs when fresh audio becomes readable (one-shot `evAcAutoArm`, armed in
     `evSetAudio`, fired from `loadedmetadata` a tick later) and again when
     pasted lyrics land (`evLoadPasted` cancels a word-guessing run still in
     flight via the job token and restarts on the high-accuracy path). It
     bails when anything is already timed (loaded timing file / finished
     sync) or the tab is busy (sync, export, tighten-timing, open review), so
     it can never stomp work; both triggers are one-shot events, so a failed
     or discarded run never loops — the Auto-caption button stays the manual
     retry, and the mandatory review rule above applies to auto runs exactly
     as to button presses. Auto-start invokes the LOCAL engine (first use
     triggers the one-time engine download); the cloud path only ever starts
     from its failure-card button.
     **Background guard (the "keeps running when I switch apps" fix)**: a
     caption run must survive the owner leaving — switching the app's own
     tabs, switching iPhone apps, the screen locking, the desktop tab being
     hidden. Desktops already keep a hidden tab's worker crunching; PHONES
     SUSPEND the whole page moments after it leaves the screen, and the one
     thing a page may keep doing in the background is play audio — the same
     allowance every music web app runs on. So `evBgGuardStart` (called from
     `evAcBegin`, which local, onset-fallback and cloud runs all share, so
     the guard spans engine handoffs seamlessly) holds three layers for
     exactly the length of a run: (1) a looping keep-alive `<audio>` playing
     generated SILENCE (built once in `evBgKeepEl` — 1 s of 8-bit midpoint
     samples; never `muted`, because a muted element doesn't count as
     "playing audio" while silent samples do, and nothing is ever heard);
     (2) a screen wake lock (export's exact pattern, re-requested on every
     return to visibility) so the phone doesn't auto-lock while the owner
     watches the spinner; (3) a 2 s watchdog that replays the keep-alive
     after an interruption (a phone call, iOS pausing media on app switch)
     and calls `evBgGuardStop` the moment `evAcJob` dies — ANY way it dies
     (finish, fail, Cancel, loading another song, Start over, plain export),
     so the guard can never outlive a run even if a future kill-site forgets
     to stop it. Phones only allow audio to start from a real tap, and
     auto-caption starts itself with no tap in hand — so the FIRST tap
     anywhere in the app blesses the player (`evBgArmUnlock`, armed at mount
     on touch devices: play, then straight back to pause). During a run,
     `navigator.audioSession.type = 'playback'` is declared where Safari
     offers the API (restored on stop), and Media Session metadata names the
     lock-screen card honestly ("Tune Studio — Auto-captioning your
     song…"). The keep-alive only engages on touch devices (`EV_BG_TOUCH`) —
     a desktop tab would just show a mystery speaker icon for no benefit —
     while the wake lock and watchdog run everywhere. Progress survives
     leaving: `evAcSetPct` remembers the last fraction on the instance
     (`evAcFrac`) and `componentDidUpdateEditVideo` repaints it whenever the
     busy card is up, so coming back from another tab never shows a lying
     0% (the card is also refreshed by the guard's visibility handler).
     Best-effort BY DESIGN: a browser that refuses a layer simply suspends
     the page as before, and the run resumes exactly where it froze when
     the page comes back — nothing is lost either way; closing the browser
     still ends the run, and the busy card tells the owner both facts in one
     line. iPhone Safari itself is untested in this environment (standing
     caveat) — these are the layers real music web apps rely on, but confirm
     on a real iPhone before calling it done there.
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

## Talking to the backend (`apiRequest`) — read before touching it

Standing rule 1 still holds: `SHEETS_ENDPOINT` is not to be changed. What
lives around it now is a resilience layer, added after the app was found
stuck on "Writing your song…" for ever on a phone. Three separate faults,
all real, all measured:

1. **A request that never comes back.** `fetch` had no timeout, so a locked
   screen, a 5G-to-Wi-Fi handoff or a carrier proxy dropping an idle socket
   left the promise pending for ever — spinner turning, no error, no way out.
   Writing a song genuinely takes ~50 s (measured against the live backend),
   so the socket sits idle exactly long enough to get dropped. Now every
   attempt has a hard deadline (`apiTimeoutFor`) **and** the whole request has
   an overall ceiling (`apiDeadlineFor`) that retries and hand-offs share —
   without the ceiling, three back-to-back 110 s attempts meant five minutes
   of spinner, barely better than for ever. Verified: a permanently stalled
   socket now gives up at ~168 s with a plain-English message; before, it was
   still spinning at 200 s+ with no end.
2. **A passing hiccup** — dropped connection, a 5xx, "high demand". One blip
   used to end the request. Retried now with a growing pause; after a
   *timeout* the pause is skipped (the wait already happened).
3. **The picked AI being out of action.** `apiErrorKind` sorts failures into
   `fatal` (bad token — stop), `outdated` (the deployed script has never heard
   of this request — stop, see below), `provider` (no key, quota gone, retired
   model — a different AI may work) and `transient` (repeat). On a `provider` error an
   `ai_write` / `ai_search` request is handed to the next AI that has a key
   (`apiProviderChain`, ordered by `PROVIDERS`, filtered by the `status`
   call's key map). **This is the part that works with the backend exactly as
   already deployed** — no redeploy needed. The status probe is kicked off at
   mount so the chain is known before it is needed.

**Never retry a write.** `apiRetryable` allows repeats only for reads and AI
calls (all pure). `original`, `update_original`, `delete_original`,
`save_video`, `save_song_file` and `delete_song_file` get exactly one attempt,
so a slow save can't become two rows (or two copies of an uploaded file).
`get_song_file` and `list_song_files` are reads, so they retry — which means a
genuinely dead file costs three attempts before the error lands; that's the
right trade for a call that may carry 30 MB over a phone connection, and it has
its own longer timeout / deadline (`apiTimeoutFor`, `apiDeadlineFor`).

**Never retry an out-of-date script, and never blame the internet for it.**
The app half updates itself on every page load; the Google half only changes
when the owner pastes the new `Code.gs` in and deploys it. So the app routinely
runs *ahead* of its backend, and the backend answers anything it doesn't
recognise with `Unknown request type: <t>`. That is a permanent answer:
`apiErrorKind` returns `outdated` and the retry loop throws at once, alongside
`fatal`. Before this, an unknown type fell through to `transient` and was
repeated for the whole ~3-minute budget — which is exactly why the Files box sat
on "Loading…" for ever instead of saying what was wrong. `apiOutdatedBackend`
tests for it and `apiOutdatedMessage(what)` writes the one message, so every
caller says the same thing and gives the same steps.
The **wording** matters as much as the classification. The upload path is an
`XMLHttpRequest` (for progress), and a browser reports "the request never
completed" identically for a dropped connection and for a request something
blocked on the way out — it is not allowed to say which. `xhr.onerror` used to
assert *"couldn't reach Google — check your internet connection"*, which sent
the owner checking Wi-Fi for a fault that was never there while the real fix was
two minutes of copy-and-paste. It now names both possibilities and points at
Settings → "Test the connection", the one screen that can tell them apart.
Never re-introduce a message that states a cause the browser hasn't given us.

Busy cards use `aiJobStart()` / `aiJobStop(signal)`: the job owns the
`AbortController` (so **Cancel** genuinely aborts) and ticks elapsed seconds
plus a live note into `data-ai-elapsed` / `data-ai-note` **straight in the
DOM** — a re-render every second would rebuild the card, the same reason the
sync clock and export progress write to the DOM. Always pass the signal to
`aiJobStop` so a slow request finishing late can't switch off a newer job's
ticker. Cancelling is not an error: it clears the card and says nothing.

The Songwriter brief is refilled from `state.swPrompt` in `componentDidUpdate`
— it is an uncontrolled textarea inside a design-system component, so every
re-render rebuilt it empty, which is why the owner's screenshot showed a
placeholder under "Writing your song…" and why a failed request used to eat
what they had typed.

## The backend (Google Apps Script)

- The full script lives in `apps-script/Code.gs` (install/redeploy steps in
  `apps-script/README.md`). The deployed copy runs in the owner's Google
  account, bound to the "Tune Studio Database" sheet — changing the repo copy
  does nothing until the owner pastes it into Apps Script and deploys a
  **New version** on the existing deployment (same URL).
- Request types: `status`, `ai_search`, `ai_write`, `original`,
  `list_originals`, `update_original`, `delete_original`, `save_video`,
  `list_videos`, `transcribe_audio`, `save_song_file`, `list_song_files`,
  `get_song_file`, `delete_song_file`. Body `{ type, data, provider, token }` →
  `{ ok: true, … }`.
- `ai_write` wraps every request in `SONGWRITER_SYSTEM` (the "songwriter
  brain": hit-quality craft rules plus the Suno output contract — TITLE: /
  STYLE: lines and `[Section: vocal cue]` tags) unless the app already sent
  its own copy of the contract (`promptCarriesContract`), and retries once
  with a format reminder when the reply doesn't look like a song
  (`looksLikeSong`). The owner restored this from an older "v8" script —
  never drop it when editing Code.gs.
- A model row on the sheet's Settings tab overrides `DEFAULT_MODELS` — a
  stale "Gemini Model" value there (e.g. the retired `gemini-2.5-flash`) wins
  over the code's default, so check the sheet first when a model error
  persists after a redeploy.
- **Retired model names are this app's most common silent death.** Gemini did
  it to `gemini-2.5-flash`; DeepSeek then did exactly the same to
  `deepseek-chat`, which began answering `400 "The supported API model names
  are deepseek-v4-pro or deepseek-v4-flash"` — so picking DeepSeek in Settings
  failed every single time. Default is now `deepseek-v4-flash`, and the
  fallback-walk that only Gemini used to get is now `MODEL_FALLBACKS` for
  **every** provider, driven by the shared `resilientModelCall`
  (transient wobble → pause and repeat the same model; retired name → walk the
  fallbacks; anything else → throw at once). `isTransientAiError`,
  `isQuotaError` and `isRetiredModelError` classify; a blown quota is
  deliberately NOT transient — it doesn't clear in seconds, so retrying it
  just wastes the owner's time. `isTransientGeminiError` and
  `GEMINI_MODEL_FALLBACKS` are kept as thin aliases so the audio path reads
  the same as before.
- **Editing Code.gs changes nothing until the owner redeploys** (paste into
  Apps Script → deploy a *New version* on the existing deployment). The client
  is written not to depend on it: provider failover, timeouts and retries all
  work against the currently deployed script.
- `transcribe_audio` always uses Gemini (`GEMINI_API_KEY`) regardless of the
  picked provider — it's the only configured provider wired for audio input.
  Since the local Whisper engine became the primary caption timer, the app
  only calls it from the "Try cloud captioning instead" failure-state link —
  keep the endpoint working, but nothing depends on it day to day.
- Gemini's default model is the rolling alias `gemini-flash-latest` (fixed
  names get retired — `gemini-2.5-flash` started 404ing "no longer available"
  mid-2026 and silently broke Auto-caption). Every Gemini call goes through
  `geminiGenerate`, which (a) catches a 404 model-retirement answer and walks
  `GEMINI_MODEL_FALLBACKS`, and (b) retries a transient overload — 503 "high
  demand", 429 rate-limit, 500 hiccup (`isTransientGeminiError`) — the SAME
  model with exponential backoff (1 s, 2 s), then moves on to a fallback model
  if it stays jammed, all under a total-call budget so the slow audio path
  stays inside Apps Script's 6-minute limit; any other error (bad key, bad
  request) is thrown straight away. This is what makes the cloud caption backup
  actually land — before, a single 503 killed it. A model set on the sheet's
  Settings tab is still tried first.
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
  **"Videos"**; both are created automatically when missing. Files attached to a
  song land in **"Tune Studio Files"** (a sub-folder per song) and the **"Files"**
  tab — also auto-created. The song sub-folder is matched on the **Song ID
  prefix**, never the whole name, so renaming a song later finds its existing
  folder instead of starting a second one. File names are pushed through
  `safeFileName` (illegal characters out, 120 chars max, extension kept).
  `TEST_backend` reports both new items alongside the video ones.

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
- The AI request layer was verified in headless Chromium against the **live**
  Apps Script backend: a real song write (44–54 s), a live search (24 s), a
  live per-section rewrite (15 s), Cancel mid-flight, a simulated offline
  fetch (fails in 6 s with "you look offline"), a permanently stalled socket
  (gives up at ~168 s instead of spinning for ever) and provider failover for
  all three provider-down shapes (quota / retired model / no key). The
  container's egress proxy resets Chromium's TLS, so the test harness
  intercepts `script.google.com` and serves curl-fetched bytes; the shipped
  app talks to it directly. iPhone Safari could not be tested here.
- Export was verified in Chromium (Chrome). Firefox/Edge pass the feature
  detection on paper (WebM + captureStream + MediaRecorder) but were not
  test-run — say so honestly in checklists rather than claiming otherwise.
- **Files kept with a song** were verified two ways, both with the Apps Script
  endpoint intercepted and answered by an in-memory stand-in: in headless
  Chromium (all 7 tabs; adding several files at once; a photo shown, a song
  played and a text file opened inside the song; a real download with the right
  file name; removing a file; the over-30 MB refusal; a rejected upload; a file
  missing from Drive; cancelling a removal; the "save the song first" gate), and
  by running `Code.gs` itself under stand-ins for DriveApp / SpreadsheetApp /
  Utilities (folder layout, sub-folder reuse after a rename, byte-for-byte
  round trip, trash-not-delete, awkward and over-long file names, oversized
  payload refused before any write, a Drive file deleted by hand still clearing
  its row, no ID reuse). iPhone Safari could not be tested here — in particular
  the share-sheet route in `myDownloadFile` and whether an inline `<video>`
  plays a blob there.
- The background guard was verified in headless Chromium in two contexts
  (desktop, and touch-emulated with `--autoplay-policy=user-gesture-required`
  so the tap-blessing path really runs), with the jsDelivr URL intercepted and
  a fake transformers.js served with slow, controllable progress: a run
  survives switching app tabs mid-run and restores its % on return, finishes
  while another page has focus with review ready immediately, and the
  keep-alive lifecycle holds (blessed by first tap, playing for the whole
  run — across app tabs too — restarted by the watchdog after a forced
  pause, stopped on finish and on Cancel, media-card metadata set and
  cleared). True iOS suspension can't be reproduced in this container —
  iPhone Safari remains the honest untested caveat.
- The local caption engine was verified end to end in headless Chromium
  (espeak-generated test songs with known line times; word timestamps and
  the aligner checked against ground truth). Heads-up for future test rigs:
  this container's egress proxy resets Chromium's TLS, so the Playwright
  tests intercept cdn.jsdelivr.net / huggingface.co requests and serve
  curl-fetched bytes; the shipped app fetches them directly, no proxy
  involved. iPhone Safari could not be tested here — feature detection and
  the graceful failure message are in place, but say so in checklists until
  the owner confirms a real iPhone run.
