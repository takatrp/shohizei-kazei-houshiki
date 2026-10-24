(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root.document){
    const start=()=>api.init(root.document);
    if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start,{once:true});
    else start();
  }
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function init(doc){
    const open=doc.getElementById('manualVideoOpen'),dialog=doc.getElementById('manualVideoDialog'),close=doc.getElementById('manualVideoClose'),video=doc.getElementById('manualVideo');
    if(!open||!dialog||!close||!video||open.dataset.videoBound==='true')return;
    open.dataset.videoBound='true';
    open.addEventListener('click',()=>{if(!dialog.open)dialog.showModal();});
    close.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{video.pause();open.focus({preventScroll:true});});
  }
  return {init};
});
