'use strict';
const $ = id => document.getElementById(id);
const api = window.luma;
const state = { settings: {}, history: [], source: null, stream: null, image: false, mode: 'live', region: null, running: false, busy: false, generation: 0, result: null, hash: null, timer: null, selecting: false };
let toastTimer, saveTimer;
function toast(message, error = false) { $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 10000 : 4500); }
function status(text, live = false) { $('headerStatus').textContent = text; $('statusDot').classList.toggle('live', live); $('footerStatus').textContent = `● ${text}`; }
function showView(view) { for (const v of ['studio','history','settings']) $(v+'View').hidden = v !== view; document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === view)); if(view === 'history') renderHistory(); }
function catchUi(fn) { return async (...args) => { try { await fn(...args); } catch(e) { toast(e.message, true); } }; }
function selectOption(select, value) { select.value = String(value); if (select.value !== String(value)) { const o = document.createElement('option'); o.value = String(value); o.textContent = String(value); select.append(o); select.value = String(value); } }
function populateLanguages(languages) {
  for (const [code, info] of Object.entries(languages)) {
    const option = document.createElement('option'); option.value = code; option.textContent = info.label; $('sourceLanguage').append(option);
    if (!['auto','ja-vertical'].includes(code)) $('targetLanguage').append(option.cloneNode(true));
  }
}
function paintSettings() {
  const s = state.settings;
  for (const id of ['provider','endpoint','model','context','glossary','fontSize','opacity','interval','preprocess','readingOrder','confidence','overlayMode']) {
    if ($(id).tagName === 'SELECT') selectOption($(id),s[id]); else $(id).value = s[id];
  }
  $('sourceLanguage').value = s.source; $('targetLanguage').value = s.target;
  for (const id of ['showOriginal','preserveTone','coverOriginal','historyEnabled']) $(id).checked = s[id];
  $('fontSizeValue').textContent = `${s.fontSize} px`; $('opacityValue').textContent = `${s.opacity}%`; $('confidenceValue').textContent = `${s.confidence}%`;
  $('keyState').textContent = s.hasKey ? '暗号化して保存済み' : '未設定';
  $('engineName').textContent = s.provider === 'ollama' ? 'Ollama · Local' : 'Compatible API'; $('modelName').textContent = s.model || 'モデル未設定';
  $('verticalHint').hidden = s.source !== 'ja-vertical';
  const descriptions = {cinema:'余韻を残す、短く自然な字幕へ。',manga:'口調・感情・擬音を活かす、漫画の台詞へ。',minimal:'すっきりと読みやすい自然な訳文へ。',literal:'細部と用語を大切に、原文に忠実な翻訳へ。'};
  $('styleDescription').textContent = descriptions[s.style];
  document.querySelectorAll('#styleButtons button').forEach(b => b.classList.toggle('selected', b.dataset.style === s.style));
  updateProviderHint(); renderPreview();
}
function updateProviderHint() { $('providerHint').textContent = $('provider').value === 'ollama' ? 'Ollamaを起動し、翻訳に使うモデルをインストールしてください。モデル一覧から選択できます。' : 'Chat Completions互換の接続先を指定してください。例：https://api.openai.com/v1。JSON出力対応のモデルが必要です。'; }
async function saveFullSettings() {
  if (state.busy) throw new Error('翻訳を停止し、処理が終了してから接続設定を保存してください。');
  const input = {...state.settings};
  for (const id of ['provider','endpoint','model','context','glossary']) input[id] = $(id).value;
  input.apiKey = $('apiKey').value; input.clearKey = $('clearKey').checked; input.historyEnabled = $('historyEnabled').checked;
  state.settings = await api.saveSettings(input); $('apiKey').value = ''; $('clearKey').checked = false; state.hash = null; paintSettings();
}
async function quickSave(key, value) {
  clearTimeout(saveTimer);
  state.settings[key] = value; state.hash = null; renderPreview();
  // Save the complete snapshot so rapid changes don't overwrite each other.
  saveTimer = setTimeout(catchUi(async () => { const saved = await api.saveSettings({...state.settings}); state.settings.hasKey = saved.hasKey; await syncOverlay(); }), 250);
}
function styleChange(style) { quickSave('style',style); document.querySelectorAll('#styleButtons button').forEach(b=>b.classList.toggle('selected',b.dataset.style===style)); $('styleDescription').textContent = {cinema:'余韻を残す、短く自然な字幕へ。',manga:'口調・感情・擬音を活かす、漫画の台詞へ。',minimal:'すっきりと読みやすい自然な訳文へ。',literal:'細部と用語を大切に、原文に忠実な翻訳へ。'}[style]; }
function stop() {
  state.running = false; state.generation++; clearTimeout(state.timer); state.timer = null;
  if(state.busy) api.cancel().catch(()=>{});
  $('startButton').textContent = '▶ 翻訳を開始'; document.body.classList.remove('busy'); status('STANDBY');
}
function releaseStream() { if(state.stream) state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; $('video').srcObject=null; }
async function chooseSources() {
  stop(); $('sourceDialog').showModal(); $('sourceError').textContent=''; $('sourceList').textContent='キャプチャ元を取得しています…';
  try {
    const sources = await api.sources(); $('sourceList').replaceChildren();
    if(!sources.length) $('sourceList').textContent='画面が見つかりません。Windowsの画面共有設定を確認してください。';
    for(const source of sources) {
      const button = document.createElement('button');button.className='source-card';
      const img=document.createElement('img');img.src=source.thumbnail;img.alt='';
      const title=document.createElement('b');title.textContent=source.name;
      const kind=document.createElement('small');kind.textContent=source.kind==='screen'?'DISPLAY · OVERLAY AVAILABLE':'WINDOW';
      button.append(img,title,kind);button.addEventListener('click',catchUi(async()=>{ button.disabled=true;try{await connectSource(source);$('sourceDialog').close();}finally{button.disabled=false;} }));$('sourceList').append(button);
    }
  } catch(e){$('sourceList').replaceChildren();$('sourceError').textContent=e.message;}
}
async function connectSource(source) {
  stop(); releaseStream(); await api.hideOverlay();
  const selected = await api.selectSource(source.id);
  const stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:12,max:15}},audio:false});
  state.source=selected;state.stream=stream;state.image=false;state.region=null;state.hash=null;state.result=null;
  $('video').srcObject=stream;await $('video').play();
  $('video').hidden=false;$('stillImage').hidden=true;$('emptyState').hidden=true;$('sourceLabel').textContent=selected.name.toUpperCase();$('sourceButton').textContent=selected.name+' ⌄';
  $('frameInfo').textContent=`${$('video').videoWidth} × ${$('video').videoHeight} / LIVE SOURCE`;
  $('overlayEnabled').disabled=selected.kind!=='screen'; if(selected.kind!=='screen')$('overlayEnabled').checked=false;
  stream.getVideoTracks()[0].addEventListener('ended',()=>{if(state.stream===stream){stop();releaseStream();state.source=null;$('video').hidden=true;$('emptyState').hidden=false;api.hideOverlay().catch(()=>{});toast('キャプチャが終了しました。画面を再選択してください。');}});
  updateRegionBox();renderPreview();toast('キャプチャ元を接続しました。');
}
async function openImage(file) {
  if(!file)return;
  if(file.size>25*1024*1024)throw new Error('画像は25MB以下にしてください。');
  const url=URL.createObjectURL(file);const img=$('stillImage');
  try { await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('画像を開けませんでした。PNG・JPEG・WebP・BMPを使用してください。'));img.src=url;}); }
  finally { URL.revokeObjectURL(url); }
  stop();releaseStream();await api.hideOverlay();state.source=null;state.image=true;state.region=null;state.hash=null;state.result=null;
  img.hidden=false;$('video').hidden=true;$('emptyState').hidden=true;$('sourceLabel').textContent=file.name;$('sourceButton').textContent='画面を選択 ⌄';$('frameInfo').textContent=`${img.naturalWidth} × ${img.naturalHeight} / STILL IMAGE`;
  $('overlayEnabled').checked=false;$('overlayEnabled').disabled=true;setMode('frame');updateRegionBox();renderPreview();
}
function setMode(mode) {stop();state.mode=mode;state.hash=null;document.querySelectorAll('#modeButtons button').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));if(mode==='region'&&!state.region){toast('「範囲を指定」から翻訳したい場所を選んでください。');}}
function mediaGeometry() {
  const element=state.image?$('stillImage'):$('video');const width=state.image?element.naturalWidth:element.videoWidth,height=state.image?element.naturalHeight:element.videoHeight;
  const rect=$('mediaArea').getBoundingClientRect(); const scale=Math.min(rect.width/width,rect.height/height);
  return {width,height,displayWidth:width*scale,displayHeight:height*scale,left:(rect.width-width*scale)/2,top:(rect.height-height*scale)/2,rect,element};
}
function updateRegionBox() {
  const box=$('regionBox');$('resetRegion').hidden=!state.region;box.hidden=!state.region;
  if(!state.region)return;const g=mediaGeometry(),r=state.region;
  Object.assign(box.style,{left:`${g.left+r.x*g.displayWidth}px`,top:`${g.top+r.y*g.displayHeight}px`,width:`${r.width*g.displayWidth}px`,height:`${r.height*g.displayHeight}px`});
}
function renderPreview() {
  const container=$('previewOverlay');if(!state.result){container.replaceChildren();return;}
  const g=mediaGeometry();Object.assign(container.style,{left:g.left+'px',top:g.top+'px',width:g.displayWidth+'px',height:g.displayHeight+'px'});
  window.renderSubtitles(container,state.result,{...state.settings,fontSize:Math.max(12,state.settings.fontSize*.7)});
}
function beginPreviewRegion() {
  if(!state.stream&&!state.image){toast('先に画面または画像を選択してください。');return;}
  stop();state.selecting=true;$('dragLayer').hidden=false;toast('プレビュー内をドラッグして範囲を指定。Escでキャンセル。');
}
async function beginNativeRegion() {
  if(!state.source||state.source.kind!=='screen'){beginPreviewRegion();return;}
  stop();const region=await api.selectRegion();if(region){state.region=region;state.hash=null;updateRegionBox();toast('翻訳範囲を設定しました。');}
}
function setupDrag() {
  const layer=$('dragLayer');let start;
  const point=e=>{const g=mediaGeometry();return{x:Math.max(0,Math.min(1,(e.clientX-g.rect.left-g.left)/g.displayWidth)),y:Math.max(0,Math.min(1,(e.clientY-g.rect.top-g.top)/g.displayHeight))};};
  layer.addEventListener('pointerdown',e=>{if(e.button!==0)return;start=point(e);layer.setPointerCapture(e.pointerId);});
  layer.addEventListener('pointermove',e=>{if(!start)return;const end=point(e);state.region={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};updateRegionBox();});
  layer.addEventListener('pointerup',e=>{if(!start)return;const end=point(e);state.region={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};start=null;state.selecting=false;layer.hidden=true;if(state.region.width<.01||state.region.height<.01)state.region=null;state.hash=null;updateRegionBox();toast(state.region?'翻訳範囲を設定しました。':'範囲が小さすぎます。再選択してください。');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.selecting){state.selecting=false;start=null;layer.hidden=true;state.region=null;updateRegionBox();}});
}
function captureFrame() {
  const g=mediaGeometry();if(!g.width||!g.height)throw new Error('画面の準備ができていません。キャプチャ元を再選択してください。');
  const r=state.region||{x:0,y:0,width:1,height:1};const sourceWidth=Math.max(1,Math.round(g.width*r.width)),sourceHeight=Math.max(1,Math.round(g.height*r.height));
  const scale=Math.min(2,4096/sourceWidth,4096/sourceHeight,Math.sqrt(4000000/(sourceWidth*sourceHeight)));
  const canvas=$('previewCanvas');canvas.width=Math.max(1,Math.round(sourceWidth*scale));canvas.height=Math.max(1,Math.round(sourceHeight*scale));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.filter=state.settings.preprocess==='contrast'?'grayscale(1) contrast(1.8)':state.settings.preprocess==='invert'?'grayscale(1) invert(1)':'none';
  ctx.drawImage(g.element,Math.round(g.width*r.x),Math.round(g.height*r.y),sourceWidth,sourceHeight,0,0,canvas.width,canvas.height);
  const tiny=document.createElement('canvas');tiny.width=96;tiny.height=54;const tx=tiny.getContext('2d',{willReadFrequently:true});tx.drawImage(canvas,0,0,96,54);
  const pixels=tx.getImageData(0,0,96,54).data;let hash=2166136261;for(let i=0;i<pixels.length;i+=4){hash^=(pixels[i]>>4)*16+(pixels[i+1]>>4);hash=Math.imul(hash,16777619);} 
  return {image:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height,region:r,isImage:state.image,hash};
}
function renderResults(result) {
  $('results').replaceChildren();
  if(!result.regions.length){const p=document.createElement('p');p.className='muted';p.textContent=result.message||'文字が見つかりませんでした。';$('results').append(p);return;}
  result.regions.forEach((r,i)=>{const row=document.createElement('div');row.className='transcript';const n=document.createElement('span');n.className='number';n.textContent=String(i+1).padStart(2,'0');const body=document.createElement('div');const original=document.createElement('p');original.className='original';original.textContent=r.text;const translated=document.createElement('p');translated.textContent=r.translation;const confidence=document.createElement('span');confidence.className='confidence';confidence.textContent=`OCR ${r.confidence}%`;body.append(original,translated,confidence);row.append(n,body);$('results').append(row);});
}
async function syncOverlay() {
  if($('overlayEnabled').checked&&state.result?.regions.length&&!state.image&&state.source?.kind==='screen')await api.updateOverlay(state.result);else await api.hideOverlay();
}
async function runFrame(force=false) {
  if(state.busy||state.selecting)return;
  const generation=state.generation;state.busy=true;document.body.classList.add('busy');
  let frame;
  try {
    frame=captureFrame();
    if(!force&&state.hash===frame.hash){status('WATCHING FOR CHANGES',true);return;}
    status('RECOGNIZING',true);$('recognitionInfo').textContent='文字を読み取っています…';
    const result=await api.processFrame(frame);
    if(generation!==state.generation)return;
    state.hash=frame.hash;state.result=result;renderResults(result);renderPreview();
    $('processingTime').textContent=`${(result.duration/1000).toFixed(1)} SEC`;
    $('recognitionInfo').textContent=result.regions.length?`${result.regions.length} REGIONS · TRANSLATED`:'NO TEXT DETECTED';
    if(result.id&&state.settings.historyEnabled&&!state.history.some(h=>h.id===result.id)){state.history.unshift(result);state.history=state.history.slice(0,300);}
    await syncOverlay();status(state.running?'WATCHING FOR CHANGES':'TRANSLATED',state.running);
  } catch(e) {
    if(generation===state.generation){state.hash=null;stop();toast(e.message,true);$('recognitionInfo').textContent='翻訳できませんでした。設定と接続を確認してください。';status('NEEDS ATTENTION');}
  } finally {
    state.busy=false;document.body.classList.remove('busy');
    if(state.running&&generation===state.generation)state.timer=setTimeout(()=>runFrame(),state.settings.interval);
  }
}
async function startTranslation(force=false) {
  if(state.running||state.busy){stop();return;}
  if(!state.stream&&!state.image){await chooseSources();return;}
  if(!state.settings.model){showView('settings');toast('翻訳に使うモデルを設定してください。');return;}
  if(state.mode==='region'&&!state.region){beginPreviewRegion();return;}
  clearTimeout(saveTimer);state.settings=await api.saveSettings({...state.settings});
  state.generation++;state.hash=null;state.running=state.mode!=='frame'&&!state.image;
  $('startButton').textContent=state.running?'■ 翻訳を停止':'処理を中断';await runFrame(force);
  if(!state.running)$('startButton').textContent='▶ 翻訳を開始';
}
function renderHistory() {
  const needle=$('historySearch').value.toLowerCase();const list=$('historyList');list.replaceChildren();
  const items=state.history.filter(h=>h.regions.some(r=>(r.text+' '+r.translation).toLowerCase().includes(needle)));
  if(!items.length){const empty=document.createElement('div');empty.className='history-empty';empty.textContent=needle?'一致する翻訳がありません。':'翻訳履歴はまだありません。\n最初の物語を翻訳してみましょう。';list.append(empty);return;}
  for(const item of items){const card=document.createElement('article');card.className='history-card';const meta=document.createElement('div');meta.className='history-meta';const info=document.createElement('span');info.textContent=`${new Date(item.at).toLocaleString('ja-JP')} · ${item.style.toUpperCase()} · ${item.source} → ${item.target}`;const copy=document.createElement('button');copy.className='text-button';copy.textContent='コピー';copy.addEventListener('click',catchUi(async()=>{await api.copy(item.regions.map(r=>r.translation).join('\n'));toast('コピーしました。');}));meta.append(info,copy);card.append(meta);for(const r of item.regions){const original=document.createElement('p');original.className='original';original.textContent=r.text;const translated=document.createElement('p');translated.textContent=r.translation;card.append(original,translated);}list.append(card);}
}
async function init() {
  if(!api){$('headerStatus').textContent='DESKTOP APP REQUIRED';toast('これはWindowsアプリの画面です。インストーラー、または npm start で起動してください。',true);return;}
  const boot=await api.bootstrap();state.settings=boot.settings;state.history=boot.history;$('version').textContent=`v${boot.version}`;populateLanguages(boot.settings.languages);paintSettings();setupDrag();
  document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  for(const id of ['openSettings','engineSettings'])$(id).addEventListener('click',()=>showView('settings'));
  for(const id of ['sourceButton','emptySource'])$(id).addEventListener('click',catchUi(chooseSources));
  for(const id of ['helpButton','shortcutsButton'])$(id).addEventListener('click',()=>$('helpDialog').showModal());
  document.querySelectorAll('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $('imageButton').addEventListener('click',()=>$('imageInput').click());$('imageInput').addEventListener('change',catchUi(async()=>{await openImage($('imageInput').files[0]);$('imageInput').value='';}));
  document.querySelectorAll('#modeButtons button').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  document.querySelectorAll('#styleButtons button').forEach(b=>b.addEventListener('click',()=>styleChange(b.dataset.style)));
  $('startButton').addEventListener('click',catchUi(()=>startTranslation()));
  $('retryButton').addEventListener('click',catchUi(async()=>{if(state.busy){toast('処理中です。停止してから再試行してください。');return;}await startTranslation(true);}));
  $('regionButton').addEventListener('click',beginPreviewRegion);
  $('resetRegion').addEventListener('click',()=>{stop();state.region=null;state.hash=null;updateRegionBox();});
  $('overlayEnabled').addEventListener('change',catchUi(syncOverlay));$('minimizeButton').addEventListener('click',catchUi(()=>api.minimize()));
  $('copyButton').addEventListener('click',catchUi(async()=>{if(!state.result?.regions.length){toast('翻訳結果がありません。');return;}await api.copy(state.result.regions.map(r=>r.translation).join('\n'));toast('訳文をコピーしました。');}));
  for(const id of ['fontSize','opacity','confidence'])$(id).addEventListener('input',()=>{const value=Number($(id).value);$(id+'Value').textContent=`${value}${id==='fontSize'?' px':'%'}`;quickSave(id,value);});
  for(const id of ['showOriginal','preserveTone','coverOriginal'])$(id).addEventListener('change',()=>quickSave(id,$(id).checked));
  for(const id of ['interval','preprocess','readingOrder','overlayMode'])$(id).addEventListener('change',()=>quickSave(id,id==='interval'?Number($(id).value):$(id).value));
  $('sourceLanguage').addEventListener('change',()=>{quickSave('source',$('sourceLanguage').value);$('verticalHint').hidden=$('sourceLanguage').value!=='ja-vertical';});$('targetLanguage').addEventListener('change',()=>quickSave('target',$('targetLanguage').value));
  $('swapLanguages').addEventListener('click',()=>{const source=state.settings.source==='ja-vertical'?'ja':state.settings.source;if(source==='auto'){toast('自動判定では言語を入れ替えられません。');return;}const target=state.settings.target;state.settings.source=target;state.settings.target=source;quickSave('source',target);paintSettings();});
  $('provider').addEventListener('change',()=>{if($('provider').value==='ollama')$('endpoint').value='http://127.0.0.1:11434';else if($('endpoint').value.includes('11434'))$('endpoint').value='https://api.openai.com/v1';$('model').value='';updateProviderHint();});
  $('saveSettings').addEventListener('click',catchUi(async()=>{await saveFullSettings();toast('設定を保存しました。');}));
  $('loadModels').addEventListener('click',catchUi(async()=>{const b=$('loadModels');b.disabled=true;$('connectionResult').textContent='接続しています…';$('connectionResult').classList.remove('error');try{await saveFullSettings();const models=await api.models();$('modelList').replaceChildren();for(const name of models){const o=document.createElement('option');o.value=name;$('modelList').append(o);}if(!state.settings.model&&models.length){$('model').value=models[0];await saveFullSettings();}$('connectionResult').textContent=models.length?`${models.length}個のモデルを取得しました。モデル名の欄から選択できます。`:'モデルが見つかりません。Ollamaなら先にモデルをインストールしてください。';}catch(e){$('connectionResult').textContent=e.message;$('connectionResult').classList.add('error');}finally{b.disabled=false;}}));
  $('testConnection').addEventListener('click',catchUi(async()=>{const b=$('testConnection');b.disabled=true;$('connectionResult').textContent='「Welcome home.」を試訳しています…';$('connectionResult').classList.remove('error');try{await saveFullSettings();const result=await api.testProvider();$('connectionResult').textContent=`接続できました。\nWelcome home. → ${result}`;}catch(e){$('connectionResult').textContent=e.message;$('connectionResult').classList.add('error');}finally{b.disabled=false;}}));
  $('historySearch').addEventListener('input',renderHistory);
  $('exportButton').addEventListener('click',catchUi(async()=>{if(!state.history.length){toast('書き出す履歴がありません。');return;}const file=await api.exportHistory($('exportFormat').value);if(file)toast(`書き出しました：${file}`);}));
  $('clearHistory').addEventListener('click',catchUi(async()=>{if(!confirm('端末内の翻訳履歴をすべて削除しますか？'))return;await api.clearHistory();state.history=[];renderHistory();toast('履歴を削除しました。');}));
  api.onProgress(p=>{if(!state.busy)return;$('recognitionInfo').textContent=p.message;status(p.stage==='translation'?'TRANSLATING':'RECOGNIZING',true);});
  api.onOcrProgress(p=>{if(state.busy&&p.status?.includes('loading'))$('recognitionInfo').textContent=`文字認識データを準備中… ${Math.round((p.progress||0)*100)}%`;});
  api.onShortcut(catchUi(async action=>{if(action==='toggle')await startTranslation();if(action==='region')await beginNativeRegion();}));
  new ResizeObserver(()=>{updateRegionBox();renderPreview();}).observe($('mediaArea'));
  window.addEventListener('beforeunload',()=>{stop();releaseStream();});
  if(!state.settings.model){setTimeout(()=>{showView('settings');toast('まず翻訳サービスとモデルを設定してください。');},300);}
}
init().catch(e=>toast(e.message,true));
