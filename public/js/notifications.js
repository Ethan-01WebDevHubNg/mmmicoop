import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
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
            console.log('Unable to get permission to notify.');
        }
    } catch (error) {
        console.error('Notification setup failed:', error);
    }
}

// Auto-init on load
initNotifications();