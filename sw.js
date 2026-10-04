/* Taste service worker — 应用外壳离线可用；音频与 RSS 始终走网络 */
const VERSION = 'taste-v8';
const CORE = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION && k !== VERSION + '-img' && k !== VERSION + '-static')
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // 音频流、RSS、代理请求：不缓存，直接走网络
  if(req.headers.has('range') || req.destination === 'audio') return;

  // 应用自身文件：网络优先，离线回退缓存
  if(url.origin === location.origin){
    e.respondWith(
      fetch(req).then(res => {
        if(res.ok){
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() =>
        caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
      )
    );
    return;
  }

  // 字体与库：缓存优先
  if(STATIC_HOSTS.includes(url.hostname)){
    e.respondWith(
      caches.open(VERSION + '-static').then(c =>
        c.match(req).then(hit => hit || fetch(req).then(res => {
          if(res.ok) c.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // 播客封面等图片：缓存优先（有上限）
  if(req.destination === 'image'){
    e.respondWith(
      caches.open(VERSION + '-img').then(async c => {
        const hit = await c.match(req);
        if(hit) return hit;
        try{
          const res = await fetch(req);
          if(res.ok){
            c.put(req, res.clone());
            c.keys().then(keys => { if(keys.length > 120) c.delete(keys[0]); });
          }
          return res;
        }catch(err){ return Response.error(); }
      })
    );
  }
  // 其余（RSS / 代理 / 搜索 API）：默认网络
});
