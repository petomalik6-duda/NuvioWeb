const targets=[['playlists','https://repo.streamlet.info/playlists.json'],['epg','https://repo.streamlet.info/epg.json']];
for (const [name,url] of targets){
  try{
    const r=await fetch(url,{headers:{'User-Agent':'Streamlet/1.1.0','Accept':'application/json'},signal:AbortSignal.timeout(20000)});
    const text=await r.text();
    console.log(`[IPTVRepo] ${name} status=${r.status} type=${r.headers.get('content-type')||''} bytes=${text.length}`);
    if(r.ok){
      console.log(`[IPTVRepo:${name}:BEGIN]`);
      console.log(text.slice(0,50000));
      console.log(`[IPTVRepo:${name}:END]`);
    }
  }catch(e){console.log(`[IPTVRepo] ${name} error=${e?.name||'Error'} ${e?.message||''}`)}
}
