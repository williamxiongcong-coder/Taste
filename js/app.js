/* Taste · app.js
   结构：工具 → 本地数据库 → 播放引擎 → 音乐库 → 播客 → 正在播放 UI → 驾驶模式 → 设置 → 启动 */
'use strict';
(function(){

/* ================= 工具 ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function fmt(sec){
  if(!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
           : m + ':' + String(s).padStart(2, '0');
}
function fmtDate(ts){
  if(!ts) return '';
  const d = new Date(ts), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if(days <= 0 && d.getDate() === now.getDate()) return '今天';
  if(days < 2 && Math.abs(d.getDate() - now.getDate()) === 1) return '昨天';
  if(days < 7) return days + ' 天前';
  if(d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}
let toastTimer = null;
function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const ls = {
  get(k, d){ try{ const v = localStorage.getItem('tf.' + k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('tf.' + k, JSON.stringify(v)); }catch(e){} }
};
/* 两次点击确认（危险操作） */
function armConfirm(btn, label, confirmLabel, fn){
  btn.addEventListener('click', () => {
    if(btn.dataset.armed){
      clearTimeout(+btn.dataset.timer);
      delete btn.dataset.armed;
      btn.textContent = label;
      fn();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = confirmLabel;
    btn.dataset.timer = setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 3200);
  });
}

/* ================= 本地数据库（IndexedDB） ================= */
let db = null;
function idbOpen(){
  return new Promise((res, rej) => {
    try{
      const r = indexedDB.open('taste', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if(!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
        if(!d.objectStoreNames.contains('feeds')) d.createObjectStore('feeds', { keyPath: 'id' });
        if(!d.objectStoreNames.contains('positions')) d.createObjectStore('positions', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }catch(e){ rej(e); }
  });
}
function idb(store, mode, fn){
  return new Promise((res, rej) => {
    if(!db) return res(null);
    try{
      const tx = db.transaction(store, mode);
      const rq = fn(tx.objectStore(store));
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }catch(e){ rej(e); }
  });
}
const S = {
  all: st => idb(st, 'readonly', o => o.getAll()).catch(() => []),
  get: (st, k) => idb(st, 'readonly', o => o.get(k)).catch(() => null),
  put: (st, v) => idb(st, 'readwrite', o => o.put(v)).catch(() => {}),
  del: (st, k) => idb(st, 'readwrite', o => o.delete(k)).catch(() => {}),
  clear: st => idb(st, 'readwrite', o => o.clear()).catch(() => {})
};

/* ================= 全局状态 ================= */
let songs = [];          // {id,title,artist,album,pic,blob,dur,liked,addedAt}
let feeds = [];          // {id,url,title,author,cover,desc,eps:[],lastFetch,addedAt}
let positions = {};      // key -> {key,pos,dur,played,updatedAt}

const audio = new Audio();
audio.preload = 'metadata';

let queue = [];          // [{kind:'song',id} | {kind:'ep',feedId,guid}]
let qIndex = -1;
let current = null;      // 当前项目引用（song 或 {feed,ep}）
let curKind = null;      // 'song' | 'ep'
let shuffle = ls.get('shuffle', false);
let repeat = ls.get('repeat', 0);      // 0 关 1 全部 2 单曲
let rate = ls.get('rate', 1);
let musicFilter = 'all';
let curURL = null, curArtURL = null;
let seeking = false;
let openShowId = null;   // 当前打开的播客详情

/* ================= 环境光（从封面取色） ================= */
async function extractColor(src){
  try{
    const img = new Image();
    let revoke = null;
    if(typeof src === 'string'){ img.crossOrigin = 'anonymous'; img.src = src; }
    else { revoke = URL.createObjectURL(src); img.src = revoke; }
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    if(revoke) URL.revokeObjectURL(revoke);
    let r = 0, g = 0, b = 0, n = 0;
    for(let i = 0; i < d.length; i += 4){
      const R = d[i], G = d[i+1], B = d[i+2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if(mx < 36 || (mx > 238 && mx - mn < 24)) continue;
      const w = (mx - mn) + 6;
      r += R * w; g += G * w; b += B * w; n += w;
    }
    if(!n) return null;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    const mx = Math.max(r, g, b, 1);
    const boost = Math.min(1.35, 190 / mx);    // 提亮，让辉光可见
    return [Math.round(r * boost), Math.round(g * boost), Math.round(b * boost)];
  }catch(e){ return null; }
}
function setGlow(rgb){
  document.documentElement.style.setProperty('--glow', rgb ? rgb.join(',') : '217,189,141');
}

/* ================= 播放引擎 ================= */
function refOf(item){ return item.kind === 'song' ? songs.find(s => s.id === item.id)
  : (() => { const f = feeds.find(f => f.id === item.feedId); if(!f) return null;
       const e = (f.eps || []).find(e => e.guid === item.guid); return e ? { feed: f, ep: e } : null; })(); }

function posKey(feedId, guid){ return feedId + '|' + guid; }

async function playItem(item){
  const ref = refOf(item);
  if(!ref){ toast('找不到这条内容'); return; }
  savePosNow();
  if(curURL){ URL.revokeObjectURL(curURL); curURL = null; }

  if(item.kind === 'song'){
    const s = ref;
    try{ curURL = URL.createObjectURL(s.blob); }catch(e){ toast('无法读取文件'); return; }
    audio.src = curURL;
    audio.playbackRate = 1;
    current = s; curKind = 'song';
    setNowUI(s.title, s.artist || '未知歌手', s.pic || null, 'song');
    audio.play().catch(() => updatePlayUI());
  }else{
    const { feed, ep } = ref;
    audio.src = ep.url;
    audio.playbackRate = rate;
    current = { feed, ep }; curKind = 'ep';
    setNowUI(ep.title, feed.title, feed.cover || null, 'ep');
    const saved = positions[posKey(feed.id, ep.guid)];
    const target = (saved && saved.pos > 12 && (!saved.dur || saved.pos < saved.dur - 20)) ? Math.max(0, saved.pos - 3) : 0;
    const seekOnce = () => { if(target) try{ audio.currentTime = target; }catch(e){} };
    audio.addEventListener('loadedmetadata', seekOnce, { once: true });
    audio.play().catch(() => updatePlayUI());
    if(target) toast('从 ' + fmt(target) + ' 继续播放');
  }
  renderSongs(); renderEps();
  updatePlayUI();
}

function startQueue(items, index){
  queue = items; qIndex = index;
  playItem(queue[qIndex]);
}
function pickNextIndex(dir){
  if(!queue.length) return -1;
  if(curKind === 'song' && shuffle && queue.length > 1){
    let n; do{ n = Math.floor(Math.random() * queue.length); }while(n === qIndex);
    return n;
  }
  const n = qIndex + dir;
  if(n < 0) return queue.length - 1;
  if(n >= queue.length) return (curKind === 'song') ? 0 : -1;
  return n;
}
function next(auto){
  if(curKind === 'ep'){
    const n = qIndex + 1;
    if(n < queue.length){ qIndex = n; playItem(queue[n]); }
    else if(!auto) toast('已经是最后一集');
    else updatePlayUI();
    return;
  }
  const n = pickNextIndex(1);
  if(n >= 0){ qIndex = n; playItem(queue[n]); }
}
function prev(){
  if(audio.currentTime > 4){ audio.currentTime = 0; return; }
  const n = pickNextIndex(-1);
  if(n >= 0){ qIndex = n; playItem(queue[n]); }
}
function togglePlay(){
  if(!current){
    if(songs.length) playAllSongs(false);
    return;
  }
  if(audio.paused) audio.play().catch(() => {});
  else audio.pause();
}
function skip(by){
  if(!current) return;
  const d = isFinite(audio.duration) ? audio.duration : Infinity;
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + by), d);
}

audio.addEventListener('ended', () => {
  if(curKind === 'song'){
    if(repeat === 2){ audio.currentTime = 0; audio.play().catch(() => {}); return; }
    if(shuffle || repeat === 1 || qIndex < queue.length - 1) next(true);
    else updatePlayUI();
  }else{
    markPlayed();
    next(true);
  }
});
audio.addEventListener('play', updatePlayUI);
audio.addEventListener('pause', () => { updatePlayUI(); savePosNow(); });
audio.addEventListener('error', () => {
  if(current) toast(curKind === 'ep' ? '这一集加载失败，可能需要网络' : '无法播放这个文件');
  updatePlayUI();
});
audio.addEventListener('loadedmetadata', () => {
  $('#nowDur').textContent = fmt(audio.duration);
  if(curKind === 'song' && current && !current.dur && isFinite(audio.duration)){
    current.dur = audio.duration; S.put('songs', current); renderSongs();
  }
});

let lastPosSave = 0;
audio.addEventListener('timeupdate', () => {
  const dur = audio.duration;
  if(!seeking && isFinite(dur) && dur > 0){
    const p = audio.currentTime / dur;
    const bar = $('#nowSeek');
    bar.value = Math.round(p * 1000);
    bar.style.setProperty('--p', (p * 100) + '%');
    $('#nowCur').textContent = fmt(audio.currentTime);
    $('#miniProg').style.width = (p * 100) + '%';
    $('#driveProgFill').style.width = (p * 100) + '%';
  }
  if(curKind === 'ep' && Date.now() - lastPosSave > 5000){ lastPosSave = Date.now(); savePosNow(); }
  try{
    if('mediaSession' in navigator && isFinite(dur) && dur > 0)
      navigator.mediaSession.setPositionState({ duration: dur, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, dur) });
  }catch(e){}
});

function savePosNow(){
  if(curKind !== 'ep' || !current) return;
  const key = posKey(current.feed.id, current.ep.guid);
  const rec = { key, pos: audio.currentTime || 0, dur: audio.duration || positions[key]?.dur || 0,
                played: positions[key]?.played || false, updatedAt: Date.now() };
  positions[key] = rec;
  S.put('positions', rec);
}
function markPlayed(){
  if(curKind !== 'ep' || !current) return;
  const key = posKey(current.feed.id, current.ep.guid);
  const rec = { key, pos: 0, dur: audio.duration || 0, played: true, updatedAt: Date.now() };
  positions[key] = rec;
  S.put('positions', rec);
  renderEps();
}

/* ---------- Media Session（锁屏 / 蓝牙方向盘控制） ---------- */
function setMediaSession(title, sub, artURL){
  try{
    if(!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist: sub, album: curKind === 'ep' ? sub : 'Taste',
      artwork: artURL ? [{ src: artURL, sizes: '512x512' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    if(curKind === 'song'){
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    }else{
      navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15));
      navigator.mediaSession.setActionHandler('seekforward', () => skip(30));
      navigator.mediaSession.setActionHandler('previoustrack', () => skip(-15));
      navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    }
    navigator.mediaSession.setActionHandler('seekto', d => { if(d.seekTime != null) audio.currentTime = d.seekTime; });
  }catch(e){}
}

/* ================= 正在播放 UI ================= */
function setNowUI(title, sub, pic, kind){
  $('#nowTitle').textContent = title;
  $('#nowSub').textContent = sub;
  $('#miniTitle').textContent = title;
  $('#miniSub').textContent = sub;
  $('#driveTitle').textContent = title;
  $('#driveSub').textContent = sub;
  $('#nowSrc').textContent = kind === 'ep' ? 'PODCAST' : 'NOW PLAYING';
  $('#ctlMusic').hidden = kind === 'ep';
  $('#ctlPod').hidden = kind !== 'ep';
  $('#nowLike').hidden = kind === 'ep';
  $$('.d-music').forEach(el => el.toggleAttribute('hidden', kind === 'ep'));
  $$('.d-pod').forEach(el => el.toggleAttribute('hidden', kind !== 'ep'));
  $('#mini').hidden = false;

  if(curArtURL){ URL.revokeObjectURL(curArtURL); curArtURL = null; }
  let artURL = null;
  if(pic instanceof Blob){ try{ curArtURL = URL.createObjectURL(pic); artURL = curArtURL; }catch(e){} }
  else if(typeof pic === 'string' && pic) artURL = pic;

  const nowArt = $('#nowArt'), miniArt = $('#miniArt');
  if(artURL){
    nowArt.src = artURL; nowArt.hidden = false; $('#nowArtFb').hidden = true;
    miniArt.src = artURL; miniArt.hidden = false; $('#miniArtFb').hidden = true;
    nowArt.onerror = miniArt.onerror = () => {
      nowArt.hidden = true; $('#nowArtFb').hidden = false;
      miniArt.hidden = true; $('#miniArtFb').hidden = false;
    };
    extractColor(pic).then(setGlow);
  }else{
    nowArt.hidden = true; $('#nowArtFb').hidden = false;
    miniArt.hidden = true; $('#miniArtFb').hidden = false;
    setGlow(null);
  }
  $('#nowLike').classList.toggle('liked', !!(kind === 'song' && current && current.liked));
  setMediaSession(title, sub, artURL);
  document.title = title + ' · Taste';
}
function updatePlayUI(){
  const playing = current && !audio.paused;
  /* 注意：这些图标是 SVG，.hidden 属性对 SVG 无效，必须用 toggleAttribute */
  $$('.i-play').forEach(el => el.toggleAttribute('hidden', !!playing));
  $$('.i-pause').forEach(el => el.toggleAttribute('hidden', !playing));
  $$('.song.active').forEach(r => r.classList.toggle('playing', !!playing));
  $('#turntable').classList.toggle('playing', !!playing);   // 唱片旋转 + 唱臂落下
  try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; }catch(e){}
}

const nowSeek = $('#nowSeek');
nowSeek.addEventListener('input', () => {
  seeking = true;
  const p = nowSeek.value / 1000;
  nowSeek.style.setProperty('--p', (p * 100) + '%');
  if(isFinite(audio.duration)) $('#nowCur').textContent = fmt(p * audio.duration);
});
nowSeek.addEventListener('change', () => {
  if(isFinite(audio.duration)) audio.currentTime = (nowSeek.value / 1000) * audio.duration;
  seeking = false;
});
const nowVol = $('#nowVol');
function applyVolume(v){
  audio.volume = v / 100;
  nowVol.value = v;
  nowVol.style.setProperty('--p', v + '%');
}
nowVol.addEventListener('input', () => { applyVolume(+nowVol.value); ls.set('vol', +nowVol.value); });

$('#nowPlay').addEventListener('click', togglePlay);
$('#nowPlayPod').addEventListener('click', togglePlay);
$('#miniPlay').addEventListener('click', e => { e.stopPropagation(); togglePlay(); });
$('#miniNext').addEventListener('click', e => { e.stopPropagation(); next(false); });
$('#nowPrev').addEventListener('click', prev);
$('#nowNext').addEventListener('click', () => next(false));
$('#nowBack15').addEventListener('click', () => skip(-15));
$('#nowFwd30').addEventListener('click', () => skip(30));
$('#nowNextEp').addEventListener('click', () => next(false));
$('#nowShuffle').addEventListener('click', () => {
  shuffle = !shuffle; ls.set('shuffle', shuffle);
  $('#nowShuffle').classList.toggle('toggled', shuffle);
  toast(shuffle ? '随机播放：开' : '随机播放：关');
});
$('#nowRepeat').addEventListener('click', () => {
  repeat = (repeat + 1) % 3; ls.set('repeat', repeat);
  applyRepeatUI();
  toast(['循环：关', '循环：全部', '单曲循环'][repeat]);
});
function applyRepeatUI(){
  const b = $('#nowRepeat');
  b.classList.toggle('toggled', repeat > 0);
  b.classList.toggle('rep1', repeat === 2);
}
const RATES = [1, 1.25, 1.5, 2, 0.75];
function cycleRate(){
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  ls.set('rate', rate);
  if(curKind === 'ep') audio.playbackRate = rate;
  $('#nowRate').textContent = rate.toFixed(rate === 1.25 ? 2 : 1) + '×';
  $('#rateBtn').textContent = rate.toFixed(rate === 1.25 ? 2 : 1) + '×';
}
$('#nowRate').addEventListener('click', cycleRate);
$('#rateBtn').addEventListener('click', cycleRate);
$('#nowLike').addEventListener('click', () => {
  if(curKind !== 'song' || !current) return;
  current.liked = !current.liked;
  S.put('songs', current);
  $('#nowLike').classList.toggle('liked', current.liked);
  renderSongs();
});

/* 打开 / 关闭正在播放 */
$('#mini').addEventListener('click', () => { $('#nowSheet').hidden = false; });
$('#nowClose').addEventListener('click', () => { $('#nowSheet').hidden = true; });

/* ================= 音乐库 ================= */
/* 分类 */
const CATS = [
  { id: 'piano',     name: '钢琴曲' },
  { id: 'classical', name: '古典' },
  { id: 'country',   name: '乡村 Country' },
  { id: 'pop',       name: '流行' },
  { id: 'none',      name: '未分类' }
];
const catName = id => (CATS.find(c => c.id === id) || CATS[CATS.length - 1]).name;
/* 根据音乐文件自带的流派标签 / 文件名猜一个分类 */
function guessCat(meta, fileName){
  const g = ((meta.genre || '') + ' ' + (meta.title || '') + ' ' + (meta.album || '') + ' ' + fileName).toLowerCase();
  if(/piano|钢琴/.test(g)) return 'piano';
  if(/classic|古典|baroque|sympho|orchestr|concerto|sonata|violin|小提琴|大提琴|chopin|mozart|beethoven|bach|debussy|肖邦|莫扎特|贝多芬|巴赫/.test(g)) return 'classical';
  if(/country|乡村|bluegrass|folk/.test(g)) return 'country';
  if(/pop|流行|rock|r&b|hip.?hop|rap|dance|electro|摇滚/.test(g)) return 'pop';
  return 'none';
}
function readTags(file){
  return new Promise(resolve => {
    const fallback = () => {
      let base = file.name.replace(/\.[^.]+$/, '');
      let artist = '', title = base;
      const m = base.split(' - ');
      if(m.length >= 2){ artist = m[0].trim(); title = m.slice(1).join(' - ').trim(); }
      resolve({ title: title || file.name, artist, album: '', genre: '', pic: null });
    };
    if(!window.jsmediatags) return fallback();
    let done = false;
    const timer = setTimeout(() => { if(!done){ done = true; fallback(); } }, 5000);
    try{
      window.jsmediatags.read(file, {
        onSuccess(res){
          if(done) return; done = true; clearTimeout(timer);
          const tg = res.tags || {};
          let pic = null;
          if(tg.picture && tg.picture.data){
            try{ pic = new Blob([new Uint8Array(tg.picture.data)], { type: tg.picture.format || 'image/jpeg' }); }catch(e){}
          }
          const base = file.name.replace(/\.[^.]+$/, '');
          resolve({ title: (tg.title || '').trim() || base, artist: (tg.artist || '').trim(),
                    album: (tg.album || '').trim(), genre: (tg.genre || '').trim(), pic });
        },
        onError(){ if(!done){ done = true; clearTimeout(timer); fallback(); } }
      });
    }catch(e){ if(!done){ done = true; clearTimeout(timer); fallback(); } }
  });
}
function probeDuration(blob){
  return new Promise(resolve => {
    let u;
    try{ u = URL.createObjectURL(blob); }catch(e){ return resolve(0); }
    const a = new Audio();
    a.preload = 'metadata';
    const fin = d => { URL.revokeObjectURL(u); resolve(d); };
    a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => fin(0);
    a.src = u;
  });
}
async function addFiles(fileList){
  const files = [...fileList].filter(f =>
    (f.type && f.type.startsWith('audio')) || /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm)$/i.test(f.name));
  if(!files.length){ toast('没有检测到音频文件'); return; }
  toast('正在导入 ' + files.length + ' 个文件…');
  for(const f of files){
    const meta = await readTags(f);
    const t = { id: uid(), title: meta.title, artist: meta.artist, album: meta.album,
                cat: guessCat(meta, f.name),
                pic: meta.pic, blob: f, dur: 0, liked: false, addedAt: Date.now() };
    songs.push(t);
    S.put('songs', t);
    probeDuration(f).then(d => { if(d){ t.dur = d; S.put('songs', t); renderSongs(); } });
  }
  renderSongs();
  toast('已添加 ' + files.length + ' 首歌曲');
}
function visibleSongs(){
  return songs.filter(s => {
    if(musicFilter === 'all') return true;
    if(musicFilter === 'liked') return !!s.liked;
    return (s.cat || 'none') === musicFilter;
  });
}
const coverURLs = new Map();   // songId -> objectURL（缩略图缓存）
function coverURL(s){
  if(!s.pic) return null;
  if(!coverURLs.has(s.id)){
    try{ coverURLs.set(s.id, URL.createObjectURL(s.pic)); }catch(e){ return null; }
  }
  return coverURLs.get(s.id);
}
function renderSongs(){
  const ul = $('#songList');
  ul.textContent = '';
  const list = visibleSongs();
  for(const s of list){
    const li = document.createElement('li');
    li.className = 'song' + (current === s ? ' active' + (!audio.paused ? ' playing' : '') : '');
    const cov = document.createElement('div');
    cov.className = 'song-cover';
    const u = coverURL(s);
    if(u){ const im = document.createElement('img'); im.alt = ''; im.src = u; cov.appendChild(im); }
    else cov.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
    if(current === s){
      const eq = document.createElement('span');
      eq.className = 'eq';
      eq.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      cov.appendChild(eq);
    }
    const tt = document.createElement('div');
    tt.className = 'song-tt';
    const nm = document.createElement('span'); nm.className = 'song-name'; nm.textContent = s.title;
    const sb = document.createElement('span'); sb.className = 'song-sub';
    sb.textContent = [s.artist || '未知歌手', (s.cat && s.cat !== 'none') ? catName(s.cat) : ''].filter(Boolean).join(' · ');
    tt.append(nm, sb);
    const du = document.createElement('span'); du.className = 'song-dur'; du.textContent = s.dur ? fmt(s.dur) : '--:--';
    const like = document.createElement('button');
    like.className = 'song-like' + (s.liked ? ' liked' : '');
    like.setAttribute('aria-label', '喜欢');
    like.innerHTML = s.liked
      ? '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>';
    like.addEventListener('click', e => {
      e.stopPropagation();
      s.liked = !s.liked; S.put('songs', s); renderSongs();
      if(current === s) $('#nowLike').classList.toggle('liked', s.liked);
    });
    const more = document.createElement('button');
    more.className = 'song-more';
    more.setAttribute('aria-label', s.title + ' 的分类与删除');
    more.title = '分类 / 删除';
    more.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
    more.addEventListener('click', e => { e.stopPropagation(); openSongMenu(s); });
    li.append(cov, tt, du, like, more);
    li.addEventListener('click', () => {
      const items = visibleSongs().map(x => ({ kind: 'song', id: x.id }));
      startQueue(items, items.findIndex(x => x.id === s.id));
    });
    ul.appendChild(li);
  }
  const total = songs.reduce((a, s) => a + (s.dur || 0), 0);
  $('#musicStat').textContent = songs.length + ' 首歌曲' + (total ? ' · 共 ' + fmt(total) : '');
  $('#musicEmpty').hidden = songs.length > 0;
  $('#musicStat').hidden = songs.length === 0;
}
function removeSong(s){
  const i = songs.indexOf(s);
  if(i < 0) return;
  songs.splice(i, 1);
  S.del('songs', s.id);
  if(coverURLs.has(s.id)){ URL.revokeObjectURL(coverURLs.get(s.id)); coverURLs.delete(s.id); }
  if(current === s){
    audio.pause(); audio.removeAttribute('src'); audio.load();
    current = null; curKind = null;
    $('#mini').hidden = true; $('#nowSheet').hidden = true;
  }
  renderSongs();
  toast('已删除');
}
/* 底部操作菜单：分类 + 删除 */
const sheetMask = $('#sheetMask');
sheetMask.addEventListener('click', e => { if(e.target === sheetMask) sheetMask.hidden = true; });
function openSongMenu(s){
  const sheet = $('#actionSheet');
  sheet.textContent = '';
  const title = document.createElement('div');
  title.className = 'as-title';
  title.textContent = s.title + ' · 选择分类';
  sheet.appendChild(title);
  for(const c of CATS){
    const b = document.createElement('button');
    b.className = 'as-item';
    const label = document.createElement('span');
    label.textContent = c.name;
    b.appendChild(label);
    if((s.cat || 'none') === c.id){
      const ck = document.createElement('span');
      ck.className = 'check';
      ck.textContent = '✓';
      b.appendChild(ck);
    }
    b.addEventListener('click', () => {
      s.cat = c.id;
      S.put('songs', s);
      sheetMask.hidden = true;
      renderSongs();
      toast('已归入「' + c.name + '」');
    });
    sheet.appendChild(b);
  }
  const sep = document.createElement('div');
  sep.className = 'as-sep';
  sheet.appendChild(sep);
  const del = document.createElement('button');
  del.className = 'as-item danger';
  del.textContent = '删除这首歌';
  del.addEventListener('click', () => { sheetMask.hidden = true; removeSong(s); });
  sheet.appendChild(del);
  sheetMask.hidden = false;
}
function playAllSongs(shuffled){
  const list = visibleSongs();
  if(!list.length){ toast('先添加一些音乐吧'); return; }
  if(shuffled && !shuffle){ shuffle = true; ls.set('shuffle', shuffle); $('#nowShuffle').classList.add('toggled'); }
  const items = list.map(x => ({ kind: 'song', id: x.id }));
  startQueue(items, shuffled ? Math.floor(Math.random() * items.length) : 0);
}
$('#musicAddBtn').addEventListener('click', () => $('#filePick').click());
$('#emptyAddBtn').addEventListener('click', () => $('#filePick').click());
$('#filePick').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
$('#playAllBtn').addEventListener('click', () => playAllSongs(false));
$('#shuffleAllBtn').addEventListener('click', () => playAllSongs(true));
$$('.chip[data-mfilter]').forEach(c => c.addEventListener('click', () => {
  musicFilter = c.dataset.mfilter;
  $$('.chip[data-mfilter]').forEach(x => x.classList.toggle('on', x === c));
  renderSongs();
}));
/* 桌面拖放 */
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('dragleave', e => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); });
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0;
  if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

/* ================= 播客 ================= */
/* 跨域抓取：直连 → 两个公共代理，依次尝试 */
const PROXIES = [
  u => u,
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)
];
async function fetchX(url, asJSON){
  let lastErr = null;
  for(const wrap of PROXIES){
    try{
      const r = await fetch(wrap(url), { signal: AbortSignal.timeout(14000) });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return asJSON ? await r.json() : await r.text();
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('网络请求失败');
}
function parseDur(s){
  if(!s) return 0;
  s = String(s).trim();
  if(/^\d+$/.test(s)) return +s;
  const p = s.split(':').map(Number);
  if(p.some(isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}
function stripHTML(h){
  const d = document.createElement('div');
  d.innerHTML = h || '';
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}
function parseRSS(xmlText, feedUrl){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if(doc.querySelector('parsererror')) throw new Error('RSS 解析失败');
  const ch = doc.querySelector('channel');
  if(!ch) throw new Error('不是有效的播客 RSS');
  const pick = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent.trim() : ''; };
  const itunesAttr = (el, name) => {
    for(const n of el.children){ if(n.localName === name && n.getAttribute('href')) return n.getAttribute('href'); }
    return '';
  };
  let cover = itunesAttr(ch, 'image') || pick(ch, 'image > url');
  const eps = [];
  for(const it of ch.querySelectorAll('item')){
    const enc = it.querySelector('enclosure');
    const url = enc ? enc.getAttribute('url') : '';
    if(!url) continue;
    let durText = '';
    for(const n of it.children){ if(n.localName === 'duration'){ durText = n.textContent.trim(); break; } }
    eps.push({
      guid: pick(it, 'guid') || url,
      title: pick(it, 'title') || '未命名单集',
      url,
      date: Date.parse(pick(it, 'pubDate')) || 0,
      dur: parseDur(durText),
      desc: stripHTML(pick(it, 'description')).slice(0, 300)
    });
    if(eps.length >= 300) break;
  }
  eps.sort((a, b) => b.date - a.date);
  return {
    title: pick(ch, 'title') || '未命名播客',
    author: (() => { for(const n of ch.children){ if(n.localName === 'author') return n.textContent.trim(); } return ''; })(),
    desc: stripHTML(pick(ch, 'description')).slice(0, 500),
    cover, eps, url: feedUrl
  };
}
async function addFeedByUrl(feedUrl, silent){
  const id = 'f' + feedUrl.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
  if(feeds.some(f => f.id === id)){ if(!silent) toast('已经订阅过这个播客了'); return feeds.find(f => f.id === id); }
  toast('正在获取节目信息…');
  try{
    const xml = await fetchX(feedUrl, false);
    const meta = parseRSS(xml, feedUrl);
    const feed = { id, url: feedUrl, title: meta.title, author: meta.author, desc: meta.desc,
                   cover: meta.cover, eps: meta.eps, lastFetch: Date.now(), addedAt: Date.now() };
    feeds.unshift(feed);
    S.put('feeds', feed);
    renderSubs();
    toast('已订阅「' + meta.title + '」');
    return feed;
  }catch(e){
    toast('获取失败：' + (e.message || '请检查链接或网络'));
    return null;
  }
}
async function refreshFeed(feed){
  try{
    const xml = await fetchX(feed.url, false);
    const meta = parseRSS(xml, feed.url);
    feed.title = meta.title; feed.author = meta.author; feed.desc = meta.desc;
    feed.cover = meta.cover || feed.cover; feed.eps = meta.eps; feed.lastFetch = Date.now();
    S.put('feeds', feed);
    renderSubs(); renderEps();
    return true;
  }catch(e){ return false; }
}
/* iTunes 搜索 */
let searchTimer = null, searchSeq = 0;
$('#podSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('#podSearch').value.trim();
  if(!q){ $('#podSearchResults').hidden = true; return; }
  searchTimer = setTimeout(() => searchPodcasts(q), 450);
});
$('#podSearch').addEventListener('keydown', e => {
  if(e.key === 'Enter'){ clearTimeout(searchTimer); searchPodcasts($('#podSearch').value.trim()); }
});
async function searchPodcasts(q){
  if(!q) return;
  const seq = ++searchSeq;
  const box = $('#podSearchResults');
  box.hidden = false;
  box.innerHTML = '<div class="pod-loading">正在搜索…</div>';
  try{
    const data = await fetchX('https://itunes.apple.com/search?media=podcast&limit=18&term=' + encodeURIComponent(q), true);
    if(seq !== searchSeq) return;
    const hits = (data.results || []).filter(r => r.feedUrl);
    if(!hits.length){ box.innerHTML = '<div class="pod-loading">没有找到相关播客，试试别的关键词，或用 RSS 链接添加</div>'; return; }
    box.textContent = '';
    for(const r of hits){
      const row = document.createElement('div');
      row.className = 'pod-hit';
      const im = document.createElement('img');
      im.alt = ''; im.loading = 'lazy'; im.src = r.artworkUrl100 || r.artworkUrl60 || '';
      im.onerror = () => { im.removeAttribute('src'); };
      const tt = document.createElement('div');
      tt.className = 'tt';
      const b = document.createElement('b'); b.textContent = r.collectionName || '未命名';
      const sp = document.createElement('span'); sp.textContent = r.artistName || '';
      tt.append(b, sp);
      const btn = document.createElement('button');
      const subbed = feeds.some(f => f.url === r.feedUrl);
      btn.className = 'pill-btn sm-btn' + (subbed ? ' ghost' : '');
      btn.textContent = subbed ? '已订阅' : '订阅';
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        btn.textContent = '…';
        const f = await addFeedByUrl(r.feedUrl, false);
        btn.textContent = f ? '已订阅' : '订阅';
        btn.classList.toggle('ghost', !!f);
      });
      row.append(im, tt, btn);
      row.addEventListener('click', async () => {
        const f = feeds.find(x => x.url === r.feedUrl) || await addFeedByUrl(r.feedUrl, true);
        if(f) openShow(f.id);
      });
      box.appendChild(row);
    }
  }catch(e){
    if(seq !== searchSeq) return;
    box.innerHTML = '<div class="pod-loading">搜索失败，请检查网络后重试</div>';
  }
}
$('#podRssBtn').addEventListener('click', async () => {
  const u = window.prompt ? prompt('粘贴播客的 RSS 链接：') : null;
  if(u && /^https?:\/\//i.test(u.trim())) addFeedByUrl(u.trim(), false);
  else if(u) toast('链接格式不对，应以 http 开头');
});
function renderSubs(){
  const grid = $('#subGrid');
  grid.textContent = '';
  for(const f of feeds){
    const card = document.createElement('button');
    card.className = 'sub-card';
    const im = document.createElement('img');
    im.alt = ''; im.loading = 'lazy';
    im.onerror = () => im.removeAttribute('src');
    if(f.cover) im.src = f.cover;
    const b = document.createElement('b'); b.textContent = f.title;
    card.append(im, b);
    card.addEventListener('click', () => openShow(f.id));
    grid.appendChild(card);
  }
  $('#podEmpty').hidden = feeds.length > 0;
  $('#subTitle').hidden = feeds.length === 0;
}
/* 节目详情 */
function openShow(feedId){
  const f = feeds.find(x => x.id === feedId);
  if(!f) return;
  openShowId = feedId;
  $('#showHeadTitle').textContent = f.title;
  $('#showTitle').textContent = f.title;
  $('#showAuthor').textContent = f.author || '';
  $('#showDesc').textContent = f.desc || '';
  const cov = $('#showCover');
  cov.onerror = () => cov.removeAttribute('src');
  if(f.cover){ cov.src = f.cover; cov.hidden = false; } else cov.hidden = true;
  renderEps();
  $('#showSheet').hidden = false;
  if(Date.now() - (f.lastFetch || 0) > 3600000) refreshFeed(f);
}
function renderEps(){
  if(!openShowId) return;
  const f = feeds.find(x => x.id === openShowId);
  if(!f) return;
  const ul = $('#epList');
  ul.textContent = '';
  $('#epCount').textContent = (f.eps || []).length + ' 集';
  (f.eps || []).forEach((ep, i) => {
    const li = document.createElement('li');
    const isCur = curKind === 'ep' && current && current.feed.id === f.id && current.ep.guid === ep.guid;
    const st = positions[posKey(f.id, ep.guid)];
    li.className = 'ep' + (isCur ? ' active' : '') + (st && st.played ? ' played' : '');
    const top = document.createElement('div');
    top.className = 'ep-top';
    const ti = document.createElement('span'); ti.className = 'ep-title'; ti.textContent = ep.title;
    top.appendChild(ti);
    const foot = document.createElement('div');
    foot.className = 'ep-foot';
    const dt = document.createElement('span'); dt.textContent = fmtDate(ep.date);
    const du = document.createElement('span'); du.className = 'mono';
    du.textContent = ep.dur ? fmt(ep.dur) : '';
    foot.append(dt, du);
    if(st && st.played){
      const ck = document.createElement('span'); ck.className = 'ep-check'; ck.textContent = '✓ 已听完';
      foot.appendChild(ck);
    }else if(st && st.pos > 12 && st.dur){
      const pr = document.createElement('span'); pr.className = 'ep-prog';
      const fill = document.createElement('i'); fill.style.width = Math.min(100, st.pos / st.dur * 100) + '%';
      pr.appendChild(fill);
      const left = document.createElement('span');
      left.textContent = '剩 ' + fmt(Math.max(0, st.dur - st.pos));
      foot.append(pr, left);
    }
    li.append(top, foot);
    li.addEventListener('click', () => {
      const items = f.eps.map(e => ({ kind: 'ep', feedId: f.id, guid: e.guid }));
      startQueue(items, i);
    });
    ul.appendChild(li);
  });
}
$('#showBack').addEventListener('click', () => { $('#showSheet').hidden = true; openShowId = null; });
$('#showRefresh').addEventListener('click', async () => {
  const f = feeds.find(x => x.id === openShowId);
  if(!f) return;
  toast('正在刷新…');
  (await refreshFeed(f)) ? toast('已更新') : toast('刷新失败，请稍后再试');
});
$('#showUnsub').addEventListener('click', () => {
  const f = feeds.find(x => x.id === openShowId);
  if(!f) return;
  const btn = $('#showUnsub');
  if(btn.dataset.armed){
    feeds = feeds.filter(x => x !== f);
    S.del('feeds', f.id);
    delete btn.dataset.armed;
    $('#showSheet').hidden = true; openShowId = null;
    renderSubs();
    toast('已取消订阅「' + f.title + '」');
    return;
  }
  btn.dataset.armed = '1';
  toast('再点一次取消订阅');
  setTimeout(() => delete btn.dataset.armed, 3000);
});

/* ================= 驾驶模式 ================= */
let wakeLock = null;
async function acquireWakeLock(){
  try{ if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }catch(e){}
}
function releaseWakeLock(){
  try{ if(wakeLock){ wakeLock.release(); wakeLock = null; } }catch(e){}
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && !$('#drive').hidden) acquireWakeLock();
});
let clockTimer = null;
function openDrive(){
  $('#drive').hidden = false;
  acquireWakeLock();
  const tick = () => {
    const d = new Date();
    $('#driveClock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  tick();
  clockTimer = setInterval(tick, 10000);
}
function closeDrive(){
  $('#drive').hidden = true;
  releaseWakeLock();
  clearInterval(clockTimer);
}
$('#nowDrive').addEventListener('click', openDrive);
$('#setDriveBtn').addEventListener('click', openDrive);
$('#driveExit').addEventListener('click', closeDrive);
$('#drivePlay').addEventListener('click', togglePlay);
$('#drivePrev').addEventListener('click', () => curKind === 'ep' ? skip(-15) : prev());
$('#driveNext').addEventListener('click', () => curKind === 'ep' ? skip(30) : next(false));

/* ================= 标签页与设置 ================= */
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('on', x === t));
  const v = t.dataset.view;
  $('#view-music').hidden = v !== 'music';
  $('#view-podcast').hidden = v !== 'podcast';
  $('#view-settings').hidden = v !== 'settings';
  ls.set('tab', v);
  window.scrollTo(0, 0);
}));
function switchTab(v){
  const t = $$('.tab').find(x => x.dataset.view === v);
  if(t) t.click();
}

/* 主题 */
const lightMedia = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme(){
  const mode = ls.get('theme', 'auto');
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  root.classList.remove('theme-light');
  if(mode === 'light') root.setAttribute('data-theme', 'light');
  else if(mode === 'auto' && lightMedia.matches) root.classList.add('theme-light');
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.themePick === mode));
  try{
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]').setAttribute('content', bg || '#0a0c12');
  }catch(e){}
}
$$('#themeSeg button').forEach(b => b.addEventListener('click', () => {
  ls.set('theme', b.dataset.themePick);
  applyTheme();
}));
lightMedia.addEventListener('change', applyTheme);

/* 清空数据 */
armConfirm($('#wipeBtn'), '清空', '确认清空？', async () => {
  audio.pause();
  await S.clear('songs'); await S.clear('feeds'); await S.clear('positions');
  try{ localStorage.clear(); }catch(e){}
  location.reload();
});

/* 快捷键（桌面） */
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if(e.key === ' '){ e.preventDefault(); togglePlay(); }
  else if(e.key === 'ArrowRight' && current){ e.preventDefault(); skip(curKind === 'ep' ? 30 : 5); }
  else if(e.key === 'ArrowLeft' && current){ e.preventDefault(); skip(curKind === 'ep' ? -15 : -5); }
});

/* 离开页面前保存进度 */
window.addEventListener('pagehide', savePosNow);

/* ================= 启动 ================= */
async function init(){
  applyTheme();
  applyVolume(ls.get('vol', 80));
  $('#nowShuffle').classList.toggle('toggled', shuffle);
  applyRepeatUI();
  if(!RATES.includes(rate)) rate = 1;
  $('#nowRate').textContent = rate.toFixed(rate === 1.25 ? 2 : 1) + '×';
  $('#rateBtn').textContent = rate.toFixed(rate === 1.25 ? 2 : 1) + '×';

  try{
    db = await idbOpen();
    const [sv, fv, pv] = await Promise.all([S.all('songs'), S.all('feeds'), S.all('positions')]);
    songs = (sv || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    songs.forEach(s => { if(!s.cat) s.cat = 'none'; });   // 老数据补上分类字段
    feeds = (fv || []).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    positions = {};
    (pv || []).forEach(p => positions[p.key] = p);
  }catch(e){ db = null; }

  renderSongs();
  renderSubs();
  switchTab(ls.get('tab', 'music'));

  if('serviceWorker' in navigator){
    try{ navigator.serviceWorker.register('sw.js'); }catch(e){}
  }
}
init();
})();
