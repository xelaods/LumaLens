'use strict';
const {test,after,before} = require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {DEFAULTS}=require('../lib/core.cjs');
const provider=require('../lib/provider.cjs');
let server,endpoint,seen=[];
before(async()=>{server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;seen.push({url:req.url,body:raw?JSON.parse(raw):null,auth:req.headers.authorization});res.setHeader('Content-Type','application/json');
  if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'test-local'}]}));
  if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'test-api'}]}));
  if(req.url==='/error/chat/completions'){res.statusCode=401;return res.end('{}');}
  const content=JSON.stringify({translations:[{id:'0',text:'おかえり。'}]});res.end(JSON.stringify(req.url==='/api/chat'?{message:{content}}:{choices:[{message:{content}}]}));
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));endpoint=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(resolve=>server.close(resolve)));
test('Ollama performs real HTTP calls with JSON format, no streaming, and parses results',async()=>{
  const settings={...DEFAULTS,endpoint,model:'test-local'};
  assert.deepEqual(await provider.models(settings,''),['test-local']);
  const result=await provider.translate([{id:'0',text:'Welcome home.'}],settings,'',[],new AbortController().signal);
  assert.equal(result[0].translation,'おかえり。');assert.equal(seen.at(-1).body.stream,false);assert.equal(seen.at(-1).body.format,'json');
});
test('compatible provider sends API authorization and uses configured base path',async()=>{
  const settings={...DEFAULTS,provider:'compatible',endpoint:endpoint+'/v1',model:'test-api'};
  assert.deepEqual(await provider.models(settings,'test-secret'),['test-api']);
  const result=await provider.translate([{id:'0',text:'Welcome home.'}],settings,'test-secret',[],new AbortController().signal);
  assert.equal(result[0].translation,'おかえり。');assert.equal(seen.at(-1).auth,'Bearer test-secret');assert.equal(seen.at(-1).url,'/v1/chat/completions');
});
test('API authentication errors are actionable and do not leak response secrets',async()=>{
  await assert.rejects(provider.translate([{id:'0',text:'hello'}],{...DEFAULTS,provider:'compatible',endpoint:endpoint+'/error',model:'test'},'',[],new AbortController().signal),/APIキー/);
});
test('cancelled requests fail immediately',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(provider.translate([{id:'0',text:'hello'}],{...DEFAULTS,endpoint,model:'test'},'',[],controller.signal),{name:'AbortError'});
});
