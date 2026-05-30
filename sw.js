// ══════════════════════════════════════════════════════════════════
// WE ARE DISCIPLINE — SERVICE WORKER v2.0
// Estrategia: Cache-first para assets, Network-first para datos
// ══════════════════════════════════════════════════════════════════

const CACHE_NAME = 'wad-v2';
const STATIC_CACHE = 'wad-static-v2';
const DATA_CACHE = 'wad-data-v2';

// Assets que se cachean en install (shell de la app)
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/food_db.json',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;600;700;800&display=swap',
];

// ── INSTALL: pre-cachear shell ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Pre-cache parcial:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: limpiar caches viejos ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== DATA_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: estrategia por tipo de request ──────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Supabase API → Network-first (datos siempre frescos)
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  // 2. Fonts de Google → Cache-first (nunca cambian)
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 3. App shell (index.html, assets) → Stale-while-revalidate
  if (request.destination === 'document' || url.pathname === '/') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 4. JSON estáticos (food_db.json) → Cache-first
  if (url.pathname.endsWith('.json') && !url.hostname.includes('supabase.co')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 5. Default: network con fallback a cache
  event.respondWith(networkFirstWithOfflineFallback(request));
});

// ── ESTRATEGIAS ─────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Offline fallback para navegación
    if (request.destination === 'document') {
      return caches.match('/index.html');
    }
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

// ── BACKGROUND SYNC: reintentar guardados fallidos ──────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-session') {
    event.waitUntil(syncPendingSessions());
  }
  if (event.tag === 'sync-biofeedback') {
    event.waitUntil(syncPendingBiofeedback());
  }
});

async function syncPendingSessions() {
  try {
    const db = await openOfflineDB();
    const pending = await getAllFromStore(db, 'pending_sessions');
    for (const item of pending) {
      try {
        await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body
        });
        await deleteFromStore(db, 'pending_sessions', item.id);
      } catch (err) {
        console.warn('[SW] Sync failed for session:', err);
      }
    }
  } catch (err) {
    console.warn('[SW] Background sync error:', err);
  }
}

async function syncPendingBiofeedback() {
  try {
    const db = await openOfflineDB();
    const pending = await getAllFromStore(db, 'pending_biofeedback');
    for (const item of pending) {
      try {
        await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body
        });
        await deleteFromStore(db, 'pending_biofeedback', item.id);
      } catch (err) {
        console.warn('[SW] BF sync failed:', err);
      }
    }
  } catch (err) {
    console.warn('[SW] BF sync error:', err);
  }
}

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'WE ARE DISCIPLINE', {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag || 'wad-notif',
      data: data.url || '/',
      actions: data.actions || [],
      vibrate: [200, 100, 200],
      requireInteraction: data.requireInteraction || false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── INDEXEDDB HELPER (para offline queue) ──────────────────────
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wad_offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending_sessions')) {
        db.createObjectStore('pending_sessions', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('pending_biofeedback')) {
        db.createObjectStore('pending_biofeedback', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteFromStore(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
