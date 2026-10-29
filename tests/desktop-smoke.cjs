'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async ({main,root}) => {
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;res.setHeader('Content-Type','application/json');
    if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'smoke-model'}]}));
    const request=JSON.parse(body);const input=JSON.parse(request.messages[1].content);
    res.end(JSON.stringify({message:{content:JSON.stringify({translations:input.regions.map(r=>({id:r.id,text:'おかえり。物語の続きを読もう。'}))})}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  console.log('SMOKE: mock provider listening');
  try {
    const endpoint=`http://127.0.0.1:${server.address().port}`;
    const result=await main.webContents.executeJavaScript(`(async()=>{
      const boot=await window.luma.bootstrap();
      if(!document.querySelector('#startButton'))throw new Error('Missing studio controls');
      const saved=await window.luma.saveSettings({...boot.settings,endpoint:${JSON.stringify(endpoint)},model:'smoke-model',provider:'ollama',source:'en',confidence:20});
      const models=await window.luma.models();
      const test=await window.luma.testProvider();
      const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=400;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,400);ctx.fillStyle='black';ctx.font='64px Arial';ctx.fillText('Welcome home.',80,170);ctx.fillText('Read the next story.',80,270);
      const frame={image:canvas.toDataURL('image/png'),width:1200,height:400,region:{x:0,y:0,width:1,height:1},isImage:true};
      const translated=await window.luma.processFrame(frame);
      state.settings=saved;state.history=[translated];state.image=true;state.result=translated;state.region=null;
      await new Promise((resolve,reject)=>{const img=document.getElementById('stillImage');img.onload=resolve;img.onerror=reject;img.src=frame.image;});
      document.getElementById('stillImage').hidden=false;document.getElementById('emptyState').hidden=true;document.getElementById('sourceLabel').textContent='OCR INTEGRATION CHECK';
      showView('studio');paintSettings();renderResults(translated);renderPreview();
      const copied=translated.regions.map(r=>r.translation).join(' ');await window.luma.copy(copied);
      const sources=await window.luma.sources();const screenSource=sources.find(s=>s.kind==='screen');let capture=null;
      if(screenSource){try{await window.luma.selectSource(screenSource.id);const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});capture=stream.getVideoTracks()[0].getSettings();stream.getTracks().forEach(t=>t.stop());}catch(error){capture={error:error.name+': '+error.message,sourceId:screenSource.id};}}
      const after=await window.luma.bootstrap();
      return {title:document.title,models,test,ocr:translated.regions.map(r=>r.text).join(' '),translation:copied,history:after.history.length,sources:sources.length,capture,settings:saved.model};
    })()`, true);
    console.log('SMOKE: pipeline',JSON.stringify(result));
    assert.equal(result.title,'LumaLens'); assert.ok(result.models.includes('smoke-model')); assert.match(result.ocr,/Welcome home/i); assert.match(result.translation,/おかえり/);assert.ok(result.history>0);assert.ok(result.sources>0);
    await main.webContents.executeJavaScript(`window.luma.updateOverlay(state.result)`);
    const {BrowserWindow}=require('electron');
    const overlay=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='LumaLens Overlay');
    assert.ok(overlay?.isVisible(),'Desktop overlay is visible');
    assert.match(await overlay.webContents.executeJavaScript(`document.body.textContent`),/おかえり/);
    await main.webContents.executeJavaScript(`window.luma.hideOverlay()`);
    const regionPromise=main.webContents.executeJavaScript(`window.luma.selectRegion()`);
    let selector;
    for(let i=0;i<30;i++){selector=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='翻訳範囲を選択');if(selector?.isVisible())break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(selector?.isVisible(),'Region selector is visible');
    await selector.webContents.executeJavaScript(`window.regionSelector.done({x:.1,y:.2,width:.5,height:.4})`);
    assert.deepEqual(await regionPromise,{x:.1,y:.2,width:.5,height:.4});
    await new Promise(r=>setTimeout(r,300));
    console.log('SMOKE: geometry',await main.webContents.executeJavaScript(`JSON.stringify({media:mediaGeometry(),img:document.getElementById('stillImage').getBoundingClientRect().toJSON(),viewer:document.getElementById('mediaArea').getBoundingClientRect().toJSON()})`));
    const screenshot=await main.webContents.capturePage();await fs.writeFile(path.join(root,'..','desktop-smoke.png'),screenshot.toPNG());
    assert.ok(result.capture?.width>0,JSON.stringify(result.capture));
    console.log('LUMALENS_SMOKE_OK',JSON.stringify(result));
  } finally {await new Promise(resolve=>server.close(resolve));}
};
