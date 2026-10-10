const endpoint='https://streamlet.info/account/v1/auth/device_code_request.php';
const baseId=`web-probe-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
const tests=[
  {name:'form_device_id',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','User-Agent':'Dart/3.9 (dart:io)'},body:new URLSearchParams({device_id:`${baseId}-a`})},
  {name:'form_deviceId',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','User-Agent':'Dart/3.9 (dart:io)'},body:new URLSearchParams({deviceId:`${baseId}-b`})},
  {name:'json_device_id',headers:{'Accept':'application/json','Content-Type':'application/json','User-Agent':'Dart/3.9 (dart:io)'},body:JSON.stringify({device_id:`${baseId}-c`})},
  {name:'json_deviceId',headers:{'Accept':'application/json','Content-Type':'application/json','User-Agent':'Dart/3.9 (dart:io)'},body:JSON.stringify({deviceId:`${baseId}-d`})},
  {name:'json_mobile_headers',headers:{'Accept':'application/json','Content-Type':'application/json','User-Agent':'Streamlet/1.1.0 (iPhone; iOS)','Origin':'https://streamlet.info','Referer':'https://streamlet.info/account/'},body:JSON.stringify({device_id:`${baseId}-e`})}
];
for(const t of tests){
  try{
    const r=await fetch(endpoint,{method:'POST',headers:t.headers,body:t.body,redirect:'manual',signal:AbortSignal.timeout(12000)});
    const text=await r.text(); let data={}; try{data=JSON.parse(text)}catch{}
    const keys=data&&typeof data==='object'?Object.keys(data).filter(k=>!['user_code','access_token','token'].includes(k)):[];
    const type=r.headers.get('content-type')||'';
    const server=r.headers.get('server')||'';
    const safeError=(!r.ok&&data&&typeof data==='object')?String(data.error||data.message||data.code||'').slice(0,120):'';
    console.log(`[AccountProbe] ${t.name} status=${r.status} ok=${r.ok} type=${type} server=${server} keys=${keys.join(',')} error=${safeError}`);
  }catch(e){ console.log(`[AccountProbe] ${t.name} error=${e?.name||'Error'} message=${e?.message||'unknown'}`); }
}
