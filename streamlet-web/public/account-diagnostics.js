(()=>{
  const rawFetch=window.fetch.bind(window);
  const clean=s=>String(s||'').toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,64);
  const report=tag=>{
    const safe=clean(tag);
    if(!safe)return;
    rawFetch(`/api/account/diag/${safe}`,{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{});
  };
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input&&input.url)||'';
    let kind='';
    if(url.includes('/api/account/device-code/request')) kind='proxy-request';
    else if(url.includes('/api/account/device-code/exchange')) kind='proxy-exchange';
    else if(url.includes('streamlet.info/account/v1/auth/device_code_request.php')) kind='direct-request';
    else if(url.includes('streamlet.info/account/v1/auth/device_code_exchange.php')) kind='direct-exchange';
    if(!kind) return rawFetch(input,init);
    try{
      const response=await rawFetch(input,init);
      report(`${kind}-http-${response.status}`);
      return response;
    }catch(error){
      report(`${kind}-${error&&error.name==='TypeError'?'network':'error'}`);
      throw error;
    }
  };
})();
