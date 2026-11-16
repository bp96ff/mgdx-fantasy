// The app's service worker: shows push notifications, and keeps a copy of the pages and data last seen so the
// app still opens without a signal, and opens faster: versioned files and images come from the saved copy.
// Change CACHE to throw away every saved copy.
const CACHE = 'mgdx-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same-site GET requests only (not ESPN, Supabase or GIPHY):
//   - files with a ?v= version (scripts, styles, icons): the saved copy if there is one, since a new
//     version comes with a new ?v=;
//   - images: the saved copy at once, refreshed in the background for next time;
//   - everything else (pages, data): network first, the saved copy when offline.
const isImage = (url) => /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname);

async function save(cache, req, res) {
  if (!res.ok || res.type !== 'basic') return;
  const url = new URL(req.url);
  // One copy per file: drop older ?v= versions of the same path.
  const keys = await cache.keys();
  await Promise.all(keys.filter((k) => { const u = new URL(k.url); return u.pathname === url.pathname && u.search !== url.search; })
    .map((k) => cache.delete(k)));
  await cache.put(req, res);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Pages are never served this way, even with ?v= in their address.
  const page = req.mode === 'navigate' || /(\/|\.html?)$/i.test(url.pathname);
  const versioned = !page && url.searchParams.has('v');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (versioned || (!page && isImage(url))) {
      const hit = await cache.match(req);
      if (hit) {
        if (!versioned) e.waitUntil(fetch(req.url, { cache: 'no-cache' }).then((res) => save(cache, req, res)).catch(() => {}));
        return hit;
      }
    }
    try {
      const res = await fetch(req);
      e.waitUntil(save(cache, req, res.clone()));
      return res;
    } catch (err) {
      const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true })
        || (req.mode === 'navigate' ? await cache.match('./', { ignoreSearch: true }) || await cache.match('./index.html', { ignoreSearch: true }) : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

// A notification from the push function: { title, body, url, tag }.
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Microgen Fantasy Football', {
    body: msg.body || '',
    icon: 'assets/img/app/icon-192.png',
    badge: 'assets/img/app/badge-96.png',
    tag: msg.tag || undefined,
    data: { url: msg.url || './#/home' },
  }));
});

// Tapping one opens its page, in the app's window when it's already open.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || './#/home', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      return win.navigate(target).catch(() => win.postMessage({ type: 'open', url: target }));
    }
    return self.clients.openWindow(target);
  })());
});
