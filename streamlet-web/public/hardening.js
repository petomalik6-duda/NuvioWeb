const ACCOUNT_URL='https://streamlet.info/account';
const ACCOUNT_API='https://streamlet.info/account/v1/auth';
const DEVICE_KEY='streamlet.account.device_id.v1';
let pollTimer=null;
let pollDeadline=0;
let loginTransport='proxy';

function deviceId(){
  let id=localStorage.getItem(DEVICE_KEY);
  if(!id){ id=(crypto.randomUUID?.()||`web-${Date.now()}-${Math.random().toString(36).slice(2)}`); localStorage.setItem(DEVICE_KEY,id); }
  return id;
}
async function accountApi(path,options={}){
  const r=await fetch(path,{credentials:'same-origin',...options});
  let data={}; try{data=await r.json()}catch{}
  if(!r.ok){ const err=new Error(data.error||data.message||`HTTP ${r.status}`); err.status=r.status; err.data=data; throw err; }
  return data;
}
async function officialPost(script,fields){
  const r=await fetch(`${ACCOUNT_API}/${script}`,{
    method:'POST', mode:'cors', credentials:'include',
    headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','Accept':'application/json'},
    body:new URLSearchParams(fields)
  });
  const text=await r.text(); let data={}; try{data=JSON.parse(text)}catch{}
  if(!r.ok){ const err=new Error(data.error||data.message||`HTTP ${r.status}`); err.status=r.status; err.data=data; throw err; }
  return data;
}
function extractToken(data){ return data?.access_token||data?.token||data?.data?.access_token||data?.data?.token||''; }
async function handoffToken(token){
  await accountApi('/api/account/session/import',{method:'POST',headers:{'Content-Type':'application/json','X-Streamlet-Web':'device-code'},body:JSON.stringify({accessToken:token})});
}
function accountPanel(){ const form=document.querySelector('#loginForm'); if(!form)return null; return form.closest('.panel'); }
function signedOutHtml(){
  return `<h2>Streamlet Account</h2>
  <p class="muted">Prihlásenie rovnakým device-code postupom ako v Streamlet iOS. Heslo sa neposiela cez túto web aplikáciu.</p>
  <button class="btn" id="deviceLoginBtn">Prihlásiť kódom</button>
  <div id="deviceLoginState" class="section"></div>`;
}
function signedInHtml(){
  return `<h2>Streamlet Account</h2><div class="setting-row"><span>Stav</span><b>Prihlásené</b></div>
  <p class="muted">Účet je prihlásený cez zabezpečenú HttpOnly session.</p>
  <button class="btn secondary" id="logoutBtn">Odhlásiť</button>`;
}
async function renderAccount(){
  const panel=accountPanel(); if(!panel)return;
  try{
    const session=await accountApi('/api/account/session');
    panel.innerHTML=session.signedIn?signedInHtml():signedOutHtml();
  }catch{ panel.innerHTML=signedOutHtml(); }
  document.querySelector('#deviceLoginBtn')?.addEventListener('click',startDeviceLogin);
  document.querySelector('#logoutBtn')?.addEventListener('click',logoutAccount);
}
function showState(html){ const el=document.querySelector('#deviceLoginState'); if(el) el.innerHTML=html; }
async function requestDeviceCode(){
  const id=deviceId();
  try{
    loginTransport='proxy';
    return await accountApi('/api/account/device-code/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:id})});
  }catch(err){
    if(err.status!==403) throw err;
    loginTransport='direct';
    return await officialPost('device_code_request.php',{device_id:id});
  }
}
async function startDeviceLogin(){
  clearInterval(pollTimer); pollTimer=null;
  const btn=document.querySelector('#deviceLoginBtn'); if(btn){btn.disabled=true;btn.textContent='Generujem kód…';}
  try{
    const data=await requestDeviceCode();
    const code=data.user_code||data.code||data.userCode;
    if(!code) throw new Error(data.message||'Server nevrátil prihlasovací kód');
    const expires=Math.max(60,Number(data.expires_in||data.expiresIn||600));
    pollDeadline=Date.now()+expires*1000;
    showState(`<div class="panel" style="margin-top:14px"><div class="small muted">Na prihlásenom zariadení zadaj tento kód:</div><div style="font-size:32px;font-weight:800;letter-spacing:4px;margin:12px 0">${String(code).replace(/[<>]/g,'')}</div><div class="actions"><a class="btn" href="${ACCOUNT_URL}" target="_blank" rel="noopener">Otvoriť Streamlet Account</a><button class="btn secondary" id="checkLoginBtn">Skontrolovať</button><button class="btn ghost" id="copyCodeBtn">Kopírovať kód</button></div><p class="small muted">Po schválení sa sem vráť. Aplikácia stav priebežne kontroluje automaticky.${loginTransport==='direct'?' Prihlásenie ide priamo cez Safari, pretože Streamlet blokuje Render IP.':''}</p></div>`);
    document.querySelector('#checkLoginBtn')?.addEventListener('click',()=>checkExchange(true));
    document.querySelector('#copyCodeBtn')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(String(code));}catch{}});
    pollTimer=setInterval(()=>checkExchange(false),3000);
    setTimeout(()=>checkExchange(false),1200);
  }catch(err){
    const cors=String(err?.message||'').toLowerCase().includes('fetch')||String(err?.name||'').includes('TypeError');
    showState(`<div class="empty">Prihlásenie sa nepodarilo spustiť: ${cors?'Streamlet blokuje serverový proxy a Safari nedovolil priamy CORS prístup. Skús najprv otvoriť Streamlet Account v Safari a potom tlačidlo znova.':String(err.message||err)}</div><div class="actions" style="margin-top:10px"><a class="btn secondary" href="${ACCOUNT_URL}" target="_blank" rel="noopener">Otvoriť Streamlet Account</a></div>`);
  }finally{ if(btn){btn.disabled=false;btn.textContent='Vygenerovať nový kód';} }
}
async function exchangeDirect(){
  const data=await officialPost('device_code_exchange.php',{device_id:deviceId()});
  const token=extractToken(data);
  if(!token) return {...data,signedIn:false};
  await handoffToken(token);
  return {...data,access_token:undefined,token:undefined,signedIn:true};
}
async function checkExchange(manual){
  if(Date.now()>pollDeadline){ clearInterval(pollTimer); pollTimer=null; showState('<div class="empty">Platnosť kódu vypršala. Vygeneruj nový kód.</div>'); return; }
  try{
    const data=loginTransport==='direct'
      ? await exchangeDirect()
      : await accountApi('/api/account/device-code/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:deviceId()})});
    if(data.signedIn){ clearInterval(pollTimer); pollTimer=null; await renderAccount(); }
  }catch(err){
    const key=String(err.data?.error||err.data?.code||err.message||'').toLowerCase();
    const pending=err.status===400||err.status===404||err.status===409||key.includes('pending')||key.includes('not_approved')||key.includes('invalid_user_code');
    if(manual&&!pending) showState(`<div class="empty">Kontrola prihlásenia: ${String(err.message||err)}</div>`);
  }
}
async function logoutAccount(){
  clearInterval(pollTimer); pollTimer=null;
  try{ await accountApi('/api/account/logout',{method:'POST'}); }catch{}
  await renderAccount();
}

const observer=new MutationObserver(()=>{ if(document.querySelector('#loginForm')) renderAccount(); });
observer.observe(document.documentElement,{childList:true,subtree:true});
renderAccount();
