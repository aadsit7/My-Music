# Tune Studio backend — the Google Apps Script

`Code.gs` in this folder is the complete backend script for Tune Studio.
It handles everything the old script did (AI search, songwriting, saving /
listing / updating / deleting songs, the optional AI_TOKEN check, withLock
writes) **plus**:

- **`save_video`** — saves an exported lyric video into a Google Drive folder
  called **"Tune Studio Videos"** (created automatically) and logs it on a
  **"Videos"** tab in your Sheet (also created automatically) with columns:
  Video ID, Song ID, Date Created, Caption Style, Drive Link, YouTube Link,
  Notes — plus one extra column, **Title**, so the app's My Videos list can
  show the song's name.
- **`list_videos`** — returns everything on the Videos tab for the app's
  "My videos" list.
- **`transcribe_audio`** — the Auto-caption feature: the app sends a song's
  audio (up to ~13 MB — a 3-minute MP3 is ~4 MB) and Gemini returns timed
  lyric lines. When the song's lyrics are already known they ride along and
  Gemini only has to find *when* each line is sung, which is much more
  accurate than guessing the words. Needs `GEMINI_API_KEY` in Script
  properties. Bad AI output is retried once automatically.
- **Collision-proof IDs** — song and video IDs now come from a counter that
  only ever counts up (stored in the script's own memory, seeded from the
  highest ID already in your sheet). Deleting a row can never cause a
  duplicate ID again. All your existing IDs keep working unchanged.

## How to install it (step by step)

1. Open your Google Sheet (**Tune Studio Database**), then **Extensions →
   Apps Script**. The script editor opens.
2. **Keep a backup first:** click inside the old code, select all
   (Ctrl+A / Cmd+A), copy, and paste it into a document you keep somewhere.
   If anything ever seems wrong you can paste it back.
3. Select all the old code again and delete it. Paste in the entire contents
   of `Code.gs` from this folder. Press the **Save** (disk) icon.
4. **Grant the new Drive permission:** in the toolbar, where you pick a
   function, choose **TEST_backend**, then press **Run**. Google will pop up
   a permission screen — pick your account, click **Advanced → Go to …
   (unsafe)** if it appears (it's your own script), and press **Allow**.
   The list now includes Google Drive access — that's the new permission the
   video saving needs.
5. When it finishes, open **Execution log** (bottom of the screen). You should
   see a short report: your spreadsheet found, the My Songs tab counted, the
   Videos tab ready, the "Tune Studio Videos" Drive folder ready, and which
   AI providers have keys.
6. **Deploy the new version — this is the step people miss:** click
   **Deploy → Manage deployments**, click the **pencil** (edit) on your
   existing deployment, change **Version** to **New version**, then press
   **Deploy**. (Do NOT create a brand-new deployment — editing the existing
   one keeps the same web address the app already points at.)
7. Quick test: paste your web app URL (the `/exec` one) into a browser tab.
   You should see `{"ok":true,"service":"Tune Studio backend",…}`.

## Where the AI keys live

Same as before: **Project Settings (gear icon) → Script properties**. The
script looks for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GROK_API_KEY`, `DEEPSEEK_API_KEY` (a few other common spellings work too),
and the optional `AI_TOKEN` shared secret. Models and the Web Research
switch still come from the **Settings** tab of the Sheet.
