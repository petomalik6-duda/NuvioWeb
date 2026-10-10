const $ = (sel, root=document) => root.querySelector(sel);
const app = $('#app');
const state = {
  tab: 'home',
  config: { tmdbConfigured: false },
  home: { movies: [], series: [] },
  search: [],
  addons: JSON.parse(localStorage.getItem('streamlet.addons') || '[]'),
  favorites: JSON.parse(localStorage.getItem('streamlet.favorites') || '[]'),
  locale: localStorage.getItem('streamlet.locale') || 'sk-SK',
  loading: false,
};

const demo = [
  {id:'demo-1',media_type:'movie',title:'Streamlet Web',overview:'Prvá webová/PWA verzia pripravená pre iPhone a iPad.',vote_average:9.4,release_date:'2026-10-10'},
  {id:'demo-2',media_type:'movie',title:'Stremio Addons',overview:'Nainštaluj ľubovoľný kompatibilný Stremio addon cez manifest URL.',vote_average:9.1,release_date:'2026-10-10'},
  {id:'demo-3',media_type:'tv',name:'AirPlay Ready',overview:'Safari video prehrávač používa systémové AirPlay ovládanie pre kompatibilné streamy.',vote_average:9.0,first_air_date:'2026-10-10'}
];

function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.hidden=true,3200)}
function titleOf(i){return i.title || i.name || i.meta?.name || 'Bez názvu'}
function yearOf(i){return (i.release_date || i.first_air_date || i.year || '').slice?.(0,4) || ''}
function posterOf(i){const p=i.poster_path || i.poster;return p?.startsWith('http')?p:p?`https://image.tmdb.org/t/p/w500${p}`:''}
function backdropOf(i){const p=i.backdrop_path || i.background || i.poster;return p?.startsWith('http')?p:p?`https://image.tmdb.org/t/p/original${p}`:''}
function mediaType(i){return i.media_type || i.type || (i.first_air_date?'tv':'movie')}
function save(){localStorage.setItem('streamlet.addons',JSON.stringify(state.addons));localStorage.setItem('streamlet.favorites',JSON.stringify(state.favorites));localStorage.setItem('streamlet.locale',state.locale)}
function isFav(i){return state.favorites.some(x=>String(x.id)===String(i.id)&&mediaType(x)===mediaType(i))}
function toggleFav(i){if(isFav(i))state.favorites=state.favorites.filter(x=>!(String(x.id)===String(i.id)&&mediaType(x)===mediaType(i)));else state.favorites.unshift({...i,media_type:mediaType(i)});save();render();toast(isFav(i)?'Pridané do knižnice':'Odstránené z knižnice')}

async function api(url,opts){const r=await fetch(url,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
async function tmdb(path, params={}){const q=new URLSearchParams({path,language:state.locale,...params});return api(`/api/tmdb?${q}`)}

async function loadHome(){
  if(!state.config.tmdbConfigured){state.home.movies=demo.filter(x=>mediaType(x)==='movie');state.home.series=demo.filter(x=>mediaType(x)==='tv');return}
  try{
    const [m,s]=await Promise.all([tmdb('/movie/popular'),tmdb('/tv/popular')]);
    state.home.movies=(m.results||[]).map(x=>({...x,media_type:'movie'}));
    state.home.series=(s.results||[]).map(x=>({...x,media_type:'tv'}));
  }catch(e){toast(e.message)}
}

function nav(){return `<nav class="bottomnav">
  ${navItem('home','⌂','Domov')}${navItem('search','⌕','Hľadať')}${navItem('library','♡','Knižnica')}${navItem('modules','◫','Moduly')}${navItem('settings','⚙','Nastavenia')}
</nav>`}
function navItem(id,ico,label){return `<button class="navitem ${state.tab===id?'active':''}" data-tab="${id}"><span class="ico">${ico}</span><span>${label}</span></button>`}
function topbar(){return `<header class="topbar"><img class="logo" src="/logo.svg"><div class="brand">Streamlet</div><div class="spacer"></div><button class="iconbtn" data-action="install" aria-label="Install">＋</button></header>`}
function card(i){const p=posterOf(i);return `<article class="card" data-item='${encodeURIComponent(JSON.stringify(i))}'>
<div class="poster">${p?`<img src="${escapeHtml(p)}" loading="lazy">`:''}<span class="badge">${mediaType(i)==='tv'?'SERIÁL':'FILM'}</span></div>
<div class="card-title">${escapeHtml(titleOf(i))}</div><div class="card-sub">${escapeHtml(yearOf(i))}${i.vote_average?` · ★ ${Number(i.vote_average).toFixed(1)}`:''}</div></article>`}
function row(title,items){return `<section class="section"><div class="section-head"><h2>${title}</h2></div><div class="cards">${(items||[]).map(card).join('')||'<div class="empty">Žiadny obsah</div>'}</div></section>`}

function homePage(){const hero=state.home.movies[0]||demo[0];const bg=backdropOf(hero);return `<main class="content">
<section class="hero"><div class="hero-bg" style="background-image:url('${escapeHtml(bg)}')"></div><div class="hero-body"><div class="kicker">Streamlet Web · iPhone + iPad</div><h1>${escapeHtml(titleOf(hero))}</h1><div class="meta"><span>${escapeHtml(yearOf(hero)||'2026')}</span><span>★ ${hero.vote_average?Number(hero.vote_average).toFixed(1):'9.4'}</span><span>PWA</span><span>AirPlay</span></div><div class="actions"><button class="btn" data-item='${encodeURIComponent(JSON.stringify(hero))}'>▶ Detail</button><button class="btn secondary" data-tab="modules">＋ Addony</button></div></div></section>
${row('Populárne filmy',state.home.movies)}${row('Populárne seriály',state.home.series)}</main>`}
function searchPage(){return `<main class="content"><h1 class="page-title">Hľadať</h1><form class="searchbox" id="searchForm"><input id="searchInput" autocomplete="off" placeholder="Film, seriál…"><button class="btn">Hľadať</button></form><section class="section"><div class="grid">${state.search.map(card).join('')||'<div class="empty">Vyhľadaj film alebo seriál.</div>'}</div></section></main>`}
function libraryPage(){return `<main class="content"><h1 class="page-title">Knižnica</h1>${row('Obľúbené',state.favorites)}</main>`}
function modulesPage(){return `<main class="content"><h1 class="page-title">Moduly</h1><div class="panel"><h2>Stremio addony</h2><p class="muted">Vlož manifest URL alebo konfiguračný manifest vygenerovaný addonom.</p><form id="addonForm" class="searchbox"><input id="addonUrl" placeholder="https://…/manifest.json" inputmode="url"><button class="btn">Pridať</button></form><div class="install-hint small muted">Streamlet 1.1.0 podporuje Stremio addony. Web verzia načíta manifest, katalógy, metadata a stream resource cez serverový proxy.</div><div id="addonList">${state.addons.map(a=>`<div class="module"><div class="module-icon">S</div><div class="module-info"><b>${escapeHtml(a.name)}</b><span class="small muted">${escapeHtml(a.url)}</span></div><span class="status">${(a.resources||[]).includes('stream')?'STREAM':'ADDON'}</span><button class="chip" data-remove-addon="${escapeHtml(a.id)}">×</button></div>`).join('')||'<div class="empty">Zatiaľ nie je nainštalovaný žiadny addon.</div>'}</div></div></main>`}
function settingsPage(){return `<main class="content"><h1 class="page-title">Nastavenia</h1><div class="split"><div class="panel"><h2>Jazyk katalógu</h2><div class="chips"><button class="chip ${state.locale==='sk-SK'?'active':''}" data-locale="sk-SK">Slovenčina</button><button class="chip ${state.locale==='cs-CZ'?'active':''}" data-locale="cs-CZ">Čeština</button><button class="chip ${state.locale==='en-US'?'active':''}" data-locale="en-US">English</button></div></div><div class="panel"><h2>Stav</h2><div class="setting-row"><span>TMDB</span><b>${state.config.tmdbConfigured?'Pripojené':'Chýba TMDB_BEARER'}</b></div><div class="setting-row"><span>PWA</span><b>Pripravené</b></div><div class="setting-row"><span>AirPlay</span><b>Safari video</b></div></div></div><div class="panel section"><h2>Streamlet Account</h2><p class="muted">Experimentálne prihlásenie cez endpoint nájdený v iOS 1.1.0. Heslo sa neposiela do localStorage.</p><form id="loginForm"><input class="field" id="email" type="email" placeholder="Email"><div style="height:9px"></div><input class="field" id="password" type="password" placeholder="Heslo"><div style="height:11px"></div><button class="btn">Prihlásiť</button></form></div></main>`}

function render(){let body=homePage();if(state.tab==='search')body=searchPage();if(state.tab==='library')body=libraryPage();if(state.tab==='modules')body=modulesPage();if(state.tab==='settings')body=settingsPage();app.innerHTML=`<div class="app">${topbar()}${body}${nav()}</div>`;bind()}

function bind(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render()});
  document.querySelectorAll('[data-item]').forEach(el=>el.onclick=e=>{if(e.target.closest('[data-tab]'))return;openDetail(JSON.parse(decodeURIComponent(el.dataset.item)))});
  document.querySelectorAll('[data-remove-addon]').forEach(b=>b.onclick=()=>{state.addons=state.addons.filter(x=>x.id!==b.dataset.removeAddon);save();render()});
  document.querySelectorAll('[data-locale]').forEach(b=>b.onclick=async()=>{state.locale=b.dataset.locale;save();await loadHome();render()});
  $('#searchForm')?.addEventListener('submit',searchSubmit);$('#addonForm')?.addEventListener('submit',addonSubmit);$('#loginForm')?.addEventListener('submit',loginSubmit);
  $('[data-action="install"]')?.addEventListener('click',()=>toast('Na iPhone/iPad: Zdieľať → Pridať na plochu'));
}

async function searchSubmit(e){e.preventDefault();const q=$('#searchInput').value.trim();if(!q)return;if(!state.config.tmdbConfigured){state.search=demo.filter(x=>titleOf(x).toLowerCase().includes(q.toLowerCase()));return render()}try{const r=await tmdb('/search/multi',{query:q,include_adult:'false'});state.search=(r.results||[]).filter(x=>['movie','tv'].includes(x.media_type));render()}catch(err){toast(err.message)}}
async function addonSubmit(e){e.preventDefault();const input=$('#addonUrl').value.trim();if(!input)return;try{const manifest=await api(`/api/stremio/manifest?url=${encodeURIComponent(input)}`);const url=input.startsWith('stremio://')?`https://${input.slice(10)}`:input;const finalUrl=/manifest\.json/i.test(url)?url:`${url.replace(/\/$/,'')}/manifest.json`;state.addons=state.addons.filter(x=>x.id!==manifest.id);state.addons.push({id:manifest.id||crypto.randomUUID(),name:manifest.name||manifest.id||'Stremio addon',version:manifest.version,url:finalUrl,resources:manifest.resources||[],catalogs:manifest.catalogs||[],types:manifest.types||[]});save();render();toast(`Pridaný addon: ${manifest.name||manifest.id}`)}catch(err){toast(err.message)}}
async function loginSubmit(e){e.preventDefault();const email=$('#email').value,password=$('#password').value;try{const r=await api('/api/account/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const token=r.token||r.access_token||r.data?.token;if(token){sessionStorage.setItem('streamlet.account.token',token);toast('Streamlet Account prihlásený')}else toast(r.message||'Server odpovedal, ale token nebol rozpoznaný')}catch(err){toast(`Prihlásenie: ${err.message}`)}}

async function openDetail(item){
  let detail=item;const type=mediaType(item);
  if(state.config.tmdbConfigured && /^\d+$/.test(String(item.id))){try{detail=await tmdb(`/${type}/${item.id}`,{append_to_response:'external_ids'});detail.media_type=type}catch{}}
  const shell=document.createElement('div');shell.className='sheet-backdrop';shell.innerHTML=`<div class="sheet"><div class="handle"></div><div class="detail-backdrop" style="background-image:url('${escapeHtml(backdropOf(detail)||posterOf(detail))}')"></div><h1 class="detail-title">${escapeHtml(titleOf(detail))}</h1><div class="meta"><span>${escapeHtml(yearOf(detail))}</span><span>★ ${detail.vote_average?Number(detail.vote_average).toFixed(1):'–'}</span></div><p class="muted">${escapeHtml(detail.overview||detail.description||'Bez popisu.')}</p><div class="actions"><button class="btn" id="favBtn">${isFav({...item,media_type:type})?'♥ V knižnici':'♡ Do knižnice'}</button><button class="btn secondary" id="streamsBtn">▶ Streamy</button><button class="btn ghost" id="closeBtn">Zavrieť</button></div><div id="streams"></div></div>`;
  document.body.appendChild(shell);$('#closeBtn',shell).onclick=()=>shell.remove();shell.onclick=e=>{if(e.target===shell)shell.remove()};$('#favBtn',shell).onclick=()=>{toggleFav({...item,media_type:type});shell.remove()};
  $('#streamsBtn',shell).onclick=()=>loadStreams(detail,type,$('#streams',shell));
}

function deriveStremioId(detail,type){
  if(type==='movie') return detail.imdb_id || detail.external_ids?.imdb_id || null;
  return detail.external_ids?.imdb_id || null;
}
async function loadStreams(detail,type,host){
  const id=deriveStremioId(detail,type);host.innerHTML='<div class="empty">Hľadám streamy…</div>';
  if(!id){host.innerHTML='<div class="empty">Pre streamy treba IMDb ID. Pri TMDB obsahu sa doplní automaticky, ak existuje.</div>';return}
  const streamAddons=state.addons.filter(a=>(a.resources||[]).some(r=>r==='stream'||r?.name==='stream') && (!a.types?.length||a.types.includes(type==='tv'?'series':'movie')));
  if(!streamAddons.length){host.innerHTML='<div class="empty">Nainštaluj najprv Stremio stream addon v záložke Moduly.</div>';return}
  const results=[];
  await Promise.all(streamAddons.map(async a=>{try{const r=await api(`/api/stremio/stream?manifest=${encodeURIComponent(a.url)}&type=${type==='tv'?'series':'movie'}&id=${encodeURIComponent(id)}`);for(const s of r.streams||[])results.push({...s,_addon:a.name})}catch(err){results.push({_error:err.message,_addon:a.name})}}));
  host.innerHTML=`<section class="section"><h2>Streamy (${results.filter(x=>!x._error).length})</h2>${results.map(streamHtml).join('')||'<div class="empty">Žiadny stream.</div>'}</section>`;
  host.querySelectorAll('[data-play]').forEach(b=>b.onclick=()=>playStream(decodeURIComponent(b.dataset.play),b.dataset.name));
}
function streamHtml(s){if(s._error)return `<div class="stream"><div><div class="stream-name">${escapeHtml(s._addon)}</div><div class="stream-desc">${escapeHtml(s._error)}</div></div></div>`;const url=s.url||s.externalUrl||'';const name=s.name||s.title||s._addon;return `<div class="stream"><div><div class="stream-name">${escapeHtml(name)}</div><div class="stream-desc">${escapeHtml(s.description||s.title||s._addon)}</div></div>${url?`<button class="chip" data-play="${encodeURIComponent(url)}" data-name="${escapeHtml(name)}">Prehrať</button>`:'<span class="quality">TORRENT/INÝ</span>'}</div>`}
function playStream(url,name='Stream'){
  if(!/^https?:/i.test(url)){toast('Safari vie priamo prehrať HTTP(S) stream. Torrent/Usenet potrebuje stream proxy/resolver.');return}
  const wrap=document.createElement('div');wrap.className='player-wrap';wrap.innerHTML=`<button class="iconbtn player-close">×</button><video controls autoplay playsinline webkit-playsinline x-webkit-airplay="allow" src="${escapeHtml(url)}"></video>`;document.body.appendChild(wrap);$('.player-close',wrap).onclick=()=>{const v=$('video',wrap);v.pause();wrap.remove()};const v=$('video',wrap);v.addEventListener('error',()=>toast('Safari tento stream nevie dekódovať alebo server blokuje prehrávanie.'));
}

async function init(){
  try{state.config=await api('/api/config')}catch{}
  await loadHome();render();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
init();
