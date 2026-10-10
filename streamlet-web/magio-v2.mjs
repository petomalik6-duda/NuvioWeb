import { gunzipSync } from 'node:zlib';
import { MAGIO_XL_GROUPS, MAGIO_ALIASES } from './magio-lineup.mjs';

const PUBLIC_BASE = 'https://czsk-iptv.onrender.com';
const STREAM_COUNTRIES = ['sk','cz','uk','fr','de','it','pl','es','us','hu','nl'];
const STREAM_SOURCES = STREAM_COUNTRIES.map(c => `https://iptv-org.github.io/iptv/countries/${c}.m3u`);
const EPG_SOURCES = [
  { country: 'sk', url: 'https://epgshare01.online/epgshare01/epg_ripper_SK1.xml.gz' },
  { country: 'cz', url: 'https://epgshare01.online/epgshare01/epg_ripper_CZ1.xml.gz' }
];
const TTL = 6 * 60 * 60 * 1000;
const cache = { entries:null, entriesAt:0, selection:null, selectionAt:0, epgData:null, epgDataAt:0, epg:null, epgAt:0, stats:null };

function attr(text, name) {
  const m = String(text || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}
function xmlEscape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function normalize(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g,' ')
    .replace(/\([^)]*(?:p|k|fps|beta|not\s*24\/7)[^)]*\)/gi,' ')
    .replace(/18\+/gi,' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/\b(?:hd|sd|uhd|fhd|4k|czech republic|czechia|slovakia|slovensko|cesko|czech|slovak)\b/g,' ')
    .replace(/[^a-z0-9]+/g,'');
}
function idBase(id) { return String(id || '').split('@')[0].replace(/\.[a-z]{2,3}$/i,''); }
function canonicalId(name) { return `magio.${normalize(name) || 'channel'}`; }

async function fetchBuffer(url) {
  const r = await fetch(url, { headers:{'User-Agent':'CZSK-IPTV-MagioXL/2.1','Accept':'*/*'}, signal:AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function fetchText(url) { return (await fetchBuffer(url)).toString('utf8'); }
function decodeMaybeGzip(buffer) {
  const b = Buffer.from(buffer);
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b).toString('utf8') : b.toString('utf8');
}

function parseM3u(text, sourceCountry='') {
  const lines = String(text || '').replace(/\r/g,'').split('\n');
  const out = [];
  let block=[], info='';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) { block=[line]; info=line; continue; }
    if (!block.length) continue;
    block.push(line);
    if (!line.startsWith('#')) {
      const name = info.includes(',') ? info.slice(info.lastIndexOf(',')+1).trim() : '';
      const id = attr(info,'tvg-id');
      const hint = (id.match(/\.([a-z]{2,3})(?:@|$)/i)?.[1] || sourceCountry || '').toLowerCase();
      const keys = new Set([normalize(name), normalize(idBase(id))].filter(Boolean));
      out.push({id,name,url:line,lines:[...block],countryHint:hint,keys});
      block=[]; info='';
    }
  }
  return out;
}

async function sourceEntries() {
  if (cache.entries && Date.now()-cache.entriesAt < TTL) return cache.entries;
  const loaded = await Promise.all(STREAM_SOURCES.map(async (url,i) => ({ country:STREAM_COUNTRIES[i], text:await fetchText(url) })));
  const seen = new Set(), out=[];
  for (const src of loaded) {
    for (const e of parseM3u(src.text, src.country)) {
      if (!/^https?:\/\//i.test(e.url) || seen.has(e.url)) continue;
      seen.add(e.url); out.push(e);
    }
  }
  cache.entries=out; cache.entriesAt=Date.now();
  return out;
}

function aliasesFor(name) {
  return [...new Set([name,...(MAGIO_ALIASES[name]||[])].map(normalize).filter(Boolean))];
}
function score(entry, aliases) {
  let s=-1;
  const n=normalize(entry.name), i=normalize(idBase(entry.id));
  for (const a of aliases) {
    if (i===a) s=Math.max(s,140);
    if (n===a) s=Math.max(s,130);
    if (entry.keys.has(a)) s=Math.max(s,125);
    if (a.length>=6 && i && (i.includes(a)||a.includes(i))) s=Math.max(s,85);
    if (a.length>=6 && n && (n.includes(a)||a.includes(n))) s=Math.max(s,75);
  }
  if (s<0) return s;
  if (entry.countryHint==='sk'||entry.countryHint==='cz') s+=5;
  if (/^https:/i.test(entry.url)) s+=2;
  if (/\.m3u8(?:\?|$)/i.test(entry.url)) s+=1;
  return s;
}
function choose(entries,name,used) {
  const aliases=aliasesFor(name);
  let best=null, bestScore=-1;
  for (const e of entries) {
    if (used.has(e.url)) continue;
    const sc=score(e,aliases);
    if (sc>bestScore) { best=e; bestScore=sc; }
  }
  return bestScore>=70 ? best : null;
}

async function selection() {
  if (cache.selection && Date.now()-cache.selectionAt < TTL) return cache.selection;
  const entries=await sourceEntries();
  const selected=[], missing=[], used=new Set();
  let globalOrder=0;
  for (const [slug,groupName,names] of MAGIO_XL_GROUPS) {
    let groupOrder=0;
    for (const officialName of names) {
      globalOrder++; groupOrder++;
      const hit=choose(entries,officialName,used);
      if (!hit) { missing.push({slug,groupName,officialName,order:globalOrder}); continue; }
      used.add(hit.url);
      selected.push({...hit,officialName,canonicalId:canonicalId(officialName),slug,groupName,order:globalOrder,groupOrder});
    }
  }
  cache.selection={selected,missing}; cache.selectionAt=Date.now(); cache.epg=null; cache.stats=null;
  return cache.selection;
}

function setAttr(info,name,value) {
  const escaped=String(value).replace(/"/g,'&quot;');
  const re=new RegExp(`\\b${name}="[^"]*"`,'i');
  if (re.test(info)) return info.replace(re,`${name}="${escaped}"`);
  const comma=info.indexOf(',');
  return comma<0 ? `${info} ${name}="${escaped}"` : `${info.slice(0,comma)} ${name}="${escaped}"${info.slice(comma)}`;
}
function playlistLines(e) {
  let info=e.lines[0];
  info=setAttr(info,'tvg-id',e.canonicalId);
  info=setAttr(info,'tvg-name',e.officialName);
  info=setAttr(info,'group-title',e.groupName);
  info=setAttr(info,'tvg-chno',e.order);
  const comma=info.indexOf(',');
  if (comma>=0) info=`${info.slice(0,comma+1)}${e.officialName}`;
  return [info,...e.lines.slice(1)];
}
async function buildPlaylist(slug='all') {
  const {selected}=await selection();
  const subset=slug==='all' ? selected : selected.filter(e=>e.slug===slug);
  const epg=`${PUBLIC_BASE}/iptv/magio-xl.xml`;
  const out=[`#EXTM3U x-tvg-url="${epg}" url-tvg="${epg}"`];
  for (const e of subset) out.push(...playlistLines(e));
  return `${out.join('\n')}\n`;
}

function extractBlocks(xml,tag) { return String(xml||'').match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`,'gi'))||[]; }
function displayNames(block) {
  return [...String(block||'').matchAll(/<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/gi)].map(m=>m[1].replace(/<[^>]+>/g,'').trim()).filter(Boolean);
}
function replaceAttr(block,tag,name,value) {
  const re=new RegExp(`(<${tag}\\b[^>]*\\b${name}=")[^"]*(")`,'i');
  if (re.test(block)) return String(block).replace(re,`$1${xmlEscape(value)}$2`);
  return String(block).replace(new RegExp(`<${tag}\\b`,'i'),`<${tag} ${name}="${xmlEscape(value)}"`);
}

async function epgData() {
  if (cache.epgData && Date.now()-cache.epgDataAt<TTL) return cache.epgData;
  const sources=await Promise.all(EPG_SOURCES.map(async s=>{
    const xml=decodeMaybeGzip(await fetchBuffer(s.url));
    const channels=extractBlocks(xml,'channel').map(block=>({id:attr(block,'id'),names:displayNames(block),block,country:s.country})).filter(c=>c.id);
    const programmesByChannel=new Map();
    for (const block of extractBlocks(xml,'programme')) {
      const id=attr(block,'channel'); if(!id) continue;
      if(!programmesByChannel.has(id)) programmesByChannel.set(id,[]);
      programmesByChannel.get(id).push(block);
    }
    return {...s,channels,programmesByChannel};
  }));
  const byKey=new Map();
  for (const ch of sources.flatMap(s=>s.channels)) {
    const keys=new Set([normalize(ch.id),...ch.names.map(normalize)].filter(Boolean));
    for (const key of keys) { if(!byKey.has(key)) byKey.set(key,[]); byKey.get(key).push(ch); }
  }
  cache.epgData={sources,byKey}; cache.epgDataAt=Date.now(); return cache.epgData;
}
function chooseEpg(entry,data) {
  const aliases=[...aliasesFor(entry.officialName),normalize(entry.name),normalize(idBase(entry.id))].filter(Boolean);
  let hits=[];
  for (const a of aliases) { const f=data.byKey.get(a)||[]; if(f.length){hits=f;break;} }
  if(!hits.length) return null;
  if(hits.length===1) return hits[0];
  const c=hits.filter(h=>h.country===entry.countryHint);
  return c[0]||hits[0];
}

async function buildEpg() {
  if (cache.epg && Date.now()-cache.epgAt<TTL) return cache.epg;
  const [{selected,missing},data]=await Promise.all([selection(),epgData()]);
  const sourceFor=new Map();
  for(const s of data.sources) for(const ch of s.channels) sourceFor.set(`${ch.country}|${ch.id}`,s);
  const channels=[],programmes=[],epgMissing=[];
  let epgMatched=0,withProgrammes=0;
  for(const e of selected){
    const ch=chooseEpg(e,data);
    if(!ch){channels.push(`<channel id="${xmlEscape(e.canonicalId)}"><display-name>${xmlEscape(e.officialName)}</display-name></channel>`);epgMissing.push(e.officialName);continue;}
    epgMatched++;
    channels.push(replaceAttr(ch.block,'channel','id',e.canonicalId));
    const src=sourceFor.get(`${ch.country}|${ch.id}`);
    const ps=src?.programmesByChannel.get(ch.id)||[];
    if(ps.length) withProgrammes++;
    for(const p of ps) programmes.push(replaceAttr(p,'programme','channel',e.canonicalId));
  }
  cache.epg=`<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Magio TV XL public mapping 2026">\n${channels.join('\n')}\n${programmes.join('\n')}\n</tv>\n`;
  cache.epgAt=Date.now();
  cache.stats={
    officialChannels:MAGIO_XL_GROUPS.reduce((n,[,,a])=>n+a.length,0),
    streamableChannels:selected.length,
    missingStreams:missing.length,
    epgMatched,
    channelsWithProgrammes:withProgrammes,
    programmes:programmes.length,
    epgBytes:Buffer.byteLength(cache.epg),
    streamCountries:STREAM_COUNTRIES,
    groupStats:MAGIO_XL_GROUPS.map(([slug,groupName,names])=>({slug,groupName,official:names.length,streamable:selected.filter(e=>e.slug===slug).length})),
    missingSample:missing.slice(0,60).map(x=>x.officialName),
    epgMissingSample:epgMissing.slice(0,40)
  };
  return cache.epg;
}

async function lineupJson(){
  const {selected,missing}=await selection(); await buildEpg();
  const byName=new Map(selected.map(e=>[e.officialName,e]));
  return {ok:true,source:'Slovak Telekom official Magio TV cez internet PDF, valid from 31.7.2026',plan:'XL',premiumPacksIncluded:false,...cache.stats,
    groups:MAGIO_XL_GROUPS.map(([slug,name,names])=>({slug,name,channels:names.map((officialName,i)=>({order:i+1,name:officialName,streamAvailable:byName.has(officialName),sourceName:byName.get(officialName)?.name||null,sourceTvgId:byName.get(officialName)?.id||null}))})),
    missing:missing.map(x=>x.officialName)};
}
function send(res,status,body,type){res.writeHead(status,{'Content-Type':type,'Cache-Control':'public, max-age=1800, stale-while-revalidate=21600','Access-Control-Allow-Origin':'*'});res.end(body);}

export async function handleMagioRoute(req,res,url){
  if(req.method!=='GET'&&req.method!=='HEAD') return false;
  if(url.pathname==='/iptv/magio-max.m3u'||url.pathname==='/iptv/magio-xl.m3u'){
    const body=await buildPlaylist('all');send(res,200,req.method==='HEAD'?'':body,'application/vnd.apple.mpegurl; charset=utf-8');return true;
  }
  const m=url.pathname.match(/^\/iptv\/magio-xl\/([a-z0-9-]+)\.m3u$/i);
  if(m){const slug=m[1].toLowerCase();if(!MAGIO_XL_GROUPS.some(g=>g[0]===slug))return false;const body=await buildPlaylist(slug);send(res,200,req.method==='HEAD'?'':body,'application/vnd.apple.mpegurl; charset=utf-8');return true;}
  if(url.pathname==='/iptv/magio-max.xml'||url.pathname==='/iptv/magio-xl.xml'){
    const body=await buildEpg();send(res,200,req.method==='HEAD'?'':body,'application/xml; charset=utf-8');return true;
  }
  if(url.pathname==='/iptv/magio-xl-lineup.json'){
    const body=JSON.stringify(await lineupJson());send(res,200,req.method==='HEAD'?'':body,'application/json; charset=utf-8');return true;
  }
  if(url.pathname==='/iptv/magio-status.json'){
    await Promise.all([buildPlaylist('all'),buildEpg()]);send(res,200,req.method==='HEAD'?'':JSON.stringify({ok:true,style:'Official Magio TV XL lineup mapping',source:'Telekom lineup + public iptv-org streams',...(cache.stats||{})}),'application/json; charset=utf-8');return true;
  }
  return false;
}
