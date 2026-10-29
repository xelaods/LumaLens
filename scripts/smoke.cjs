const {spawn}=require('node:child_process');
const path=require('node:path');
const profile=path.join(__dirname,'..','..',`smoke-${Date.now()}`);
const env={...process.env,LUMALENS_SMOKE:'1',LUMALENS_TEST_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(process.env.LUMALENS_EXECUTABLE||require('electron'),process.env.LUMALENS_EXECUTABLE?[]:['.'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'pipe'});
child.stdout.on('data',d=>process.stdout.write(d));child.stderr.on('data',d=>process.stderr.write(d));
const timeout=setTimeout(()=>{console.error('Smoke test timed out.');child.kill();},150000);
child.on('error',e=>{console.error(e);clearTimeout(timeout);process.exitCode=1;});child.on('exit',code=>{clearTimeout(timeout);process.exitCode=code===0?0:1;});

