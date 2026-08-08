// ==========================================
// 1. FIREBASE MESSAGING (PUSH NOTIFICATIONS)
// ==========================================
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyAU84tnBHjJn30HU38aKDsfSEymkYiwNbA",
  authDomain: "mmmi-cooperative-portal.firebaseapp.com",
  projectId: "mmmi-cooperative-portal",
  storageBucket: "mmmi-cooperative-portal.firebasestorage.app",
  messagingSenderId: "178385913970",
  appId: "1:178385913970:web:efd0f4eefe2b3c36999aeb"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// SINGLE BACKGROUND PIPELINE (Strictly parses Data-Only payloads)
messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    
    const title = data.title || 'Cooperative Update';
    const body = data.body || '';
    const imageUrl = data.attachedImage || '';
    const forceDrawer = data.forceDrawer || 'false';
    const targetUrl = data.url || '/member/memberDashboard.html';

    const iconUrl = imageUrl ? (data.attachedIcon || '/assets/icon-192.png') : '/assets/icon-192.png';

    const notificationOptions = {
        body: body,
        icon: iconUrl,
        badge: '/assets/badge.png',
        data: data, // Passes URL directly into click handler
        vibrate: [200, 100, 200]
    };

    if (imageUrl) {
        notificationOptions.image = imageUrl;
    }

    return self.registration.showNotification(title, notificationOptions);
});

// INTERCEPT PHYSICAL CLICKS ON NOTIFICATIONS
self.addEventListener('notificationclick', (event) => {
    event.stopImmediatePropagation();
    event.notification.close();

    let targetUrl = '/member/memberDashboard.html';
    const dataObj = event.notification.data;
    
    if (dataObj && dataObj.url) {
        targetUrl = dataObj.url;
    }

    if (targetUrl.startsWith('/')) {
        targetUrl = self.location.origin + targetUrl;
    }

    const isExternal = targetUrl.startsWith('http') && !targetUrl.includes(self.location.origin);

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            if (isExternal) {
                return clients.openWindow(targetUrl);
            }

            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url && 'focus' in client) {
                    return client.focus().then((focusedClient) => {
                        if (focusedClient && focusedClient.navigate) {
                            return focusedClient.navigate(targetUrl);
                        }
                    });
                }
            }

            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

// ==========================================
// 2. OFFLINE CACHING
// ==========================================
const CACHE_NAME = 'offline-cache-v2';
const OFFLINE_ASSETS = [
  '/offline.html',
  '/assets/MMMi.svg',
  '/assets/cloud-offline.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // CRITICAL FIX: Bypass POST requests and Cloud Functions entirely to prevent Cache API crashes
  if (event.request.method !== 'GET' ||
      event.request.url.includes('firestore.googleapis.com') || 
      event.request.url.includes('googleapis.com') ||
      event.request.url.includes('cloudfunctions.net')) {
    return; 
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('offline.html'))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((response) => response || fetch(event.request))
    );
  }
});