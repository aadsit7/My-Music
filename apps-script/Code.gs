/**
 * Tune Studio — Google Apps Script backend
 * =========================================
 * This one file is the whole backend. It receives POST requests from the
 * Tune Studio web app and:
 *   · answers AI requests (song search, songwriting) via the provider picked
 *     in the app's Settings tab,
 *   · saves / lists / updates / deletes songs in the "My Songs" sheet tab,
 *   · saves exported lyric videos to the "Tune Studio Videos" Drive folder
 *     and logs them in the "Videos" sheet tab.
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

// Model used when the Settings tab has no row for a provider.
var DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
  grok: 'grok-4',
  deepseek: 'deepseek-chat',
};

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
  var text = callAI(provider, prompt);
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
  var data = aiFetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  }, 'Gemini');
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
  var fileName = title + ' - Lyric Video' + (mimeType.indexOf('webm') !== -1 ? '.webm' : '');

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
  var it = DriveApp.getFoldersByName(VIDEOS_FOLDER_NAME);
  if (it.hasNext()) return it.next();
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
  report.push('Access token (AI_TOKEN): ' + (status.tokenRequired ? 'required' : 'not set (optional)'));

  Logger.log('\n' + report.join('\n'));
  return report.join('\n');
}
