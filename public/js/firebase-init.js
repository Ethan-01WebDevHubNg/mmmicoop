import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { 
    getAuth, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword, 
    signInWithCustomToken,
    onAuthStateChanged, 
    signOut,
    sendPasswordResetEmail,
    EmailAuthProvider,             
    reauthenticateWithCredential   
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    setDoc, 
    addDoc, 
    deleteDoc, 
    updateDoc, 
    increment, 
    getDoc, 
    getDocs, 
    collection, 
    collectionGroup, 
    getCountFromServer, 
    query, 
    where, 
    orderBy, 
    limit, 
    startAfter, 
    endBefore, 
    runTransaction, 
    serverTimestamp,
    onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { 
    getStorage, 
    ref as storageRef, 
    uploadBytes, 
    getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { 
    getFunctions, 
    httpsCallable 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { 
    getRemoteConfig, 
    fetchAndActivate, 
    getValue 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-remote-config.js";

const firebaseConfig = {
  apiKey: "AIzaSyAU84tnBHjJn30HU38aKDsfSEymkYiwNbA",
  authDomain: "mmmi-cooperative-portal.firebaseapp.com",
  projectId: "mmmi-cooperative-portal",
  storageBucket: "mmmi-cooperative-portal.firebasestorage.app",
  messagingSenderId: "178385913970",
  appId: "1:178385913970:web:efd0f4eefe2b3c36999aeb"
};

// Singleton App Initialization
let app;
try {
    app = initializeApp(firebaseConfig);
} catch (e) {
    // Prevent duplicate app initialization errors
    console.warn("Firebase App already initialized, using existing instance.");
}

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app); 
const remoteConfig = getRemoteConfig(app);

remoteConfig.settings.minimumFetchIntervalMillis = 3600000; 

// ==========================================
// UTILITIES: INTEGER MATH (KOBO)
// ==========================================
const toKobo = (amount) => Math.round(Number(amount) * 100);
const fromKobo = (kobo) => kobo / 100;

const safeAdd = (a, b) => fromKobo(toKobo(a) + toKobo(b));
const safeSub = (a, b) => fromKobo(toKobo(a) - toKobo(b));
const safeMul = (amount, multiplier) => fromKobo(Math.round(toKobo(amount) * multiplier));

export { 
    app, 
    auth, 
    db, 
    storage, 
    functions,
    remoteConfig,
    firebaseConfig, 
    initializeApp,
    deleteApp,
    getAuth,
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
    signInWithCustomToken, 
    onAuthStateChanged, 
    signOut,
    sendPasswordResetEmail,
    EmailAuthProvider,
    reauthenticateWithCredential,
    doc, 
    setDoc, 
    addDoc, 
    deleteDoc, 
    updateDoc, 
    increment, 
    getDoc, 
    getDocs, 
    collection, 
    collectionGroup, 
    getCountFromServer, 
    query, 
    where, 
    orderBy, 
    limit, 
    startAfter, 
    endBefore, 
    runTransaction, 
    serverTimestamp,
    onSnapshot,
    storageRef, 
    uploadBytes, 
    getDownloadURL,
    httpsCallable,
    getRemoteConfig, 
    fetchAndActivate, 
    getValue,
    toKobo,
    fromKobo,
    safeAdd,
    safeSub,
    safeMul
};