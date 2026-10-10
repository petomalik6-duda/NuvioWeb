const deviceId=`web-probe-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
try {
  const r=await fetch('https://streamlet.info/account/v1/auth/device_code_request.php',{
    method:'POST',
    headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','User-Agent':'StreamletWeb-Probe/1.1'},
    body:new URLSearchParams({device_id:deviceId}),
    signal:AbortSignal.timeout(15000)
  });
  const text=await r.text();
  let data={}; try{data=JSON.parse(text)}catch{}
  const keys=data&&typeof data==='object'?Object.keys(data).filter(k=>!['user_code','access_token','token'].includes(k)):[];
  console.log(`[AccountProbe] status=${r.status} ok=${r.ok} keys=${keys.join(',')}`);
} catch (e) {
  console.log(`[AccountProbe] error=${e?.name||'Error'} message=${e?.message||'unknown'}`);
}
