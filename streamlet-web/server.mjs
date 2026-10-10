import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);
const tmdbBearer = process.env.TMDB_BEARER || '';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const ACCOUNT_BASE = 'https://streamlet.info/account/v1';
const ACCOUNT_COOKIE = 'streamlet_account';

const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png'
};

function send(res,status,body,headers={}) { const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body); res.writeHead(status,{'Cache-Control':'no-store',...headers}); res.end(payload); }
function json(res,status,value,headers={}) { send(res,status,value,{'Content-Type':'application/json; charset=utf-8',...headers}); }

function privateIp(host) {
  const kind = net.isIP(host); if (!kind) return false;
  if (kind === 4) { const [a,b] = host.split('.').map(Number); return a===10 || a===127 || a===0 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || a>=224; }
  const h=host.toLowerCase(); return h==='::1' || h==='::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
}
async function publicUrl(input) {
  let value=String(input||'').trim(); if (value.startsWith('stremio://')) value=`https://${value.slice(10)}`; if (!/^https?:\/\//i.test(value)) value=`https://${value}`;
  const u=new URL(value); if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('Unsupported addon URL');
  if (!u.hostname || u.hostname==='localhost' || u.hostname.endsWith('.local') || privateIp(u.hostname)) throw new Error('Private/local addon URL blocked');
  const ips=await dns.lookup(u.hostname,{all:true,verbatim:true}); if (!ips.length || ips.some(x=>privateIp(x.address))) throw new Error('Addon host resolves to a private address');
  return u;
}
async function safeFetch(input,init={},redirects=0) {
  if (redirects>4) throw new Error('Too many redirects'); const u=await publicUrl(input);
  const r=await fetch(u,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
  if ([301,302,303,307,308].includes(r.status)) { const loc=r.headers.get('location'); if (loc) return safeFetch(new URL(loc,u).href,init,redirects+1); }
  return r;
}
async function proxyJson(res,target) { const r=await safeFetch(target); const text=await r.text(); let data; try{data=JSON.parse(text)}catch{return json(res,502,{error:'Upstream did not return JSON',status:r.status})} return json(res,r.ok?200:r.status,data); }
async function addonBase(manifest) { const u=await publicUrl(manifest); u.pathname=u.pathname.replace(/\/manifest\.json$/i,'').replace(/\/$/,''); u.search=''; u.hash=''; return u.href.replace(/\/$/,''); }

async function readJsonBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if (size>64*1024) throw new Error('Request body too large'); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON body'); }
}
function parseCookies(req) {
  const out={}; for (const part of String(req.headers.cookie||'').split(';')) { const i=part.indexOf('='); if (i<0) continue; const k=part.slice(0,i).trim(), v=part.slice(i+1).trim(); if (k) { try { out[k]=decodeURIComponent(v); } catch { out[k]=v; } } } return out;
}
function validDeviceId(value) { return typeof value==='string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value); }
async function accountPost(route, fields={}, token='') {
  const headers={'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','User-Agent':'StreamletWeb/1.1'};
  if (token) headers.Authorization=`Bearer ${token}`;
  const r=await fetch(`${ACCOUNT_BASE}${route}`,{method:'POST',headers,body:new URLSearchParams(fields),redirect:'manual',signal:AbortSignal.timeout(20000)});
  const text=await r.text(); let data; try { data=JSON.parse(text); } catch { data={message:text||`HTTP ${r.status}`}; }
  return {status:r.status,ok:r.ok,data};
}
function accessTokenFrom(data) { return data?.access_token || data?.token || data?.data?.access_token || data?.data?.token || ''; }
function stripToken(data) {
  if (!data || typeof data!=='object') return data;
  const copy=structuredClone(data); delete copy.access_token; delete copy.token; if (copy.data && typeof copy.data==='object') { delete copy.data.access_token; delete copy.data.token; }
  return copy;
}

function toTmdb(meta,type) {
  const year=String(meta.year||''); const rating=Number(meta.imdbRating||meta.imdb_rating||0) || 0; const isTv=type==='series';
  return {
    id: meta.id, media_type: isTv?'tv':'movie', title: isTv?undefined:meta.name, name:isTv?meta.name:undefined,
    overview: meta.description||meta.overview||'', poster_path: meta.poster||'', backdrop_path: meta.background||meta.poster||'',
    vote_average: rating, release_date: isTv?undefined:(year?`${year}-01-01`:''), first_air_date:isTv?(year?`${year}-01-01`:''):undefined,
    imdb_id: meta.id, external_ids:{imdb_id:meta.id}
  };
}
async function cinemetaCatalog(type,search='') {
  const extra=search?`/search=${encodeURIComponent(search)}`:''; const r=await safeFetch(`${CINEMETA}/catalog/${type}/top${extra}.json`); if (!r.ok) throw new Error(`Cinemeta HTTP ${r.status}`); return r.json();
}

async function handleAccount(req,res,url) {
  if (url.pathname==='/api/account/session') {
    const token=parseCookies(req)[ACCOUNT_COOKIE]||'';
    return json(res,200,{signedIn:Boolean(token)});
  }
  if (url.pathname==='/api/account/device-code/request') {
    const body=req.method==='POST'?await readJsonBody(req):{};
    const deviceId=String(body.deviceId||body.device_id||url.searchParams.get('device_id')||'');
    if (!validDeviceId(deviceId)) return json(res,400,{error:'invalid_device_id'});
    const upstream=await accountPost('/auth/device_code_request.php',{device_id:deviceId});
    return json(res,upstream.status,upstream.data);
  }
  if (url.pathname==='/api/account/device-code/exchange') {
    const body=req.method==='POST'?await readJsonBody(req):{};
    const deviceId=String(body.deviceId||body.device_id||url.searchParams.get('device_id')||'');
    if (!validDeviceId(deviceId)) return json(res,400,{error:'invalid_device_id'});
    const upstream=await accountPost('/auth/device_code_exchange.php',{device_id:deviceId});
    const token=accessTokenFrom(upstream.data);
    if (upstream.ok && token) {
      const cookie=`${ACCOUNT_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
      return json(res,200,{...stripToken(upstream.data),signedIn:true},{'Set-Cookie':cookie});
    }
    return json(res,upstream.status,{...stripToken(upstream.data),signedIn:false});
  }
  if (url.pathname==='/api/account/logout' && req.method==='POST') {
    const token=parseCookies(req)[ACCOUNT_COOKIE]||'';
    if (token) { try { await accountPost('/auth/logout.php',{},token); } catch {} }
    return json(res,200,{ok:true,signedIn:false},{'Set-Cookie':`${ACCOUNT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`});
  }
  return json(res,404,{error:'Account route not found'});
}

async function handleApi(req,res,url) {
  if (url.pathname==='/api/health') return json(res,200,{ok:true,app:'Streamlet Web',version:'1.1.0',accountDeviceCode:true});
  if (url.pathname==='/api/config') return json(res,200,{tmdbConfigured:true,catalogProvider:tmdbBearer?'tmdb':'cinemeta',accountDeviceCode:true});
  if (url.pathname.startsWith('/api/account/')) return handleAccount(req,res,url);

  if (url.pathname==='/api/tmdb') {
    const p=url.searchParams.get('path')||'';
    if (tmdbBearer) {
      if (!p.startsWith('/') || p.includes('://')) return json(res,400,{error:'Invalid TMDB path'});
      const target=new URL(`https://api.themoviedb.org/3${p}`); for (const [k,v] of url.searchParams) if (k!=='path') target.searchParams.append(k,v);
      const r=await fetch(target,{headers:{accept:'application/json',Authorization:`Bearer ${tmdbBearer}`},signal:AbortSignal.timeout(20000)}); const text=await r.text(); res.writeHead(r.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=60'}); return res.end(text);
    }
    if (p==='/movie/popular') { const d=await cinemetaCatalog('movie'); return json(res,200,{results:(d.metas||[]).map(x=>toTmdb(x,'movie'))}); }
    if (p==='/tv/popular') { const d=await cinemetaCatalog('series'); return json(res,200,{results:(d.metas||[]).map(x=>toTmdb(x,'series'))}); }
    if (p==='/search/multi') { const q=url.searchParams.get('query')||''; const [m,s]=await Promise.all([cinemetaCatalog('movie',q),cinemetaCatalog('series',q)]); return json(res,200,{results:[...(m.metas||[]).map(x=>toTmdb(x,'movie')),...(s.metas||[]).map(x=>toTmdb(x,'series'))]}); }
    return json(res,404,{error:'Metadata route unavailable without TMDB_BEARER'});
  }

  if (url.pathname==='/api/stremio/manifest') {
    const u=await publicUrl(url.searchParams.get('url')); if (!/manifest\.json$/i.test(u.pathname)) u.pathname=`${u.pathname.replace(/\/$/,'')}/manifest.json`; return proxyJson(res,u.href);
  }
  if (url.pathname==='/api/stremio/catalog' || url.pathname==='/api/stremio/meta' || url.pathname==='/api/stremio/stream') {
    const manifest=url.searchParams.get('manifest'); const type=encodeURIComponent(url.searchParams.get('type')||'movie'); const id=encodeURIComponent(url.searchParams.get('id')||''); if (!manifest || !id) return json(res,400,{error:'manifest, type and id are required'});
    const base=await addonBase(manifest); const resource=url.pathname.split('/').pop(); let target=`${base}/${resource}/${type}/${id}`;
    if (resource==='catalog' && url.searchParams.get('extra')) target+=`/${encodeURIComponent(url.searchParams.get('extra'))}`; return proxyJson(res,`${target}.json`);
  }
  return json(res,404,{error:'API route not found'});
}

async function serveStatic(res,url) {
  let pathname=decodeURIComponent(url.pathname); if (pathname==='/') pathname='/index.html'; let file=path.normalize(path.join(publicDir,pathname)); if (!file.startsWith(publicDir)) return send(res,403,'Forbidden');
  try { const st=await fs.stat(file); if (st.isDirectory()) file=path.join(file,'index.html'); const body=await fs.readFile(file); const ext=path.extname(file); return send(res,200,body,{'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':['.svg','.png'].includes(ext)?'public, max-age=86400':'no-cache'}); }
  catch { try { return send(res,200,await fs.readFile(path.join(publicDir,'index.html')),{'Content-Type':'text/html; charset=utf-8'}); } catch { return send(res,404,'Not found'); } }
}

http.createServer(async (req,res)=>{ const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); try { if (url.pathname.startsWith('/api/')) await handleApi(req,res,url); else await serveStatic(res,url); } catch(e) { console.error(e); json(res,500,{error:e?.message||'Internal server error'}); } }).listen(port,'0.0.0.0',()=>console.log(`Streamlet Web listening on :${port}`));
