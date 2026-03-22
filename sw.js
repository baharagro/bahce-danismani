const CACHE = 'bahce-v4';
const STATIC = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.svg',
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,700;1,9..144,300&family=DM+Sans:wght@300;400;500&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Kurulum — statik dosyaları önbelleğe al
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      return Promise.allSettled(STATIC.map(url => c.add(url).catch(()=>{})));
    }).then(() => self.skipWaiting())
  );
});

// Aktivasyon — eski önbellekleri temizle
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Fetch — Cache-First (statik), Network-First (API)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API istekleri → ağdan al, hata olursa offline mesajı
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error:'Çevrimdışı — internet bağlantısı yok.' }), {
          headers: { 'Content-Type':'application/json' }
        })
      )
    );
    return;
  }
  // Statik → önce cache, sonra ağ
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/'));
    })
  );
});
