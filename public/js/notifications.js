import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { app, functions, httpsCallable } from "./firebase-init.js";

const messaging = getMessaging(app);

// Your VAPID Key
const VAPID_PUBLIC_KEY = "BDXmwwrvQyLWf4YwWnHD_1mSGzCTEwG8jWdjiDauE9lfezRH1pnafN_bS5Ok2jy5vu0TH5t4BoWIHOEx2o-asUI"; 

export async function initNotifications() {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            console.log('Notification permission granted.');
            
            // 1. GET THE EXISTING SERVICE WORKER (sw.js)
            const registration = await navigator.serviceWorker.ready;

            // 2. PASS THE REGISTRATION TO FIREBASE
            // This prevents the "404 firebase-messaging-sw.js" error
            const token = await getToken(messaging, { 
                vapidKey: VAPID_PUBLIC_KEY,
                serviceWorkerRegistration: registration 
            });

            if (token) {
                const subscribeFn = httpsCallable(functions, 'subscribeToBroadcast');
                await subscribeFn({ fcmToken: token });
                console.log('Subscribed to broadcasts');
            }
        } else {
            console.warn('Unable to get permission to notify.');
        }
    } catch (error) {
        console.error('Notification setup failed:', error);
    }
}

// 3. HANDLE FOREGROUND MESSAGES
// Intercepts payloads when the app is active and dispatches an event
onMessage(messaging, (payload) => {
    console.log('Foreground message received:', payload);
    
    // Dispatch a custom event so dashboards can display dynamic UI toasts natively
    const fcmEvent = new CustomEvent('fcm-foreground', { detail: payload });
    window.dispatchEvent(fcmEvent);
});

// Auto-init on load
initNotifications();