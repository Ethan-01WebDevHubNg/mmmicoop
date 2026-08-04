/**
 * auth.js
 * Handles Authentication, Registration, and MEMBER SIDE Session Security (30 Mins)
 */

import { 
    auth, 
    db, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword, 
    doc, 
    getDoc, 
    updateDoc, 
    serverTimestamp, 
    runTransaction,
    signOut,
    onAuthStateChanged, 
    onSnapshot
} from './firebase-init.js';

export { auth };

let isAuthActionInProgress = false;

// ==========================================
// 0. INTERNAL TOAST UTILITY (Auth Pages)
// ==========================================
const AuthToast = {
    show(message, type = 'info') {
        const existing = document.getElementById('auth-toast');
        if (existing) existing.remove();

        const colors = {
            success: 'bg-green-600',
            error: 'bg-red-600',
            info: 'bg-slate-800'
        };
        const icons = {
            success: 'check_circle',
            error: 'error',
            info: 'info'
        };

        const el = document.createElement('div');
        el.id = 'auth-toast';
        el.className = `fixed top-5 right-5 z-[10000] flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl text-white transform transition-all duration-300 translate-y-[-20px] opacity-0 ${colors[type] || colors.info}`;
        el.innerHTML = `
            <span class="material-symbols-outlined text-xl">${icons[type] || 'info'}</span>
            <span class="font-bold text-sm tracking-wide">${message}</span>
        `;

        document.body.appendChild(el);

        requestAnimationFrame(() => {
            el.classList.remove('translate-y-[-20px]', 'opacity-0');
        });

        setTimeout(() => {
            el.classList.add('opacity-0', 'translate-y-[-20px]');
            setTimeout(() => el.remove(), 300);
        }, 4000);
    }
};

// ==========================================
// 1. FLIP CLOCK CSS INJECTION
// ==========================================
const FLIP_CSS = `
<style>
    .countdown { display: flex; gap: 10px; font-family: sans-serif; justify-content: center; margin: 20px 0; align-items: center; }
    .time-section { text-align: center; font-size: 14px; color: #666; }
    .time-group { display: flex; gap: 5px; }
    .time-segment { display: block; font-size: 36px; font-weight: 900; width: 40px; } /* Compact size for MM:SS */
    
    .segment-display { position: relative; height: 50px; }
    .segment-display__top, .segment-display__bottom { overflow: hidden; text-align: center; width: 100%; height: 50%; position: relative; }
    .segment-display__top { line-height: 1.3; color: #eee; background-color: #c41515; border-radius: 4px 4px 0 0; }
    .segment-display__bottom { line-height: 0; color: #fff; background-color: #e31919; border-radius: 0 0 4px 4px; }
    
    .segment-overlay { position: absolute; top: 0; perspective: 400px; height: 100%; width: 100%; }
    .segment-overlay__top, .segment-overlay__bottom { position: absolute; overflow: hidden; text-align: center; width: 100%; height: 50%; }
    .segment-overlay__top { top: 0; line-height: 1.3; color: #fff; background-color: #c41515; transform-origin: bottom; border-radius: 4px 4px 0 0; }
    .segment-overlay__bottom { bottom: 0; line-height: 0; color: #eee; background-color: #e31919; border-top: 2px solid #a01212; transform-origin: top; border-radius: 0 0 4px 4px; }
    
    .segment-overlay.flip .segment-overlay__top { animation: flip-top 0.6s linear; }
    .segment-overlay.flip .segment-overlay__bottom { animation: flip-bottom 0.6s linear; }
    
    .separator { font-size: 30px; font-weight: 900; color: #ccc; margin: 0 5px; padding-bottom: 15px; }
    
    @keyframes flip-top { 0% { transform: rotateX(0deg); } 50%, 100% { transform: rotateX(-90deg); } }
    @keyframes flip-bottom { 0%, 50% { transform: rotateX(90deg); } 100% { transform: rotateX(0deg); } }
</style>
`;

// ==========================================
// 2. AUTHENTICATION LOGIC
// ==========================================

export async function registerUser(userData) {
  if (isAuthActionInProgress) return;
  isAuthActionInProgress = true;

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, userData.email, userData.password);
    const user = userCredential.user;

    await runTransaction(db, async (transaction) => {
      const counterRef = doc(db, "metadata", "user_stats");
      const counterDoc = await transaction.get(counterRef);

      let newCount = 1; 
      if (counterDoc.exists()) {
        const data = counterDoc.data();
        newCount = (data.memberCount || 0) + 1;
      }

      const sequentialMemberId = `MMMi-${String(newCount).padStart(4, '0')}`;
      const nowISO = new Date().toISOString();

      const userProfile = {
        uid: user.uid,
        memberId: sequentialMemberId,
        firstName: userData.firstName,
        surname: userData.surname,
        email: userData.email,
        phoneCode: userData.phoneCode,
        phoneNumber: userData.phoneNumber,
        nin: userData.nin,
        referral: userData.referral || "",
        address1: userData.address1,
        address2: userData.address2 || "",
        country: userData.country,
        state: userData.state,
        city: userData.city || "",
        createdAt: serverTimestamp(),
        planStartDate: nowISO,
        "Wallet balance": 0,
        "User_Plan": "Bronze",
        "Credit_Transactions": 0,
        "Debit_transactions": 0,
        withdrawalCycleCount: 0,
        withdrawalCycleStart: nowISO,
        dailyContribution: { isActive: false, dailyAmount: 0, count: 0, accumulated: 0, startDate: null }
      };

      transaction.set(counterRef, { memberCount: newCount }, { merge: true });
      const userRef = doc(db, "users", user.uid);
      transaction.set(userRef, userProfile);
    });

    AuthToast.show("Registration Successful! Redirecting...", "success");
    setTimeout(() => {
        window.location.href = "/auth/index.html"; 
    }, 1500);

  } catch (error) {
    console.error("Registration Error (Silent):", error.code); // Dev Log Only
    let message = "Unable to register.";
    if (error.code === 'auth/email-already-in-use') message = "Email already registered.";
    else if (error.code === 'auth/weak-password') message = "Password too weak.";
    else if (error.code === 'auth/invalid-email') message = "Invalid email format.";
    
    AuthToast.show(message, "error");
    throw new Error(message); // Re-throw sanitized message so caller (UI) can stop loading state
  } finally {
    isAuthActionInProgress = false;
  }
}

export async function loginUser(email, password) {
  if (isAuthActionInProgress) return;
  isAuthActionInProgress = true;

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    const sessionToken = Date.now().toString() + Math.random().toString(36).substring(2);
    localStorage.setItem('mmmi_session_token', sessionToken);

    const adminRef = doc(db, "admins", user.uid);
    const adminSnap = await getDoc(adminRef);

    AuthToast.show("Login Successful", "success");

    if (adminSnap.exists()) {
        await updateDoc(adminRef, { currentSessionToken: sessionToken });
        window.location.href = "/admin/index.html";
    } else {
        const userRef = doc(db, "users", user.uid);
        try {
            await updateDoc(userRef, { currentSessionToken: sessionToken });
        } catch(e) {
            console.warn("Update token failed", e);
        }
        window.location.href = "/member/memberDashboard.html"; 
    }

  } catch (error) {
    console.error("Login Error (Silent):", error.code);
    let message = "Login failed.";
    if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') message = "Invalid email or password.";
    else if (error.code === 'auth/too-many-requests') message = "Too many failed attempts. Try again later.";
    
    AuthToast.show(message, "error");
    throw new Error(message);
  } finally {
      setTimeout(() => { isAuthActionInProgress = false; }, 2000);
  }
}

// ==========================================
// 3. MEMBER SESSION SECURITY (30 MINS)
// ==========================================

const TIMEOUT_MINUTES = 30; // <--- MEMBER 30 MINS
const WARNING_MINUTES = 28; 

const TIMEOUT_MS = TIMEOUT_MINUTES * 60 * 1000;
const WARNING_MS = WARNING_MINUTES * 60 * 1000;

let warningTimer, logoutTimer, countdownInterval;
let isWarningVisible = false;

// --- Helper for Flip Logic ---
function updateTimeSegment(segmentElement, timeValue) {
    const top = segmentElement.querySelector('.segment-display__top');
    const bottom = segmentElement.querySelector('.segment-display__bottom');
    const overlay = segmentElement.querySelector('.segment-overlay');
    const overlayTop = overlay.querySelector('.segment-overlay__top');
    const overlayBottom = overlay.querySelector('.segment-overlay__bottom');

    if (parseInt(top.textContent, 10) === timeValue) return;

    overlay.classList.add('flip');
    top.textContent = timeValue;
    overlayBottom.textContent = timeValue;

    const finishAnimation = () => {
        overlay.classList.remove('flip');
        bottom.textContent = timeValue;
        overlayTop.textContent = timeValue;
        overlay.removeEventListener('animationend', finishAnimation);
    };

    overlay.addEventListener('animationend', finishAnimation);
}

function updateFlipGroup(containerId, value) {
    const tens = Math.floor(value / 10);
    const units = value % 10;
    const section = document.getElementById(containerId);
    if(!section) return;
    
    const segments = section.querySelectorAll('.time-segment');
    if(segments.length >= 2) {
        updateTimeSegment(segments[0], tens);
        updateTimeSegment(segments[1], units);
    }
}

function getFlipGroupHTML(idPrefix) {
    return `
        <div class="time-group" id="${idPrefix}">
            ${[0, 0].map(() => `
            <div class="time-segment">
                <div class="segment-display">
                    <div class="segment-display__top">0</div>
                    <div class="segment-display__bottom">0</div>
                    <div class="segment-overlay">
                        <div class="segment-overlay__top">0</div>
                        <div class="segment-overlay__bottom">0</div>
                    </div>
                </div>
            </div>`).join('')}
        </div>`;
}

// --- A. Inject / Upgrade Modals ---
const injectMemberModals = () => {
    // 1. Inject CSS
    if (!document.getElementById('flip-clock-css')) {
        document.head.insertAdjacentHTML('beforeend', FLIP_CSS.replace('<style>', '<style id="flip-clock-css">'));
    }

    // 2. UPGRADE EXISTING CONCURRENCY MODAL (From memberDashboard.html)
    const existingConcurrencyModal = document.getElementById('concurrency-modal');
    
    // Exact structure matching admin-core.js but using your dashboard text
    const concurrencyModalHTML = `
        <div class="absolute inset-0 bg-black/80 backdrop-blur-sm"></div>
        <div class="relative bg-white dark:bg-[#1e293b] rounded-3xl shadow-2xl max-w-sm w-full p-8 text-center border-2 border-red-500 dark:border-red-600 transform transition-all scale-100 animate-shake-active">
            <div class="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                <span class="material-symbols-outlined text-4xl">lock_person</span>
            </div>
            <h3 class="text-xl font-black text-slate-900 dark:text-white mb-2">Session Terminated</h3>
            <p class="text-gray-600 dark:text-gray-300 mb-6 text-sm leading-relaxed font-bold">
                You are logged in elsewhere. Continue session there or re-login to continue session here.
            </p>

            <div class="countdown">
                ${getFlipGroupHTML('mem-concur-sec')}
            </div>
            <p style="margin-top:5px; font-weight:bold; color:#888;">SECONDS</p>

            <button id="concurrency-logout-btn" class="w-full py-3 text-sm font-bold rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors shadow-lg shadow-red-600/30">
                Logout Now
            </button>
        </div>
    `;

    if (existingConcurrencyModal) {
        // Upgrade existing ID found in HTML
        existingConcurrencyModal.innerHTML = concurrencyModalHTML;
        // Ensure classes match admin-core behavior logic (hidden/flex)
        existingConcurrencyModal.classList.add('hidden', 'fixed', 'inset-0', 'z-[200]', 'flex', 'items-center', 'justify-center');
    } else {
        // Fallback: Create if not found
        const d = document.createElement('div');
        d.id = 'concurrency-modal';
        d.className = 'fixed inset-0 z-[200] flex items-center justify-center hidden';
        d.innerHTML = concurrencyModalHTML;
        document.body.appendChild(d);
    }

    // 3. INJECT SESSION WARNING MODAL (If not present)
    if (!document.getElementById('session-warning-modal')) {
        const warningHTML = `
        <div id="session-warning-modal" class="hidden fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 transition-opacity duration-300 opacity-0" style="font-family: 'Manrope', sans-serif;">
            <div class="bg-white dark:bg-[#1e293b] rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center border border-red-100 dark:border-red-900/30 transform transition-all scale-95">
                <div class="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
                    <span class="material-symbols-outlined text-2xl">timer</span>
                </div>
                <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-2">Session Expiring</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">
                    Your session is about to expire due to inactivity.
                </p>
                
                <div class="countdown">
                    ${getFlipGroupHTML('mem-warn-min')}
                    <div class="separator">:</div>
                    ${getFlipGroupHTML('mem-warn-sec')}
                </div>
                <p class="text-xs text-gray-400 font-bold mb-6">MINUTES &nbsp;&nbsp;&nbsp;&nbsp; SECONDS</p>

                <button id="session-stay-btn" class="w-full bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-200 text-white dark:text-slate-900 font-bold py-2.5 px-4 rounded-xl transition-colors shadow-lg">
                    I'm still here
                </button>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', warningHTML);
        
        const btn = document.getElementById('session-stay-btn');
        if (btn) btn.addEventListener('click', () => {
            resetSessionTimer();
            hideSessionWarning();
        });
    }
};

// --- B. Timer Logic ---
function startSessionTimer() {
    clearTimers();
    warningTimer = setTimeout(showSessionWarning, WARNING_MS);
    logoutTimer = setTimeout(() => logoutUser("Session Expired"), TIMEOUT_MS);
}

function resetSessionTimer() {
    if (!auth.currentUser) return; 
    startSessionTimer();
}

function clearTimers() {
    if (warningTimer) clearTimeout(warningTimer);
    if (logoutTimer) clearTimeout(logoutTimer);
    if (countdownInterval) clearInterval(countdownInterval);
}

function showSessionWarning() {
    isWarningVisible = true;
    const modal = document.getElementById('session-warning-modal');
    
    if (modal) {
        modal.classList.remove('hidden');
        
        let secondsLeft = (TIMEOUT_MINUTES - WARNING_MINUTES) * 60; 
        
        // Initial Render
        updateFlipGroup('mem-warn-min', Math.floor(secondsLeft / 60));
        updateFlipGroup('mem-warn-sec', secondsLeft % 60);

        countdownInterval = setInterval(() => {
            secondsLeft--;
            updateFlipGroup('mem-warn-min', Math.floor(secondsLeft / 60));
            updateFlipGroup('mem-warn-sec', secondsLeft % 60);

            if (secondsLeft <= 0) clearInterval(countdownInterval);
        }, 1000);

        setTimeout(() => {
            modal.classList.remove('opacity-0');
            modal.querySelector('div').classList.remove('scale-95');
            modal.querySelector('div').classList.add('scale-100');
        }, 10);
    }
}

function hideSessionWarning() {
    isWarningVisible = false;
    if (countdownInterval) clearInterval(countdownInterval); 
    const modal = document.getElementById('session-warning-modal');
    if (modal) {
        modal.classList.add('opacity-0');
        modal.querySelector('div').classList.remove('scale-100');
        modal.querySelector('div').classList.add('scale-95');
        setTimeout(() => modal.classList.add('hidden'), 300);
    }
}

// --- C. Concurrency Logic ---
function startConcurrencyListener(uid) {
    // 5s Grace Period
    setTimeout(() => {
        onSnapshot(doc(db, "users", uid), (docSnap) => {
            if (docSnap.exists()) {
                const remote = docSnap.data().currentSessionToken;
                const local = localStorage.getItem('mmmi_session_token');
                
                if (remote && local && remote !== local) {
                    triggerConcurrencyLogout();
                }
            }
        });
    }, 5000);
}

function triggerConcurrencyLogout() {
    clearTimers(); 
    
    // TARGET THE UPGRADED HTML MODAL
    const modal = document.getElementById('concurrency-modal');
    const btn = document.getElementById('concurrency-logout-btn');
    
    if (!modal || !btn) return;

    localStorage.removeItem('mmmi_session_token'); 
    
    modal.classList.remove('hidden');
    // Ensure styles for visibility
    setTimeout(() => {
        const inner = modal.querySelector('.relative');
        if(inner) {
            inner.classList.remove('scale-95', 'opacity-0');
            inner.classList.add('scale-100', 'opacity-100');
        }
    }, 10);

    let seconds = 10;
    updateFlipGroup('mem-concur-sec', 10);
    btn.textContent = `Logging out in ${seconds}s...`;
    
    const interval = setInterval(() => {
        seconds--;
        updateFlipGroup('mem-concur-sec', seconds);
        btn.textContent = `Logging out in ${seconds}s...`;
        
        if (seconds <= 0) {
            clearInterval(interval);
            btn.textContent = "Redirecting...";
            logoutUser("Concurrent Session");
        }
    }, 1000);

    btn.onclick = () => {
        clearInterval(interval);
        logoutUser("Concurrent Session");
    };
}

async function logoutUser(reason) {
    try {
        clearTimers();
        await signOut(auth);
        localStorage.removeItem('mmmi_session_token');
        if (reason && reason !== "Concurrent Session") {
            AuthToast.show(reason + ". Logging out...", "info");
        }
        setTimeout(() => {
            window.location.href = "/auth/index.html";
        }, 1000);
    } catch (e) {
        console.error("Logout failed", e);
    }
}

// --- D. Initialization ---
const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];

function initMemberSecurity(user) {
    injectMemberModals();
    startSessionTimer();
    startConcurrencyListener(user.uid);

    activityEvents.forEach(evt => {
        window.addEventListener(evt, () => {
            if (!isWarningVisible) resetSessionTimer();
        }, { passive: true });
    });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    // Run ONLY on member side (NOT admin) AND exclude auth paths
    if (
      !window.location.pathname.includes('/admin/') &&
      !window.location.pathname.includes('/auth') &&
      !window.location.pathname.includes('/auth/')
    ) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initMemberSecurity(user));
      } else {
        initMemberSecurity(user);
      }
    }
  } else {
    clearTimers();
  }
});