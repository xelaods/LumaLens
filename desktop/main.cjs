'use strict';
// GUI apps may outlive the terminal or launcher that created their output pipes.
for (const output of [process.stdout, process.stderr]) output.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') { /* No terminal is required for the desktop app. */ } });
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, globalShortcut, safeStorage, dialog, clipboard, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createWorker, PSM } = require('tesseract.js');
const { DEFAULTS, LANGUAGES, sanitizeSettings, extractRegions, toSrt } = require('../lib/core.cjs');
const provider = require('../lib/provider.cjs');
let main, overlay, selector, selectedSource, worker, workerLanguage, activeRequest, activeJob = false;
let settings = { ...DEFAULTS }, encryptedKey = '', history = [], lastOverlay = null, selectorResolve;
const root = path.join(__dirname, '..');
if (process.env.LUMALENS_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.LUMALENS_TEST_PROFILE));
let configPath, historyPath, cachePath;
let writeQueue = Promise.resolve();
const translationCache = new Map();
function enqueue(fn) { const next = writeQueue.then(fn, fn); writeQueue = next.catch(() => {}); return next; }
async function atomicJson(file, data) { await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(file + '.tmp', file); }
const emit = (name, value) => { if (main && !main.isDestroyed()) main.webContents.send(name, value); };
function preferences(preload) { return { preload: path.join(__dirname, preload), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false }; }
function protect(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.setContentProtection(true);
}
function sendSettings() { return { ...settings, hasKey: !!encryptedKey, keyStorageAvailable: safeStorage.isEncryptionAvailable(), languages: LANGUAGES }; }
function key() {
  if (!encryptedKey) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windowsの暗号化機能が利用できません。');
  return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
}
function register(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== main?.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error('アクセスが拒否されました。');
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.name === 'AbortError' || error.name === 'TimeoutError' ? '処理を中断したか、接続がタイムアウトしました。' : error.message || '処理に失敗しました。' }; }
  });
}
async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 180 }, fetchWindowIcons: true });
  const excluded = [main, overlay, selector].filter(w => w && !w.isDestroyed()).map(w => w.getMediaSourceId());
  return sources.filter(s => !excluded.includes(s.id)).map(s => ({ id: s.id, name: s.name, displayId: s.display_id, thumbnail: s.thumbnail.toDataURL(), kind: s.id.startsWith('screen:') ? 'screen' : 'window' }));
}
function displayForSource() {
  return screen.getAllDisplays().find(d => String(d.id) === selectedSource?.displayId) || screen.getPrimaryDisplay();
}
async function makeOverlay() {
  if (overlay && !overlay.isDestroyed()) return;
  overlay = new BrowserWindow({ ...displayForSource().bounds, transparent: true, frame: false, resizable: false, movable: false, skipTaskbar: true, focusable: false, show: false, hasShadow: false, webPreferences: preferences('overlay-preload.cjs') });
  overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.setIgnoreMouseEvents(true); protect(overlay);
  await overlay.loadFile(path.join(root, 'ui/overlay.html'));
}
function closeSelector(value = null) { const resolve = selectorResolve; selectorResolve = null; if (selector && !selector.isDestroyed()) selector.close(); selector = null; resolve?.(value); }
async function selectRegion() {
  if (selectedSource?.kind !== 'screen') throw new Error('画面上の範囲選択にはディスプレイを選んでください。ウィンドウはプレビュー内で範囲を指定できます。');
  closeSelector();
  if (overlay && !overlay.isDestroyed()) overlay.hide();
  const bounds = displayForSource().bounds;
  selector = new BrowserWindow({ ...bounds, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, show: false, alwaysOnTop: true, webPreferences: preferences('selector-preload.cjs') });
  protect(selector); selector.setAlwaysOnTop(true, 'screen-saver');
  const pending = new Promise(resolve => { selectorResolve = resolve; });
  selector.on('closed', () => { selector = null; const resolve = selectorResolve; selectorResolve = null; resolve?.(null); });
  await selector.loadFile(path.join(root, 'ui/selector.html'));
  selector.show(); selector.focus();
  return pending;
}
async function getWorker(source, style) {
  const language = LANGUAGES[source]?.ocr || 'eng';
  if (!worker || workerLanguage !== language) {
    if (worker) await worker.terminate();
    worker = null; workerLanguage = '';
    emit('progress', { stage: 'ocr', message: '文字認識エンジンを準備中。初回は言語データを取得します…' });
    worker = await createWorker(language, 1, { cachePath, logger: m => emit('ocr-progress', { status: m.status, progress: m.progress }), errorHandler: () => {} });
    workerLanguage = language;
  }
  await worker.setParameters({ tessedit_pageseg_mode: source === 'ja-vertical' ? PSM.SINGLE_BLOCK_VERT_TEXT : style === 'manga' ? PSM.SPARSE_TEXT : PSM.AUTO, preserve_interword_spaces: '1' });
  return worker;
}
function validateFrame(frame) {
  if (!frame || typeof frame.image !== 'string' || frame.image.length > 24000000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(frame.image)) throw new Error('画像が不正、または大きすぎます。');
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) throw new Error('画像サイズが不正です。');
  const r = frame.region;
  if (!r || !['x','y','width','height'].every(k => Number.isFinite(r[k])) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.001 || r.y + r.height > 1.001) throw new Error('範囲が不正です。');
}
function cancel() { activeRequest?.abort(); }
async function processFrame(frame) {
  validateFrame(frame);
  if (activeJob) throw new Error('前の翻訳が完了するまでお待ちください。');
  activeJob = true;
  const controller = new AbortController(); activeRequest = controller;
  const start = Date.now(); const snapshot = { ...settings };
  try {
    const ocr = await getWorker(snapshot.source, snapshot.style);
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    emit('progress', { stage: 'ocr', message: '画面の文字を読み取っています…' });
    const { data } = await ocr.recognize(Buffer.from(frame.image.split(',')[1], 'base64'), {}, { blocks: true, text: true });
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const regions = extractRegions(data, frame.width, frame.height, snapshot);
    if (!regions.length) return { regions: [], message: '文字が見つかりません。範囲・認識言語・しきい値を調整してください。', duration: Date.now() - start };
    emit('progress', { stage: 'translation', message: `${regions.length}件のテキストを翻訳しています…` });
    const cacheKey = JSON.stringify([snapshot.provider,snapshot.endpoint,snapshot.model,snapshot.source,snapshot.target,snapshot.style,snapshot.preserveTone,snapshot.glossary,snapshot.context,regions.map(r=>r.text)]);
    const cached = translationCache.get(cacheKey);
    let translated;
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) translated = regions.map((r,i)=>({...r,translation:cached.texts[i]}));
    else {
      translated = await provider.translate(regions, snapshot, key(), history.slice(0, 3).reverse().map(h => h.regions.map(r => r.text).join('\n')), controller.signal);
      translationCache.set(cacheKey,{at:Date.now(),texts:translated.map(r=>r.translation)});
      if(translationCache.size>200)translationCache.delete(translationCache.keys().next().value);
    }
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const result = { id: require('node:crypto').randomUUID(), at: Date.now(), regions: translated, style: snapshot.style, source: snapshot.source, target: snapshot.target, duration: Date.now() - start, region: frame.region, sourceName: selectedSource?.name || 'Image', isImage: !!frame.isImage };
    const previous=history[0];
    if (snapshot.historyEnabled && !(cached && previous?.source===result.source && previous?.target===result.target && previous?.style===result.style && previous?.regions.map(r=>r.text).join('\n')===regions.map(r=>r.text).join('\n'))) { history.unshift(result); history = history.slice(0, 300); await enqueue(() => atomicJson(historyPath, history)); }
    else if (snapshot.historyEnabled && cached && previous) result.id=previous.id;
    return result;
  } finally { activeJob = false; if (activeRequest === controller) activeRequest = null; }
}
function registerHandlers() {
  register('bootstrap', () => ({ settings: sendSettings(), history, version: app.getVersion() }));
  register('settings:save', async input => {
    const next = sanitizeSettings(input);
    let nextKey = encryptedKey;
    if (input.clearKey === true) nextKey = '';
    else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windowsの暗号化機能が利用できないためキーを保存できません。');
      nextKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
    }
    await enqueue(() => atomicJson(configPath, { settings: next, encryptedKey: nextKey }));
    if (encryptedKey !== nextKey) translationCache.clear();
    settings = next; encryptedKey = nextKey; return sendSettings();
  });
  register('provider:models', () => provider.models(settings, key()));
  register('provider:test', async () => {
    const regions = [{ id: '0', text: 'Welcome home.', confidence: 100, box: { x: 0, y: 0, width: 1, height: 1 } }];
    const controller = new AbortController();
    const result = await provider.translate(regions, settings, key(), [], controller.signal);
    return result[0].translation;
  });
  register('sources:list', listSources);
  register('sources:select', async id => {
    const sources = await listSources(); const source = sources.find(s => s.id === id);
    if (!source) throw new Error('選択した画面が見つかりません。再選択してください。');
    selectedSource = source; lastOverlay = null;
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    return source;
  });
  register('region:select', selectRegion);
  register('frame:process', processFrame);
  register('frame:cancel', cancel);
  register('overlay:update', async result => {
    if (!selectedSource || selectedSource.kind !== 'screen') throw new Error('オーバーレイはディスプレイのキャプチャで利用できます。');
    if (!result || !Array.isArray(result.regions) || result.regions.length > 80) throw new Error('字幕データが不正です。');
    await makeOverlay(); overlay.setBounds(displayForSource().bounds);
    lastOverlay = { result, settings: { fontSize: settings.fontSize, opacity: settings.opacity, style: settings.style, coverOriginal: settings.coverOriginal, showOriginal: settings.showOriginal, overlayMode: settings.overlayMode } };
    overlay.webContents.send('overlay:data', lastOverlay); overlay.showInactive(); return true;
  });
  register('overlay:hide', () => { lastOverlay = null; if (overlay && !overlay.isDestroyed()) overlay.hide(); });
  register('window:minimize', () => main.minimize());
  register('clipboard:write', text => { if (typeof text !== 'string' || text.length > 1000000) throw new Error('コピーするテキストが不正です。'); clipboard.writeText(text); });
  register('history:clear', async () => { history = []; await enqueue(() => atomicJson(historyPath, history)); });
  register('history:export', async format => {
    if (!['json', 'txt', 'srt'].includes(format)) throw new Error('形式が不正です。');
    const { filePath, canceled } = await dialog.showSaveDialog(main, { defaultPath: `LumaLens-${new Date().toISOString().slice(0,10)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (canceled) return null;
    const text = format === 'json' ? JSON.stringify(history, null, 2) : format === 'srt' ? toSrt(history) : [...history].reverse().map(h => `${new Date(h.at).toLocaleString()}\n${h.regions.map(r => `${r.text}\n→ ${r.translation}`).join('\n\n')}`).join('\n\n---\n\n');
    await fs.writeFile(filePath, text, 'utf8'); return filePath;
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); } });
  app.whenReady().then(async () => {
    configPath = path.join(app.getPath('userData'), 'settings.json'); historyPath = path.join(app.getPath('userData'), 'history.json'); cachePath = path.join(app.getPath('userData'), 'ocr-cache');
    await fs.mkdir(cachePath, { recursive: true });
    try { const saved = JSON.parse(await fs.readFile(configPath, 'utf8')); settings = sanitizeSettings(saved.settings); encryptedKey = saved.encryptedKey || ''; } catch {}
    try { const saved = JSON.parse(await fs.readFile(historyPath, 'utf8')); if (Array.isArray(saved)) history = saved.filter(h => Array.isArray(h.regions)).slice(0,300); } catch {}
    Menu.setApplicationMenu(null);
    main = new BrowserWindow({ width: 1440, height: 920, minWidth: 1050, minHeight: 720, backgroundColor: '#101211', title: 'LumaLens', icon: path.join(root,'assets/icon.png'), show: false, autoHideMenuBar: true, webPreferences: preferences('preload.cjs') });
    protect(main); registerHandlers();
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(wc === main?.webContents && permission === 'display-capture'));
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (request.frame !== main.webContents.mainFrame || !selectedSource) return callback({});
        const sources = await desktopCapturer.getSources({ types: [selectedSource.kind], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find(s => s.id === selectedSource.id); callback(source ? { video: source } : {});
      } catch { callback({}); }
    });
    ipcMain.on('selector:done', (event, rect) => {
      if (event.sender !== selector?.webContents) return;
      if (rect !== null && (!rect || !['x','y','width','height'].every(k => Number.isFinite(rect[k])) || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1.001 || rect.y + rect.height > 1.001)) return;
      closeSelector(rect);
    });
    globalShortcut.register('CommandOrControl+Shift+L', () => emit('shortcut', 'toggle'));
    globalShortcut.register('CommandOrControl+Shift+R', () => emit('shortcut', 'region'));
    globalShortcut.register('CommandOrControl+Shift+O', () => { if (!overlay || overlay.isDestroyed()) return; if (overlay.isVisible()) overlay.hide(); else if (lastOverlay) overlay.showInactive(); });
    globalShortcut.register('CommandOrControl+Shift+H', () => { if (main.isMinimized()) main.restore(); main.show(); main.focus(); });
    main.on('closed', () => { cancel(); closeSelector(); if (overlay && !overlay.isDestroyed()) overlay.close(); app.quit(); });
    await main.loadFile(path.join(root, 'ui/index.html')); main.show();
    if (process.env.LUMALENS_SMOKE === '1') {
      try { await require('../tests/desktop-smoke.cjs')({main,root,emit}); app.exit(0); }
      catch (error) { console.error('LUMALENS_SMOKE_FAILED', error?.stack || String(error)); app.exit(1); }
    }
  }).catch(error => { dialog.showErrorBox('LumaLens', error.message); app.quit(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); cancel(); worker?.terminate(); });
  app.on('window-all-closed', () => app.quit());
}
