const box = document.getElementById('selection'); let start;
document.addEventListener('pointerdown', e => { if(e.button !== 0) return; start = {x:e.clientX,y:e.clientY}; document.body.setPointerCapture(e.pointerId); box.hidden = false; });
document.addEventListener('pointermove', e => { if(!start)return; Object.assign(box.style,{left:Math.min(start.x,e.clientX)+'px',top:Math.min(start.y,e.clientY)+'px',width:Math.abs(e.clientX-start.x)+'px',height:Math.abs(e.clientY-start.y)+'px'}); });
document.addEventListener('pointerup', e => { if(!start)return; const x=Math.min(start.x,e.clientX),y=Math.min(start.y,e.clientY),width=Math.abs(start.x-e.clientX),height=Math.abs(start.y-e.clientY); start=null;if(width<12||height<12){box.hidden=true;return;}window.regionSelector.done({x:x/innerWidth,y:y/innerHeight,width:width/innerWidth,height:height/innerHeight}); });
document.addEventListener('keydown', e => { if(e.key==='Escape')window.regionSelector.done(null); });
