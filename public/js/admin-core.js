/**
 * admin-core.js
 * Central Logic for Admin Side: UI, Notifications, & STRICT SESSION SECURITY
 */
import { auth, db, doc, getDoc, signOut, onAuthStateChanged, onSnapshot, functions, httpsCallable } from './firebase-init.js';

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
// 2. NOTIFICATION SERVICE
// ==========================================
export class NotificationService {
    static init() {
        if (!document.getElementById('toast-container')) {
            const container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'fixed top-4 right-4 z-[10000] flex flex-col gap-3 pointer-events-none';
            document.body.appendChild(container);
        }
    }

    static toast(message, type = 'info') {
        this.init();
        const container = document.getElementById('toast-container');
        
        const styles = {
            success: 'bg-green-600 text-white border-green-500',
            error: 'bg-red-600 text-white border-red-500',
            info: 'bg-slate-800 text-white dark:bg-slate-700 border-slate-600'
        };

        const icon = type === 'success' ? 'check_circle' : (type === 'error' ? 'error' : 'info');

        const toast = document.createElement('div');
        toast.className = `${styles[type]} px-4 py-3 rounded-lg shadow-xl flex items-center gap-3 min-w-[300px] max-w-[90vw] border border-white/10 transform translate-x-full transition-all duration-300 pointer-events-auto`;
        toast.innerHTML = `
            <span class="material-symbols-outlined text-xl">${icon}</span>
            <span class="text-sm font-medium leading-tight">${message}</span>
        `;

        container.appendChild(toast);

        requestAnimationFrame(() => toast.classList.remove('translate-x-full'));

        setTimeout(() => {
            toast.classList.add('opacity-0', 'translate-x-full');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    static confirm(title, message, confirmText = 'Confirm') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[10001] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 opacity-0 transition-opacity duration-200';
            overlay.innerHTML = `
                <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-sm w-full p-6 transform scale-95 transition-transform duration-200 border border-gray-100 dark:border-gray-700">
                    <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-2">${title}</h3>
                    <p class="text-sm text-slate-500 dark:text-slate-400 mb-6 leading-relaxed">${message}</p>
                    <div class="flex justify-end gap-3">
                        <button id="modal-cancel" class="px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">Cancel</button>
                        <button id="modal-confirm" class="px-4 py-2 text-sm font-bold bg-primary text-white hover:bg-red-700 rounded-lg shadow-lg shadow-red-600/20 transition-colors">${confirmText}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            requestAnimationFrame(() => {
                overlay.classList.remove('opacity-0');
                overlay.querySelector('div').classList.remove('scale-95');
                overlay.querySelector('div').classList.add('scale-100');
            });

            const cleanup = () => {
                overlay.classList.add('opacity-0');
                setTimeout(() => overlay.remove(), 200);
            };

            overlay.querySelector('#modal-cancel').onclick = () => { cleanup(); resolve(false); };
            overlay.querySelector('#modal-confirm').onclick = () => { cleanup(); resolve(true); };
        });
    }
}

// ==========================================
// 3. HELPER UTILITIES
// ==========================================
export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// ==========================================
// 4. ADMIN SESSION SECURITY (15 MINS)
// ==========================================
class AdminSessionManager {
    constructor() {
        this.TIMEOUT_MINUTES = 15; 
        this.WARNING_MINUTES = 13;  
        
        this.TIMEOUT_MS = this.TIMEOUT_MINUTES * 60 * 1000;
        this.WARNING_MS = this.WARNING_MINUTES * 60 * 1000;

        this.warningTimer = null;
        this.logoutTimer = null;
        this.countdownInterval = null;
        this.isWarningVisible = false;
        this.concurrencyInterval = null;
    }

    init(user) {
        this.injectSessionModals();
        this.setupActivityMonitor();
        this.startSessionTimer();
        
        // 5-Second Grace Period
        setTimeout(() => {
            this.setupConcurrencyCheck(user.uid);
        }, 5000);
        
        console.log(`Admin Security: ${this.TIMEOUT_MINUTES}m Timeout + Concurrency Enforced`);
    }

    // --- SHARED HELPER: Generates a 2-digit flip group ---
    getFlipGroupHTML(idPrefix) {
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

    injectSessionModals() {
        if (document.getElementById('admin-session-modals-container')) return;
        
        document.head.insertAdjacentHTML('beforeend', FLIP_CSS);

        const container = document.createElement('div');
        container.id = 'admin-session-modals-container';
        container.innerHTML = `
        <div id="admin-session-modal" class="hidden fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 transition-opacity duration-300 opacity-0" style="font-family: 'Manrope', sans-serif;">
          <div class="bg-white dark:bg-[#1e293b] rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center border border-red-100 dark:border-red-900/30 transform transition-all scale-95">
            <div class="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
              <span class="material-symbols-outlined text-2xl">timer</span>
            </div>
            <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-2">Session Expiring</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">Your session is about to expire due to inactivity.</p>
            
            <div class="countdown">
                ${this.getFlipGroupHTML('admin-warn-min')}
                <div class="separator">:</div>
                ${this.getFlipGroupHTML('admin-warn-sec')}
            </div>
            <p class="text-xs text-gray-400 font-bold mb-6">MINUTES &nbsp;&nbsp;&nbsp;&nbsp; SECONDS</p>

            <button id="admin-session-stay-btn" class="w-full bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-200 text-white dark:text-slate-900 font-bold py-2.5 px-4 rounded-xl transition-colors shadow-lg">
              I'm still here
            </button>
          </div>
        </div>

        <div id="admin-concurrency-modal" class="hidden fixed inset-0 z-[10003] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 transition-opacity duration-300 opacity-0" style="font-family: 'Manrope', sans-serif;">
          <div class="bg-white dark:bg-[#1e293b] rounded-3xl shadow-2xl max-w-sm w-full p-8 text-center border-2 border-red-500 dark:border-red-600 transform transition-all scale-100">
            <div class="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <span class="material-symbols-outlined text-4xl">lock_person</span>
            </div>
            <h3 class="text-xl font-black text-slate-900 dark:text-white mb-2">Session Terminated</h3>
            
            <p class="text-gray-600 dark:text-gray-300 mb-6 text-sm leading-relaxed font-bold">
                You're logged in elsewhere. Re-login to continue here.
            </p>

            <div class="countdown">
                ${this.getFlipGroupHTML('admin-concur-sec')}
            </div>
            <p style="margin-top:5px; font-weight:bold; color:#888;">SECONDS</p>

            <button id="admin-concurrency-btn" class="w-full py-3 text-sm font-bold rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors shadow-lg shadow-red-600/30">
                Logout Now
            </button>
          </div>
        </div>`;
        
        document.body.appendChild(container);

        document.getElementById('admin-session-stay-btn').addEventListener('click', () => {
            this.resetSessionTimer();
            this.hideSessionWarning();
        });
    }

    // --- FLIP ANIMATION LOGIC ---
    updateTimeSegment(segmentElement, timeValue) {
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

    updateFlipGroup(containerId, value) {
        const tens = Math.floor(value / 10);
        const units = value % 10;
        const section = document.getElementById(containerId);
        if(!section) return;
        
        const segments = section.querySelectorAll('.time-segment');
        if(segments.length >= 2) {
            this.updateTimeSegment(segments[0], tens);
            this.updateTimeSegment(segments[1], units);
        }
    }

    startSessionTimer() {
        this.clearTimers();
        this.warningTimer = setTimeout(() => this.showSessionWarning(), this.WARNING_MS);
        this.logoutTimer = setTimeout(() => this.forceLogout("Session Expired"), this.TIMEOUT_MS);
    }

    resetSessionTimer() {
        if (!auth.currentUser) return;
        this.startSessionTimer();
    }

    clearTimers() {
        if (this.warningTimer) clearTimeout(this.warningTimer);
        if (this.logoutTimer) clearTimeout(this.logoutTimer);
        if (this.countdownInterval) clearInterval(this.countdownInterval);
    }

    showSessionWarning() {
        const modal = document.getElementById('admin-session-modal');
        
        if (modal) {
            modal.classList.remove('hidden');
            
            let secondsLeft = (this.TIMEOUT_MINUTES - this.WARNING_MINUTES) * 60;
            
            // Initial render
            this.updateFlipGroup('admin-warn-min', Math.floor(secondsLeft / 60));
            this.updateFlipGroup('admin-warn-sec', secondsLeft % 60);

            this.countdownInterval = setInterval(() => {
                secondsLeft--;
                const m = Math.floor(secondsLeft / 60);
                const s = secondsLeft % 60;
                
                this.updateFlipGroup('admin-warn-min', m);
                this.updateFlipGroup('admin-warn-sec', s);

                if (secondsLeft <= 0) clearInterval(this.countdownInterval);
            }, 1000);

            setTimeout(() => {
                modal.classList.remove('opacity-0');
                modal.querySelector('div').classList.remove('scale-95');
                modal.querySelector('div').classList.add('scale-100');
            }, 10);
        }
    }

    hideSessionWarning() {
        this.isWarningVisible = false;
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        const modal = document.getElementById('admin-session-modal');
        if (modal) {
            modal.classList.add('opacity-0');
            modal.querySelector('div').classList.remove('scale-100');
            modal.querySelector('div').classList.add('scale-95');
            setTimeout(() => modal.classList.add('hidden'), 300);
        }
    }

    setupActivityMonitor() {
        ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach(evt => {
            window.addEventListener(evt, () => {
                if (!this.isWarningVisible) {
                    this.resetSessionTimer();
                }
            }, { passive: true });
        });
    }

    setupConcurrencyCheck(uid) {
        onSnapshot(doc(db, "admins", uid), (docSnap) => {
            if (docSnap.exists()) {
                const remote = docSnap.data().currentSessionToken;
                const local = localStorage.getItem('mmmi_session_token');

                if (remote && local && remote !== local) {
                    this.showConcurrencyModal();
                }
            }
        });

        this.concurrencyInterval = setInterval(() => {
            if (!localStorage.getItem('mmmi_session_token')) {
                this.forceLogout(null, true);
            }
        }, 2000);

        window.addEventListener('storage', (e) => {
            if (e.key === 'mmmi_session_token' && !e.newValue) {
                this.forceLogout(null, true); 
            }
        });
    }

    showConcurrencyModal() {
        this.clearTimers(); 
        if (this.concurrencyInterval) clearInterval(this.concurrencyInterval);

        const modal = document.getElementById('admin-concurrency-modal');
        const btn = document.getElementById('admin-concurrency-btn');

        if (modal) {
            localStorage.removeItem('mmmi_session_token');
            
            modal.classList.remove('hidden');
            setTimeout(() => modal.classList.remove('opacity-0'), 10);

            let seconds = 10;
            this.updateFlipGroup('admin-concur-sec', 10);
            
            const interval = setInterval(() => {
                seconds--;
                this.updateFlipGroup('admin-concur-sec', seconds);
                
                if (seconds <= 0) {
                    clearInterval(interval);
                    btn.textContent = "Redirecting...";
                    this.forceLogout(null, true);
                }
            }, 1000);

            btn.onclick = () => {
                clearInterval(interval);
                this.forceLogout(null, true);
            };
        } else {
            this.forceLogout("Logged in on another device.");
        }
    }

    async forceLogout(reason, silent = false) {
        try {
            localStorage.removeItem('mmmi_session_token');
            await signOut(auth);
            
            if (!silent && reason) {
                NotificationService.toast(reason, 'info');
                setTimeout(() => {
                    window.location.href = '/auth/index.html'; 
                }, 2000);
            } else {
                window.location.href = '/auth/index.html'; 
            }
        } catch (e) {
            console.error("Logout failed", e);
        }
    }
}

// ==========================================
// 5. INITIALIZATION
// ==========================================
(function initUI() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runUILogic);
    } else {
        runUILogic();
    }

    function runUILogic() {
        initMobileMenu();
        initBroadcastLogic(); 
    }

    function initMobileMenu() {
        const menuBtn = document.getElementById('menu-btn');
        const closeBtn = document.getElementById('close-menu-btn');
        const overlay = document.getElementById('mobile-menu-overlay');
        const menu = document.getElementById('mobile-menu');

        if (!menuBtn || !menu) return;

        const openMenu = () => {
            overlay.classList.remove('hidden');
            setTimeout(() => menu.classList.remove('-translate-x-full'), 10);
        };

        const closeMenu = () => {
            menu.classList.add('-translate-x-full');
            setTimeout(() => overlay.classList.add('hidden'), 300);
        };

        menuBtn.addEventListener('click', openMenu);
        if (closeBtn) closeBtn.addEventListener('click', closeMenu);
        if (overlay) overlay.addEventListener('click', closeMenu);
    }

    // ==========================================
    // 6. BROADCAST LOGIC
    // ==========================================
    function initBroadcastLogic() {
        const sendBtn = document.getElementById('btn-send-broadcast');
        if (!sendBtn) return;

        sendBtn.addEventListener('click', async function() {
            const btn = this;
            const titleInput = document.getElementById('notif-title');
            const bodyInput = document.getElementById('notif-body');
            const imageInput = document.getElementById('notif-image'); 
            const urlInput = document.getElementById('notif-url'); 
            
            // --- NEW: Capture Audience Selection ---
            const audienceInput = document.getElementById('notif-audience');
            const audience = audienceInput ? audienceInput.value : 'users';
            
            const title = titleInput.value.trim();
            const body = bodyInput.value.trim();
            const imageUrl = imageInput ? imageInput.value.trim() : null; 
            const clickUrl = urlInput && urlInput.value.trim() !== '' ? urlInput.value.trim() : '/member/memberDashboard.html';

            if (!title || !body) {
                NotificationService.toast('Please fill in both title and message.', 'error');
                return;
            }

            // UI Loading State
            const originalContent = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = `<span class="material-symbols-outlined animate-spin text-xl">refresh</span> Sending...`;

            try {
                // Call Firebase Function (Now passes the 'audience' variable)
                const sendBroadcast = httpsCallable(functions, 'sendBroadcast');
                await sendBroadcast({ title, body, imageUrl, clickUrl, audience });

                NotificationService.toast('Broadcast sent successfully!', 'success');
                
                // Reset and Close
                titleInput.value = '';
                bodyInput.value = '';
                if(imageInput) imageInput.value = ''; 
                if(urlInput) urlInput.value = ''; 
                if(audienceInput) audienceInput.value = 'users';
                
                // Reset Char Count if exists
                const charCount = document.getElementById('char-count');
                if(charCount) {
                    charCount.textContent = '0/120';
                    charCount.classList.remove('text-red-500');
                }
                
                document.getElementById('broadcast-modal').classList.add('hidden');

            } catch (error) {
                console.error('Broadcast Failed:', error);
                const msg = error.message || 'Failed to send broadcast.';
                NotificationService.toast(msg, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalContent;
            }
        });
    }

    onAuthStateChanged(auth, (user) => {
      if (user) {
        if (window.location.pathname === '/admin' || window.location.pathname.includes('/admin/')) {
          const sessionManager = new AdminSessionManager();
          sessionManager.init(user);
        }
      }
    });

})();