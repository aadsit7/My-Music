/**
 * Tune Studio — Google Apps Script backend
 * =========================================
 * This one file is the whole backend. It receives POST requests from the
 * Tune Studio web app and:
 *   · answers AI requests (song search, songwriting) via the provider picked
 *     in the app's Settings tab,
 *   · saves / lists / updates / deletes songs in the "My Songs" sheet tab,
 *   · saves exported lyric videos to the "Tune Studio Videos" Drive folder
 *     and logs them in the "Videos" sheet tab,
 *   · auto-captions songs: listens to an uploaded audio file with Gemini and
 *     returns timed lyric lines (transcribe_audio).
 *
 * Every request body looks like: { type, data, provider, token }
 * Every response looks like:     { ok: true, ... } or { ok: false, error }
 *
 * Configuration lives in two places:
 *   · The "Settings" sheet tab: Provider, per-provider model names, Web Research.
 *   · Script properties (Project Settings → Script properties): the AI API keys
 *     (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROK_API_KEY,
 *     DEEPSEEK_API_KEY) and the optional AI_TOKEN shared secret.
 */

// ---------------------------------------------------------------- constants

// Used only if this script ever loses its binding to the spreadsheet.
var FALLBACK_SPREADSHEET_ID = '1cOEZd9F5oDGjPQgiT19DefFqHRL-ew3XSS2t2WygMOw';

var SONGS_SHEET_NAME = 'My Songs';
var SONGS_HEADERS = ['Song ID', 'Date Created', 'Title', 'Style / Genre', 'My Request (Prompt)', 'Lyrics', 'Status', 'Suno Link', 'Notes'];

var VIDEOS_SHEET_NAME = 'Videos';
var VIDEOS_FOLDER_NAME = 'Tune Studio Videos';
// "Title" rides along as an extra last column so the app's My Videos list can
// show the song's name without a second lookup.
var VIDEOS_HEADERS = ['Video ID', 'Song ID', 'Date Created', 'Caption Style', 'Drive Link', 'YouTube Link', 'Notes', 'Title'];

var PROVIDER_LABELS = { claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', grok: 'Grok', deepseek: 'DeepSeek' };

// Script-property names checked (in order) for each provider's API key.
var PROVIDER_KEY_NAMES = {
  claude:   ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY', 'CLAUDE_KEY'],
  openai:   ['OPENAI_API_KEY', 'OPENAI_KEY', 'CHATGPT_API_KEY'],
  gemini:   ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_KEY'],
  grok:     ['GROK_API_KEY', 'XAI_API_KEY', 'GROK_KEY'],
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'],
};

// Auto-caption upload ceiling. Two limits stack here: Apps Script accepts a
// POST of roughly 50 MB, but Gemini's inline-audio API only accepts ~20 MB of
// total request. 18 MB of base64 (≈ 13 MB of audio — a 3-minute MP3 is ~4 MB)
// stays safely under both while leaving room for the prompt and lyrics.
var TRANSCRIBE_MAX_BASE64 = 18 * 1024 * 1024;

// Model used when the Settings tab has no row for a provider.
// Gemini uses Google's rolling "-latest" alias, which always points at the
// newest stable Flash model — fixed model names get retired (gemini-2.5-flash
// started returning 404 "no longer available" in mid-2026, which silently
// broke Auto-caption until this was found).
var DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-flash-latest',
  grok: 'grok-4',
  deepseek: 'deepseek-chat',
};

// If the picked Gemini model name is ever rejected as unknown/retired, these
// are tried next, in order, before giving up. Keeps Auto-caption (which can
// only run on Gemini) working across Google's model retirements.
var GEMINI_MODEL_FALLBACKS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'];

// ---------------------------------------------------------------- songwriter system prompt (restored from v8)

// The world-class songwriter "brain". Applied to every ai_write request so
// each draft is hit-quality AND formatted exactly the way the app's parser
// and Suno both need — including the per-section vocal-delivery tags.
var SONGWRITER_SYSTEM =
'You are a world-class, award-winning hit songwriter and topliner — the kind who writes #1 singles that millions stream on repeat. Deliver ONE complete, original song that could genuinely top the charts.\n' +
'\n' +
'CRAFT (make it world-class):\n' +
'- One strong concept and a title that sells it.\n' +
'- An instantly memorable, repeatable CHORUS that is the emotional payoff — the part people sing back after one listen.\n' +
'- Verses that build tension with contrast; a pre-chorus that lifts into the chorus; a bridge that turns.\n' +
'- Concrete, sensory, specific images and fresh turns of phrase — never clichés or filler.\n' +
'- Singable phrasing: consistent meter and syllable counts within each section, natural word stress, and a clear rhyme scheme.\n' +
'- Contemporary, conversational, human language. Every line earns its place.\n' +
'\n' +
'ORIGINALITY & COPYRIGHT SAFETY (critical):\n' +
'- Write 100% original words, hooks and melodies. Never copy or closely paraphrase any existing song.\n' +
'- NEVER put a real person\'s name in the output — no artists, bands, producers, or brands — anywhere: not in TITLE, not in STYLE, not in a section tag, not in the lyrics. If the request describes a reference style, translate it into plain descriptive terms (gender, vocal texture, delivery, genre, era-feel) only. Music generators reject real names.\n' +
'\n' +
'SUNO-READY OUTPUT CONTRACT (follow EXACTLY — non-negotiable):\n' +
'- Output ONLY the song. No preamble, no commentary, no explanations, no markdown, no code fences.\n' +
'- Line 1 must be exactly: TITLE: <the song title>\n' +
'- Line 2 must be exactly: STYLE: <8-12 comma-separated tags for the music generator\'s Style box — genre + subgenre, mood, tempo/energy, lead vocal type, key instrumentation, production aesthetic>. Keep them tag-like, not full sentences, and use no real names.\n' +
'- Then the lyrics. Each section starts with its tag in square brackets on its own line, using the structure tags: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]. Include the sections the song needs; a hit almost always repeats the [Chorus].\n' +
'- EVERY section tag must ALSO state HOW it is performed, written INSIDE the same brackets after a colon, so the music generator voices it correctly. Format: [Section: vocal cue]. Examples: [Verse 1: male vocal, melodic], [Pre-Chorus: male vocal, building], [Chorus: male & female harmonies, anthemic belt], [Verse 2: fast lightning rap, aggressive], [Bridge: female vocal, whispered], [Outro: layered gang vocals]. State the singer (male / female / duet / choir / gang vocals) and the delivery (melodic, belted, soft, whispered, falsetto, rap, fast rap, spoken, harmonized, gritty...), consistent with the lead vocal type on the STYLE line. Keep each tag under ~50 characters. NEVER put the vocal cue on its own separate line or in its own brackets — it must sit inside the section tag.\n' +
'- Write the chorus lyrics out in full every time it recurs — never write "repeat chorus" (repeat the [Chorus: ...] tag with its vocal cue each time).\n' +
'- Keep the whole lyric tight enough for a ~2-3 minute track: favor impact and repetition over length.\n' +
'\n' +
'If the request contains additional style, structure, or reference-artist instructions, honor them fully within all of the rules above.';

// True when the incoming request already carries its own copy of the output
// contract (e.g. the app prepended its SONGWRITER_DIRECTIVE) — in that case
// the backend must not stack a second copy on top.
function promptCarriesContract(prompt) {
  return /SUNO-READY OUTPUT CONTRACT/i.test(prompt) ||
         (/Line 1 must be exactly:\s*TITLE:/i.test(prompt) && /\[Section: vocal cue\]/i.test(prompt));
}

// True when a draft already follows the Suno contract: a TITLE: line plus at
// least one [Section] tag. Used to decide whether a corrective retry is needed.
function looksLikeSong(text) {
  return /(^|\n)\s*title\s*:/i.test(text) && /\[[^\]\n]{1,60}\]/.test(text);
}

// ---------------------------------------------------------------- entry points

function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route(body);
    if (!out || typeof out !== 'object') out = {};
    if (out.ok === undefined) out.ok = true;
  } catch (err) {
    out = { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
  return jsonReply(out);
}

// Visiting the /exec URL in a browser shows this — an easy "is it alive?" check.
function doGet() {
  return jsonReply({ ok: true, service: 'Tune Studio backend', time: new Date().toISOString() });
}

function route(body) {
  var type = String(body.type || '');
  var data = body.data || {};
  var provider = normalizeProvider(body.provider);

  // Optional shared-secret check: set AI_TOKEN in Script properties to require
  // it. "status" stays open so the app can learn that a token is required.
  var requiredToken = getProp('AI_TOKEN');
  if (requiredToken && type !== 'status' && String(body.token || '') !== requiredToken) {
    throw new Error('Unauthorized — open the app’s Settings tab and enter your access token.');
  }

  switch (type) {
    case 'status':          return handleStatus(requiredToken);
    case 'ai_search':       return handleAiSearch(provider, data);
    case 'ai_write':        return handleAiWrite(provider, data);
    case 'original':        return withLock(function () { return handleSaveOriginal(data); });
    case 'list_originals':  return handleListOriginals();
    case 'update_original': return withLock(function () { return handleUpdateOriginal(data); });
    case 'delete_original': return withLock(function () { return handleDeleteOriginal(data); });
    case 'save_video':      return withLock(function () { return handleSaveVideo(data); });
    case 'list_videos':     return handleListVideos();
    case 'transcribe_audio': return handleTranscribeAudio(data);
    default:
      throw new Error('Unknown request type: ' + type);
  }
}

// ---------------------------------------------------------------- status

function handleStatus(requiredToken) {
  var providers = {};
  for (var id in PROVIDER_KEY_NAMES) providers[id] = !!getApiKey(id);
  return { ok: true, providers: providers, tokenRequired: !!requiredToken };
}

// ---------------------------------------------------------------- AI requests

function handleAiSearch(provider, data) {
  var query = String(data.query || '').trim();
  if (!query) throw new Error('Nothing to search for — type a song name first.');
  var text = callAI(provider, songLookupPrompt(query));
  return { ok: true, text: text, provider: provider };
}

function handleAiWrite(provider, data) {
  var prompt = String(data.prompt || '').trim();
  if (!prompt) throw new Error('The songwriting request was empty — describe your song first.');

  // Restored v8 behavior: every songwriting request is governed by the
  // authoritative SONGWRITER_SYSTEM — unless the app already included its own
  // copy of the contract in the request, in which case it isn't doubled up.
  var fullPrompt = promptCarriesContract(prompt)
    ? prompt
    : SONGWRITER_SYSTEM + '\n\n=== THE SONG REQUEST ===\n' + prompt;

  var text = callAI(provider, fullPrompt);

  // One-shot self-correction (also from v8): if the model ignored the format,
  // ask again with a blunt reminder so the app's parser and Suno always get
  // clean input.
  if (!looksLikeSong(text)) {
    var retryPrompt = fullPrompt +
      '\n\n[FORMAT REMINDER] Return ONLY the song, nothing else. First line "TITLE: ...", ' +
      'second line "STYLE: ...", then the lyrics with each section as [Section: vocal cue] ' +
      'on its own line. No commentary, no markdown, no real names.';
    text = callAI(provider, retryPrompt);
  }

  return { ok: true, text: text, provider: provider };
}

// The app parses this reply as JSON, so the prompt pins the exact shape down.
function songLookupPrompt(query) {
  return [
    'You are a meticulous music researcher. Identify the one real, existing, released song that best matches this search: "' + query + '".',
    '',
    'Reply with ONLY a JSON object — no markdown fences, no commentary before or after. Use exactly these fields (empty string "" or empty array [] when something is unknown):',
    '{',
    '  "title": "official song title — or exactly \\"UNKNOWN\\" if you cannot confidently identify a real song",',
    '  "artist": "performing artist or band",',
    '  "album": "album it appeared on",',
    '  "released": "release year",',
    '  "writers": ["songwriter names"],',
    '  "producers": ["producer names"],',
    '  "key": "musical key, e.g. E major",',
    '  "tempo": "tempo, e.g. 96 BPM",',
    '  "timeSignature": "e.g. 4/4",',
    '  "genre": "short genre description",',
    '  "chordProgression": "main progression, e.g. E - B - C#m - A",',
    '  "melodyNotes": "2-4 sentences describing the melody and vocal delivery — how the verses and chorus move, where it soars, harmonies, dynamics",',
    '  "funFact": "one interesting sentence about the song",',
    '  "structure": [ { "section": "INTRO", "description": "one line: instrumentation and energy" }, { "section": "VERSE 1", "description": "..." } ]',
    '}',
    '',
    'The "structure" array must walk the whole arrangement in order (intro, verses, pre-choruses, choruses, bridge, outro — whatever the song actually has).',
    'Never invent facts: if you are not confident the song exists, reply {"title":"UNKNOWN"}.',
  ].join('\n');
}

function callAI(provider, prompt) {
  var key = getApiKey(provider);
  var label = PROVIDER_LABELS[provider] || provider;
  if (!key) {
    throw new Error('No ' + label + ' key configured — in the Apps Script editor open Project Settings → Script properties and add one, or pick a different provider in the app’s Settings tab.');
  }
  var settings = readSettings();
  var model = settings.models[provider] || DEFAULT_MODELS[provider];
  var web = settings.webResearch;

  if (provider === 'claude')   return callAnthropic(key, model, prompt, web);
  if (provider === 'gemini')   return callGemini(key, model, prompt, web);
  if (provider === 'grok')     return callOpenAiStyle('https://api.x.ai/v1/chat/completions', key, model, prompt, label, web ? { search_parameters: { mode: 'auto' } } : null);
  if (provider === 'deepseek') return callOpenAiStyle('https://api.deepseek.com/chat/completions', key, model, prompt, label, null);
  return callOpenAiStyle('https://api.openai.com/v1/chat/completions', key, model, prompt, label, null);
}

function callAnthropic(key, model, prompt, webResearch) {
  var payload = { model: model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] };
  if (webResearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  var data = aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  }, 'Claude');
  var parts = [];
  (data.content || []).forEach(function (blk) { if (blk.type === 'text' && blk.text) parts.push(blk.text); });
  if (!parts.length) throw new Error('Claude sent back an empty answer — try again in a moment.');
  return parts.join('\n');
}

function callGemini(key, model, prompt, webResearch) {
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  if (webResearch) payload.tools = [{ google_search: {} }];
  var data = geminiGenerate(key, model, payload);
  var cand = data.candidates && data.candidates[0];
  var parts = ((cand && cand.content && cand.content.parts) || []).map(function (p) { return p.text || ''; }).filter(String);
  if (!parts.length) throw new Error('Gemini sent back an empty answer — try again in a moment.');
  return parts.join('\n');
}

// OpenAI-compatible chat API — used by ChatGPT, Grok and DeepSeek.
function callOpenAiStyle(url, key, model, prompt, label, extraPayload) {
  var payload = { model: model, messages: [{ role: 'user', content: prompt }] };
  if (extraPayload) for (var k in extraPayload) payload[k] = extraPayload[k];
  var data = aiFetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  }, label);
  var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error(label + ' sent back an empty answer — try again in a moment.');
  return text;
}

function aiFetch(url, options, label) {
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, options);
  } catch (err) {
    throw new Error('Couldn’t reach the ' + label + ' service — try again in a moment.');
  }
  var code = resp.getResponseCode();
  var bodyText = resp.getContentText();
  var data = null;
  try { data = JSON.parse(bodyText); } catch (e) {}
  if (code >= 300) {
    var detail = '';
    if (data && data.error) detail = data.error.message || data.error.msg || JSON.stringify(data.error);
    throw new Error('The ' + label + ' service returned an error (' + code + ')' + (detail ? ': ' + String(detail).slice(0, 300) : '') + '.');
  }
  if (!data) throw new Error('The ' + label + ' service sent back something unreadable — try again in a moment.');
  return data;
}

// ---------------------------------------------------------------- auto-caption (transcribe_audio)

/**
 * Listen to an uploaded song with Gemini and return timed caption lines:
 * { ok: true, lines: [{ startSeconds, text }, …] }, times strictly ascending.
 *
 * Two modes:
 *   · knownLyrics provided (song loaded from My songs / lyrics pasted): the
 *     model only has to find WHEN each given line is sung — the words are
 *     taken as gospel. This is the high-accuracy path.
 *   · no knownLyrics (raw upload): the model transcribes the words too.
 *
 * Bad model output gets one retry with a blunt format reminder; if that also
 * fails the app shows a plain-English error and points at tap-sync instead.
 * Always uses Gemini (the only configured provider that listens to audio),
 * regardless of the provider picked in the app's Settings.
 */
function handleTranscribeAudio(data) {
  var audioBase64 = String(data.audioBase64 || '');
  if (!audioBase64) throw new Error('No audio arrived — load the song’s audio and try Auto-caption again.');
  if (audioBase64.length > TRANSCRIBE_MAX_BASE64) {
    throw new Error('That audio file is too big to send for auto-captioning — the limit is about 13 MB, and a 3-minute MP3 is only around 4 MB. Try an MP3 version of the song (WAV files are much bigger), or tap the timings yourself with Sync lyrics.');
  }
  var key = getApiKey('gemini');
  if (!key) throw new Error('Auto-caption needs a Gemini key — in the Apps Script editor open Project Settings → Script properties and add GEMINI_API_KEY.');

  var mimeType = normalizeAudioMime(String(data.mimeType || ''));
  var knownLyrics = knownLyricsLines(data.knownLyrics);
  var settings = readSettings();
  var model = settings.models.gemini || DEFAULT_MODELS.gemini;
  var prompt = transcribePrompt(knownLyrics);

  var raw = callGeminiAudio(key, model, prompt, audioBase64, mimeType);
  var lines = parseTranscription(raw, knownLyrics);
  if (!lines) {
    // One retry with a blunt reminder — same one-shot style the app's other
    // parse-the-AI's-JSON flows use.
    var reminder = '\n\nREMINDER — YOUR PREVIOUS REPLY WAS NOT USABLE. Reply with ONLY a JSON array of objects like {"startSeconds": 12.4, "text": "one lyric line"}. startSeconds values MUST increase from one element to the next. No code fences, no commentary, no other fields, nothing before or after the array.'
      + (knownLyrics.length ? ' The array MUST contain exactly ' + knownLyrics.length + ' elements — one per given lyric line, in the same order, with each "text" copied exactly.' : '');
    raw = callGeminiAudio(key, model, prompt + reminder, audioBase64, mimeType);
    lines = parseTranscription(raw, knownLyrics);
  }
  if (!lines) {
    throw new Error('The AI couldn’t produce usable timings for this song — that happens sometimes with music. Try Auto-caption once more, or tap the timings yourself with Sync lyrics.');
  }
  if (!lines.length) {
    throw new Error('The AI couldn’t hear any sung words in this audio. If the song definitely has vocals, try Auto-caption again — otherwise tap the timings yourself with Sync lyrics.');
  }
  return { ok: true, lines: lines };
}

// The app sends caption lines joined with newlines; normalize into an array.
function knownLyricsLines(v) {
  return String(v || '').split('\n').map(function (s) { return s.trim(); }).filter(String);
}

// Gemini's audio API is picky about MIME names (audio/mpeg → audio/mp3).
function normalizeAudioMime(m) {
  m = String(m || '').toLowerCase().split(';')[0].trim();
  if (m === 'audio/mpeg' || m === 'audio/mp3' || m === '') return 'audio/mp3';
  if (m === 'audio/x-wav' || m === 'audio/wave' || m === 'audio/wav') return 'audio/wav';
  if (m === 'audio/aac' || m === 'audio/ogg' || m === 'audio/flac' || m === 'audio/aiff') return m;
  return 'audio/mp3';
}

function transcribePrompt(knownLyrics) {
  var head = [
    'You are a precise song transcription and alignment engine. Listen to the attached audio from the very beginning.',
    '',
    'Reply with ONLY a JSON array — no markdown fences, no commentary before or after. Each element is one caption line:',
    '  { "startSeconds": 12.4, "text": "one lyric line" }',
    '',
    'Rules:',
    '- "startSeconds" is when that line STARTS being sung, in seconds from the very start of the audio, with one decimal place.',
    '- startSeconds values MUST increase from one element to the next.',
    '- Lyrics only: no section names like "Verse" or "Chorus", no speaker labels, no descriptions of instruments or sounds.',
  ];
  if (knownLyrics.length) {
    return head.concat([
      '',
      'THE EXACT LYRICS ARE PROVIDED BELOW — one caption line per line, already in order. Do NOT transcribe, rewrite, merge, split, or skip anything. Your ONLY job is to find when each given line is sung.',
      'The array MUST contain exactly ' + knownLyrics.length + ' elements — one per given line, in the same order, with each "text" copied EXACTLY as written below.',
      'If a line repeats in the song, its element marks that line\'s position in THIS list (earlier list lines are sung earlier).',
      '',
      'LYRICS:',
      knownLyrics.join('\n'),
    ]).join('\n');
  }
  return head.concat([
    '- Break the lyrics into natural caption-sized lines — one sung phrase per line, as a lyric video would show them.',
    '- Skip pure instrumental passages. If the whole song has no sung words, reply [].',
  ]).join('\n');
}

// Same shape as callGemini, plus the audio riding along as inline data. Asking
// for application/json makes Gemini skip the chit-chat and code fences.
function callGeminiAudio(key, model, prompt, audioBase64, mimeType) {
  var payload = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: audioBase64 } },
    ] }],
    generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' },
  };
  var data = geminiGenerate(key, model, payload);
  var cand = data.candidates && data.candidates[0];
  var parts = ((cand && cand.content && cand.content.parts) || []).map(function (p) { return p.text || ''; }).filter(String);
  if (!parts.length) throw new Error('Gemini sent back an empty answer — try Auto-caption again in a moment.');
  return parts.join('\n');
}

// Is this Gemini error the temporary "try again in a moment" kind? The free
// tier constantly answers 503 "this model is experiencing high demand", 429
// (rate limit), or 500 (a transient hiccup) — every one of those clears on its
// own within a second or two, so they're worth a short pause and a retry. A bad
// key or a malformed request is NOT transient and must not be retried.
function isTransientGeminiError(msg) {
  msg = String(msg || '');
  return /\((429|500|503)\)/.test(msg)
    || /high demand|overloaded|unavailable|temporarily|try again|rate limit|resource[_ ]?exhausted/i.test(msg);
}

// One Gemini generateContent call, made resilient so Auto-caption's cloud backup
// actually lands instead of dying on the first hiccup (the old version gave up
// the moment Gemini said "503 high demand", which is why cloud captioning
// "never worked"). Three kinds of trouble, handled three ways:
//   · temporary overload / rate-limit (503 "high demand", 429, 500): wait and
//     retry the SAME model with a growing pause (1s, then 2s); if it stays
//     jammed, move on to the next fallback model rather than fail;
//   · a 404 "unknown / no-longer-available model": walk down
//     GEMINI_MODEL_FALLBACKS to a model that still exists;
//   · anything else (bad key, malformed request): real — throw it straight away.
// A total call budget keeps the slow audio path comfortably inside Apps
// Script's 6-minute execution limit even if everything is having a bad day.
function geminiGenerate(key, model, payload) {
  var names = [model].concat(GEMINI_MODEL_FALLBACKS);
  var tried = {};
  var lastErr = null;
  var calls = 0;
  var MAX_CALLS = 5; // safety cap on total network calls (audio calls are slow)
  for (var i = 0; i < names.length && calls < MAX_CALLS; i++) {
    var m = names[i];
    if (!m || tried[m]) continue;
    tried[m] = true;
    for (var attempt = 0; attempt < 3 && calls < MAX_CALLS; attempt++) {
      calls++;
      try {
        return aiFetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':generateContent', {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': key },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        }, 'Gemini');
      } catch (err) {
        var msg = String((err && err.message) || '');
        lastErr = err;
        if (isTransientGeminiError(msg)) {
          if (attempt < 2 && calls < MAX_CALLS) { Utilities.sleep(1000 * Math.pow(2, attempt)); continue; }
          break; // this model keeps overloading — try the next fallback model
        }
        if (msg.indexOf('(404)') !== -1 && /model/i.test(msg)) break; // retired model — next fallback
        throw err; // bad key / malformed request — real, don't paper over it
      }
    }
  }
  throw lastErr;
}

/**
 * Defensive parse of the model's reply. Returns a clean array of
 * { startSeconds, text } with strictly ascending times, or null when the
 * reply is unusable (which triggers the one-shot retry, then the error).
 * With knownLyrics, the element count must match the given line count so the
 * app can trust the one-to-one line mapping.
 */
function parseTranscription(raw, knownLyrics) {
  var text = String(raw || '').trim();
  // Strip ```json fences and anything outside the outermost [ … ].
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  var start = text.indexOf('[');
  var end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  var arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
  if (!Array.isArray(arr) || arr.length > 500) return null;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var el = arr[i];
    if (!el || typeof el !== 'object') return null;
    var t = Number(el.startSeconds);
    if (typeof el.text !== 'string' && typeof el.text !== 'number') return null;
    var line = String(el.text).replace(/\s+/g, ' ').trim();
    if (!isFinite(t) || t < 0 || !line) return null;
    out.push({ startSeconds: Math.round(t * 10) / 10, text: line.slice(0, 200) });
  }
  // Times must never go backwards; ties (two lines rounded to the same tenth)
  // get nudged forward so the result is strictly ascending. The backwards
  // check compares against the time the AI actually sent (prevRaw), not the
  // nudged value — otherwise three lines stamped 10.0/10.0/10.0 (a legal
  // non-decreasing reply) would be rejected once the second one is nudged.
  var prevRaw = out.length ? out[0].startSeconds : 0;
  for (var k = 1; k < out.length; k++) {
    var raw = out[k].startSeconds;
    if (raw < prevRaw) return null;
    if (out[k].startSeconds <= out[k - 1].startSeconds) out[k].startSeconds = Math.round((out[k - 1].startSeconds + 0.1) * 10) / 10;
    prevRaw = raw;
  }
  if (knownLyrics.length && out.length !== knownLyrics.length) return null;
  return out;
}

// ---------------------------------------------------------------- songs (My Songs tab)

function handleSaveOriginal(data) {
  var sheet = getOrCreateSheet(SONGS_SHEET_NAME, SONGS_HEADERS);
  var cols = headerColumns(sheet, SONGS_HEADERS);
  var id = nextId('MS', sheet, cols['Song ID']);
  var row = newRowFor(sheet);
  row[cols['Song ID']] = id;
  row[cols['Date Created']] = todayString();
  row[cols['Title']] = String(data.title || '');
  row[cols['Style / Genre']] = String(data.style || '');
  row[cols['My Request (Prompt)']] = String(data.prompt || '');
  row[cols['Lyrics']] = String(data.lyrics || '');
  row[cols['Status']] = String(data.status || 'Draft');
  sheet.appendRow(row);
  return { ok: true, id: id };
}

function handleListOriginals() {
  var sheet = getOrCreateSheet(SONGS_SHEET_NAME, SONGS_HEADERS);
  var cols = headerColumns(sheet, SONGS_HEADERS);
  var songs = dataRows(sheet).map(function (r) {
    return {
      id: cellString(r[cols['Song ID']]),
      date: cellString(r[cols['Date Created']]),
      title: cellString(r[cols['Title']]),
      style: cellString(r[cols['Style / Genre']]),
      prompt: cellString(r[cols['My Request (Prompt)']]),
      lyrics: cellString(r[cols['Lyrics']]),
      status: cellString(r[cols['Status']]),
      sunoLink: cellString(r[cols['Suno Link']]),
      notes: cellString(r[cols['Notes']]),
    };
  }).filter(function (s) { return s.id || s.title || s.lyrics; });
  return { ok: true, songs: songs };
}

function handleUpdateOriginal(data) {
  var sheet = getOrCreateSheet(SONGS_SHEET_NAME, SONGS_HEADERS);
  var cols = headerColumns(sheet, SONGS_HEADERS);
  var rowIndex = findRowById(sheet, cols['Song ID'], data.id);
  if (rowIndex === -1) throw new Error('Couldn’t find that song in the sheet — refresh My songs and try again.');
  if (data.title !== undefined) sheet.getRange(rowIndex, cols['Title'] + 1).setValue(String(data.title || ''));
  if (data.style !== undefined) sheet.getRange(rowIndex, cols['Style / Genre'] + 1).setValue(String(data.style || ''));
  if (data.lyrics !== undefined) sheet.getRange(rowIndex, cols['Lyrics'] + 1).setValue(String(data.lyrics || ''));
  if (data.status !== undefined) sheet.getRange(rowIndex, cols['Status'] + 1).setValue(String(data.status || ''));
  return { ok: true };
}

function handleDeleteOriginal(data) {
  var sheet = getOrCreateSheet(SONGS_SHEET_NAME, SONGS_HEADERS);
  var cols = headerColumns(sheet, SONGS_HEADERS);
  var rowIndex = findRowById(sheet, cols['Song ID'], data.id);
  if (rowIndex === -1) throw new Error('Couldn’t find that song in the sheet — refresh My songs and try again.');
  sheet.deleteRow(rowIndex);
  return { ok: true };
}

// ---------------------------------------------------------------- videos (Drive + Videos tab)

function handleSaveVideo(data) {
  var base64 = String(data.videoBase64 || '');
  if (!base64) throw new Error('No video data arrived — export the video again, then save.');

  var bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (err) {
    throw new Error('The video data arrived garbled — export the video again, then save.');
  }
  if (!bytes || !bytes.length) throw new Error('The video data arrived empty — export the video again, then save.');

  var mimeType = String(data.mimeType || 'video/webm');
  var title = String(data.title || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'My Song';
  var fileName = title + ' - Lyric Video' + (mimeType.indexOf('webm') !== -1 ? '.webm' : (mimeType.indexOf('mp4') !== -1 ? '.mp4' : ''));

  var folder = getOrCreateVideosFolder();
  var file = folder.createFile(Utilities.newBlob(bytes, mimeType, fileName));
  var driveLink = file.getUrl();

  var sheet = getOrCreateSheet(VIDEOS_SHEET_NAME, VIDEOS_HEADERS);
  var cols = headerColumns(sheet, VIDEOS_HEADERS);
  var id = nextId('VID', sheet, cols['Video ID']);
  var row = newRowFor(sheet);
  row[cols['Video ID']] = id;
  row[cols['Song ID']] = String(data.songId || '');
  row[cols['Date Created']] = todayString();
  row[cols['Caption Style']] = String(data.captionStyle || '');
  row[cols['Drive Link']] = driveLink;
  row[cols['YouTube Link']] = String(data.youtubeLink || '');
  row[cols['Notes']] = String(data.notes || '');
  row[cols['Title']] = String(data.title || '');
  sheet.appendRow(row);

  return { ok: true, id: id, driveLink: driveLink };
}

function handleListVideos() {
  var sheet = getOrCreateSheet(VIDEOS_SHEET_NAME, VIDEOS_HEADERS);
  var cols = headerColumns(sheet, VIDEOS_HEADERS);
  var videos = dataRows(sheet).map(function (r) {
    return {
      id: cellString(r[cols['Video ID']]),
      songId: cellString(r[cols['Song ID']]),
      date: cellString(r[cols['Date Created']]),
      captionStyle: cellString(r[cols['Caption Style']]),
      driveLink: cellString(r[cols['Drive Link']]),
      youtubeLink: cellString(r[cols['YouTube Link']]),
      notes: cellString(r[cols['Notes']]),
      title: cellString(r[cols['Title']]),
    };
  }).filter(function (v) { return v.id || v.driveLink; });
  return { ok: true, videos: videos };
}

function getOrCreateVideosFolder() {
  // getFoldersByName also returns folders sitting in the trash — if the owner
  // deleted "Tune Studio Videos", saving into that match would file videos in
  // the trash (gone for good once it empties). Skip trashed matches.
  var it = DriveApp.getFoldersByName(VIDEOS_FOLDER_NAME);
  while (it.hasNext()) {
    var folder = it.next();
    if (!folder.isTrashed()) return folder;
  }
  return DriveApp.createFolder(VIDEOS_FOLDER_NAME);
}

// ---------------------------------------------------------------- IDs

/**
 * Collision-proof IDs (MS-005, VID-001, …). A counter in Script properties
 * only ever moves forward, so a deleted row's ID is never handed out again —
 * unlike the old row-count scheme. On first use the counter seeds itself from
 * the highest ID already in the sheet, so every existing ID keeps working.
 * Callers already hold the script lock, which makes read+increment atomic.
 */
function nextId(prefix, sheet, idColumn) {
  var props = PropertiesService.getScriptProperties();
  var propKey = 'NEXT_ID_' + prefix;
  var next = parseInt(props.getProperty(propKey), 10);
  if (!(next >= 1)) next = 1;
  var re = new RegExp('^' + prefix + '-(\\d+)$');
  dataRows(sheet).forEach(function (r) {
    var m = re.exec(cellString(r[idColumn]));
    if (m) {
      var n = parseInt(m[1], 10) + 1;
      if (n > next) next = n;
    }
  });
  props.setProperty(propKey, String(next + 1));
  var num = String(next);
  while (num.length < 3) num = '0' + num;
  return prefix + '-' + num;
}

// ---------------------------------------------------------------- sheet helpers

function getSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) ss = SpreadsheetApp.openById(getProp('SHEET_ID') || FALLBACK_SPREADSHEET_ID);
  return ss;
}

// Find the tab, creating it (with bold, frozen headers) if it doesn't exist.
// An existing tab that's missing some expected headers gets them appended, so
// older layouts upgrade themselves without touching existing data.
function getOrCreateSheet(name, headers) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  var lastCol = Math.max(1, sheet.getLastColumn());
  var have = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return normalizeHeader(h); });
  if (!have.some(String)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  var missing = headers.filter(function (h) { return have.indexOf(normalizeHeader(h)) === -1; });
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sheet;
}

// Map each expected header to its 0-based column, by name, so the code keeps
// working even if columns get reordered in the sheet.
function headerColumns(sheet, headers) {
  var lastCol = Math.max(1, sheet.getLastColumn());
  var row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return normalizeHeader(h); });
  var cols = {};
  headers.forEach(function (h, fallbackIdx) {
    var at = row1.indexOf(normalizeHeader(h));
    cols[h] = at !== -1 ? at : fallbackIdx;
  });
  return cols;
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function dataRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, Math.max(1, sheet.getLastColumn())).getValues();
}

function findRowById(sheet, idColumn, id) {
  var want = String(id || '');
  if (!want) return -1;
  var rows = dataRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (cellString(rows[i][idColumn]) === want) return i + 2; // +2: 1-based + header row
  }
  return -1;
}

function newRowFor(sheet) {
  var row = [];
  for (var i = 0; i < Math.max(1, sheet.getLastColumn()); i++) row.push('');
  return row;
}

function cellString(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}

function todayString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ---------------------------------------------------------------- plumbing

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getProp(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

// Keys can live in Script properties under a few common names; the Settings
// sheet tab is also checked (a row like "Anthropic API Key") as a fallback.
function getApiKey(provider) {
  var names = PROVIDER_KEY_NAMES[provider] || [];
  for (var i = 0; i < names.length; i++) {
    var v = getProp(names[i]);
    if (v) return v;
  }
  var settings = readSettings();
  return settings.keys[provider] || '';
}

function normalizeProvider(p) {
  var id = String(p || '').toLowerCase();
  if (id === 'anthropic') id = 'claude';
  if (id === 'chatgpt') id = 'openai';
  if (!PROVIDER_LABELS[id]) id = 'claude';
  return id;
}

// Read the "Settings" sheet tab: Provider, per-provider models, Web Research,
// and any API keys someone put there instead of Script properties.
function readSettings() {
  var out = { provider: 'claude', models: {}, keys: {}, webResearch: false };
  var sheet;
  try {
    sheet = getSpreadsheet().getSheetByName('Settings');
  } catch (e) {
    return out;
  }
  if (!sheet || sheet.getLastRow() < 2) return out;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  rows.forEach(function (r) {
    var name = normalizeHeader(r[0]);
    var value = String(r[1] === null || r[1] === undefined ? '' : r[1]).trim();
    if (!name || !value) return;
    if (name === 'provider') out.provider = normalizeProvider(value);
    else if (name === 'anthropicmodel' || name === 'claudemodel') out.models.claude = value;
    else if (name === 'openaimodel' || name === 'chatgptmodel') out.models.openai = value;
    else if (name === 'geminimodel') out.models.gemini = value;
    else if (name === 'grokmodel') out.models.grok = value;
    else if (name === 'deepseekmodel') out.models.deepseek = value;
    else if (name === 'webresearch') out.webResearch = /^(on|yes|true|1)$/i.test(value);
    else if (name === 'anthropicapikey' || name === 'claudeapikey') out.keys.claude = value;
    else if (name === 'openaiapikey' || name === 'chatgptapikey') out.keys.openai = value;
    else if (name === 'geminiapikey') out.keys.gemini = value;
    else if (name === 'grokapikey' || name === 'xaiapikey') out.keys.grok = value;
    else if (name === 'deepseekapikey') out.keys.deepseek = value;
  });
  return out;
}

function jsonReply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- self-test

/**
 * Run this once from the Apps Script editor (pick TEST_backend in the toolbar,
 * press Run) right after pasting new code. It grants the new Drive permission
 * and checks everything without changing any of your songs. Read the result in
 * the Execution log.
 */
function TEST_backend() {
  var report = [];
  var ss = getSpreadsheet();
  report.push('Spreadsheet: found "' + ss.getName() + '" ✓');

  var songs = getOrCreateSheet(SONGS_SHEET_NAME, SONGS_HEADERS);
  report.push('"' + SONGS_SHEET_NAME + '" tab: ' + (songs.getLastRow() - 1) + ' songs ✓');

  var videos = getOrCreateSheet(VIDEOS_SHEET_NAME, VIDEOS_HEADERS);
  report.push('"' + VIDEOS_SHEET_NAME + '" tab: ready (' + Math.max(0, videos.getLastRow() - 1) + ' videos logged) ✓');

  var folder = getOrCreateVideosFolder();
  report.push('Drive folder "' + VIDEOS_FOLDER_NAME + '": ready ✓ (' + folder.getUrl() + ')');

  var status = handleStatus(getProp('AI_TOKEN'));
  var ready = [];
  for (var id in status.providers) if (status.providers[id]) ready.push(PROVIDER_LABELS[id]);
  report.push('AI providers with a key: ' + (ready.join(', ') || 'none — add API keys in Project Settings → Script properties'));
  report.push('Auto-caption (needs the Gemini key): ' + (status.providers.gemini ? 'ready ✓' : 'NOT ready — add GEMINI_API_KEY in Project Settings → Script properties'));
  report.push('Access token (AI_TOKEN): ' + (status.tokenRequired ? 'required' : 'not set (optional)'));

  Logger.log('\n' + report.join('\n'));
  return report.join('\n');
}
