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

// Handle Background Notifications
messaging.onBackgroundMessage((payload) => {
  console.log('[sw.js] Background Message:', payload);
  
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    image: payload.notification.image || null,
    data: payload.data || {},
    vibrate: [200, 100, 200]
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle Notification Clicks (Opens the App)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data.url || '/member/memberDashboard.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If tab is already open, focus it
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// ==========================================
// 2. OFFLINE CACHING (Existing Logic)
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
  // Ignore Firestore/Firebase requests to prevent caching issues
  if (event.request.url.includes('firestore.googleapis.com') || 
      event.request.url.includes('googleapis.com')) {
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