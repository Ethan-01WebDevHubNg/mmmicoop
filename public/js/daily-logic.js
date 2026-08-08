// Optimized Imports: All come from local firebase-init. No CDN links.
import { auth, functions, httpsCallable, EmailAuthProvider, reauthenticateWithCredential } from './firebase-init.js'; 
import { processDailyDeposit, processDailyWithdrawal } from './txnCreation.js';

// --- STATE VARIABLES ---
let dailyData = { isActive: false, amount: 0, days: 0, accumulated: 0, lastContributionDate: null, startDate: null };
let payAheadCount = 0;
let daysOwed = 0;
let daysAhead = 0;
let withdrawTapCount = 0;
let withdrawTapTimer = null;
let pendingWithdrawalEarly = false;
let withdrawalDestination = 'bank'; // 'bank' or 'savings'

// NEW: Cache for bank details needed for withdrawals (Test 10 Fix)
let cachedBankDetails = { memberId: null, bankName: null, accountNumber: null, accountName: null };

// Dependencies passed from main dashboard
let Shared = {
    currentUser: null,
    showModal: null,
    formatCurrency: null,
    switchDashboard: null
};

// --- INITIALIZATION ---
export function initDailyLogic(user, dependencies) {
    Shared.currentUser = user;
    Object.assign(Shared, dependencies);

    // Attach functions to window so HTML onclick events work
    window.handleDebtPayClick = handleDebtPayClick;
    window.handleDailyWithdrawClick = handleDailyWithdrawClick;
    window.openDailyModal = openDailyModal;
    window.closeDailyModal = closeDailyModal;
    window.updateAhead = updateAhead;
    window.startDailyPayment = startDailyPayment;
    window.toggleAuthPassword = toggleAuthPassword;
    window.closeAuthModal = closeAuthModal;
    window.handleAuthSubmit = handleAuthSubmit;
    
    // Handlers for Destination Modal
    window.closeDestinationModal = closeDestinationModal;
    window.handleDestinationSelect = handleDestinationSelect;
}

// --- DATA PROCESSING ---
export function processDailyData(userData) {
    const d = userData.dailyContribution || {};
    const valAmount = Number(d.dailyAmount) || 0;
    const valAccumulated = Number(d.accumulated) || 0;
    
    // UPDATED: Math.floor used to ensure whole numbers for days
    const calculatedDays = valAmount > 0 ? Math.floor(valAccumulated / valAmount) : 0;

    dailyData = { 
        isActive: d.isActive || false, 
        dailyAmount: valAmount, 
        accumulated: valAccumulated,
        days: calculatedDays, 
        lastContributionDate: d.lastContributionDate || null,
        startDate: d.startDate || null
    };
    dailyData.amount = dailyData.dailyAmount > 0 ? dailyData.dailyAmount : 0; 

    // NEW: Capture bank details for withdrawal metadata parity (Test 10 Fix)
    cachedBankDetails = {
        memberId: userData.memberId || null,
        bankName: userData.bankName || null,
        accountNumber: userData.accountNumber || null,
        accountName: userData.accountName || null
    };

    calculateDateStatus();
    updateDailyUI();
    loadDailyQuote();
    
    setTimeout(() => checkDebtStatus(), 3000);
}

// --- CORE LOGIC ---
function calculateDateStatus() {
    if(!dailyData.isActive) {
        daysOwed = 0; daysAhead = 0;
        return;
    }
    
    let startDate;
    if (dailyData.startDate) startDate = new Date(dailyData.startDate);
    else if (dailyData.lastContributionDate) startDate = new Date(dailyData.lastContributionDate);
    else { daysOwed = 0; daysAhead = 0; return; }

    const today = new Date();
    startDate.setHours(0,0,0,0);
    today.setHours(0,0,0,0);

    const diffTime = today.getTime() - startDate.getTime();
    const daysElapsed = Math.floor(diffTime / (1000 * 3600 * 24)) + 1; 
    const daysPaid = dailyData.days; 
    const diff = daysPaid - daysElapsed;

    if (diff > 0) { daysAhead = diff; daysOwed = 0; }
    else if (diff < 0) { daysAhead = 0; daysOwed = Math.abs(diff); }
    else { daysAhead = 0; daysOwed = 0; }
}

function checkDebtStatus() {
    if(dailyData.isActive && daysOwed >= 2) {
        const debtCountEl = document.getElementById('debt-days-count');
        if(debtCountEl) debtCountEl.textContent = daysOwed;
        
        const popup = document.getElementById('debt-popup');
        popup.classList.remove('hidden');
        popup.classList.add('bounce-in');
    }
}

// --- UI UPDATES ---
function updateDailyUI() {
    const total = document.getElementById('daily-total-display');
    const amt = document.getElementById('daily-amount-display');
    const days = document.getElementById('daily-days-display');
    const badge = document.getElementById('daily-status-badge');
    const wBtn = document.getElementById('btn-daily-withdraw');
    const wSec = document.getElementById('withdrawable-section');
    const startBtn = document.getElementById('btn-daily-start');
    const debtDisplay = document.getElementById('days-owed-display');
    const startDisplay = document.getElementById('daily-start-date-display');

    total.textContent = Shared.formatCurrency(dailyData.accumulated);
    amt.textContent = dailyData.isActive ? Shared.formatCurrency(dailyData.amount) : '--';
    days.textContent = `${dailyData.days} / 30`;
    debtDisplay.className = "hidden text-sm font-bold px-2 py-1 rounded transition-colors duration-300";

    if(dailyData.isActive) {
        badge.textContent = "ACTIVE"; 
        badge.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";

        if(dailyData.startDate) {
            const sd = new Date(dailyData.startDate);
            startDisplay.textContent = sd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        } else { startDisplay.textContent = "N/A"; }

        debtDisplay.classList.remove('hidden');

        if (daysAhead > 0) {
            debtDisplay.classList.add('text-green-600', 'bg-green-100', 'dark:text-green-400', 'dark:bg-green-900/30');
            debtDisplay.innerHTML = `Days ahead: <span>${daysAhead}</span>`;
            startBtn.innerHTML = 'Pay Ahead';
            startBtn.disabled = false;
            startBtn.onclick = () => openDailyModal('start');
        } else if (daysOwed > 0) {
            debtDisplay.classList.add('text-red-500', 'bg-red-100', 'dark:bg-red-900/30');
            debtDisplay.innerHTML = `Days owed: <span>${daysOwed}</span>`;
            startBtn.textContent = "Pay For Today";
            startBtn.disabled = false;
            startBtn.onclick = () => openDailyModal('start');
        } else {
            debtDisplay.classList.add('text-green-600', 'bg-green-100', 'dark:text-green-400', 'dark:bg-green-900/30');
            debtDisplay.innerHTML = `Days owed: <span>0</span>`;
            startBtn.innerHTML = 'Pay Ahead';
            startBtn.disabled = false;
            startBtn.onclick = () => openDailyModal('start');
        }
    } else {
        // INACTIVE STATE
        if(dailyData.accumulated > 0) {
            // Funds exist but plan is inactive (e.g. Penalty Reversal)
            badge.textContent = "PENDING WITHDRAWAL"; 
            badge.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-600 dark:bg-yellow-900 dark:text-yellow-300";
            
            // UI LOCK: Force withdrawal before starting new cycle
            startBtn.innerHTML = '<span class="text-xs">Withdraw current balance<br>to start new cycle</span>';
            startBtn.className = "bg-gray-200 text-gray-500 font-semibold py-2 px-5 rounded-lg cursor-not-allowed flex-1 sm:flex-none text-center leading-tight";
            startBtn.onclick = null; // Disable click
            
            debtDisplay.classList.add('hidden');
            startDisplay.textContent = "--";
        } else {
            // Truly Inactive
            badge.textContent = "INACTIVE"; 
            badge.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400";
            startBtn.textContent = "Start Cycle";
            startBtn.className = "bg-primary text-white font-semibold py-2 px-5 rounded-lg hover:bg-red-700 transition-transform hover:scale-105 flex-1 sm:flex-none";
            startBtn.disabled = false;
            startBtn.onclick = () => openDailyModal('start');
            debtDisplay.classList.add('hidden');
            startDisplay.textContent = "--";
        }
    }

    updateTodoList();
    updateWithdrawButton(wBtn, wSec);
}

function updateTodoList() {
    const todoList = document.getElementById('daily-todo-list');
    const isActive = dailyData.isActive;
    const isUpToDate = isActive && daysOwed === 0;
    const isMature = isActive && dailyData.days >= 30;
    const checkIcon = '<span class="material-symbols-outlined text-green-500 text-sm font-bold ml-auto">check</span>';

    todoList.innerHTML = `
        <li class="flex items-center gap-2"><span class="material-symbols-outlined text-xs">check_box_outline_blank</span> <span>Start contribution cycle</span>${isActive ? checkIcon : ''}</li>
        <li class="flex items-center gap-2"><span class="material-symbols-outlined text-xs">event_repeat</span> <span>Pay daily, consistently</span>${isUpToDate ? checkIcon : ''}</li>
        <li class="flex items-center gap-2"><span class="material-symbols-outlined text-xs">lock_clock</span> <span>Withdraw after 30 days</span>${isMature ? checkIcon : ''}</li>
        <li class="flex items-center gap-2 text-xs text-red-300"><span class="material-symbols-outlined text-xs">warning</span> <span>Early withdrawal: 25% fee</span></li>
    `;
}

function updateWithdrawButton(wBtn, wSec) {
    // UPDATED: Allow button if funds exist, regardless of Active Status
    if(dailyData.accumulated === 0) {
        wBtn.className = "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500 font-semibold py-2 px-5 rounded-lg cursor-not-allowed transition-all";
        wBtn.textContent = "Withdraw";
        wSec.classList.add('hidden');
    } else {
        // Has funds
        if(!dailyData.isActive) {
            // Special Case: Inactive but funded (Penalty Reversal)
            wBtn.className = "bg-green-600 text-white hover:bg-green-700 font-semibold py-2 px-5 rounded-lg transition-all animate-pulse";
            wBtn.textContent = "Withdraw Now";
            wSec.classList.remove('hidden');
            // Show full accumulated amount as net since no fees apply here
            document.getElementById('daily-net-display').textContent = Shared.formatCurrency(dailyData.accumulated);
        }
        else if(dailyData.days >= 30) {
            wBtn.className = "bg-green-600 text-white hover:bg-green-700 font-semibold py-2 px-5 rounded-lg transition-all";
            wBtn.textContent = "Withdraw Savings";
            wSec.classList.remove('hidden');
            const net = dailyData.accumulated - dailyData.amount;
            document.getElementById('daily-net-display').textContent = Shared.formatCurrency(net>0?net:0);
        } else {
            wBtn.className = "border-2 border-red-500/50 text-red-500/80 hover:bg-red-500/10 hover:border-red-500 hover:text-red-600 font-semibold py-2 px-5 rounded-lg transition-all";
            wBtn.textContent = "Early Withdraw";
            wSec.classList.add('hidden');
        }
    }
}

function loadDailyQuote() {
    const q = ["Small steps, big dreams.", "Consistency is wealth.", "Save today, smile tomorrow.", "Discipline is the bridge between goals and accomplishment."];
    document.getElementById('daily-quote').textContent = `"${q[Math.floor(Math.random()*q.length)]}"`;
}

// --- EVENT HANDLERS ---
function handleDebtPayClick() {
    Shared.switchDashboard('daily');
    document.getElementById('dash-toggle-savings').checked = false;
    document.getElementById('dash-toggle-daily').checked = true;
    document.getElementById('debt-popup').classList.add('hidden');
    setTimeout(() => openDailyModal('start'), 100);
}

function handleDailyWithdrawClick() {
    const btn = document.getElementById('btn-daily-withdraw');
    const warning = document.getElementById('double-tap-warning');

    if(dailyData.accumulated === 0) {
        btn.classList.add('shake-active'); setTimeout(()=>btn.classList.remove('shake-active'), 300);
        if(navigator.vibrate) navigator.vibrate(200);
        return;
    }

    // Special Case: Inactive but funded (Penalty Reversal) -> Standard Withdraw
    // Force destination to BANK because graceful exit is mandatory
    if (!dailyData.isActive && dailyData.accumulated > 0) {
        pendingWithdrawalEarly = false;
        withdrawalDestination = 'bank'; // FORCE BANK
        openAuthModal(false); // Skip destination selection
        return;
    }

    // Double-tap logic for EARLY withdrawal
    if(dailyData.days < 30) {
        if(withdrawTapCount === 0) {
            withdrawTapCount = 1;
            warning.classList.remove('hidden');
            if(navigator.vibrate) navigator.vibrate([100,50,100]);
            withdrawTapTimer = setTimeout(() => {
                withdrawTapCount = 0; 
                warning.classList.add('hidden');
            }, 3000); 
        } else {
            clearTimeout(withdrawTapTimer); 
            withdrawTapCount = 0;
            warning.classList.add('hidden');
            
            pendingWithdrawalEarly = true;
            openDestinationModal();
        }
    } else { 
        // Mature Withdrawal
        pendingWithdrawalEarly = false;
        openDestinationModal(); 
    }
}

// --- DESTINATION MODAL LOGIC ---
function openDestinationModal() {
    document.getElementById('daily-destination-modal').classList.remove('hidden');
}
function closeDestinationModal() {
    document.getElementById('daily-destination-modal').classList.add('hidden');
}
function handleDestinationSelect(type) {
    withdrawalDestination = type;
    closeDestinationModal();
    openAuthModal(pendingWithdrawalEarly);
}


// --- PAYMENT & MODALS ---
function openDailyModal(mode) {
    if(mode === 'start') {
        document.getElementById('daily-modal').classList.remove('hidden');
        const inp = document.getElementById('daily-input');
        const msg = document.getElementById('daily-lock-msg');
        const aheadSec = document.getElementById('pay-ahead-section');

        payAheadCount = 0; 
        updateAheadUI();

        if(dailyData.isActive) {
            inp.value = dailyData.amount;
            inp.disabled = true;
            inp.classList.add('bg-gray-100', 'cursor-not-allowed', 'dark:bg-gray-600');
            msg.classList.remove('hidden');
            if (dailyData.days < 30) aheadSec.classList.remove('hidden');
            else aheadSec.classList.add('hidden');
        } else {
            inp.value = '';
            inp.disabled = false;
            inp.classList.remove('bg-gray-100', 'cursor-not-allowed', 'dark:bg-gray-600');
            msg.classList.add('hidden');
            aheadSec.classList.add('hidden');
            document.getElementById('btn-pay-daily-confirm').textContent = "Start Cycle";
        }
    }
}

function updateAhead(change) {
    const proposedAheadCount = payAheadCount + change;
    const totalNewDays = 1 + proposedAheadCount;
    if (dailyData.days + totalNewDays > 30) {
        if (change > 0) Shared.showModal("Limit Reached", "You cannot pay for more than the remaining days in the 30-day cycle.");
        return;
    }
    if(proposedAheadCount < 0) return;
    payAheadCount = proposedAheadCount;
    updateAheadUI();
}

function updateAheadUI() {
    document.getElementById('ahead-count-text').textContent = payAheadCount;
    document.getElementById('ahead-counter-display').textContent = payAheadCount;
    
    const baseAmount = dailyData.isActive ? parseFloat(dailyData.amount) : parseFloat(document.getElementById('daily-input').value || 0);
    const totalAmount = baseAmount * (1 + payAheadCount);
    
    if(dailyData.isActive) {
        document.getElementById('daily-input').value = totalAmount;
    }

    const btn = document.getElementById('btn-pay-daily-confirm');
    if(payAheadCount === 0) {
        btn.textContent = dailyData.isActive ? "Pay Today's Contribution" : "Start Cycle";
    } else {
        btn.textContent = `Pay for ${1 + payAheadCount} days now`;
    }
}

function closeDailyModal() { document.getElementById('daily-modal').classList.add('hidden'); }

function startDailyPayment() {
    let baseAmount = dailyData.isActive ? dailyData.amount : parseFloat(document.getElementById('daily-input').value);
    
    if(!baseAmount || isNaN(baseAmount) || baseAmount < 500) {
        // IMPROVED ERROR HANDLING
        Shared.showModal("Invalid Amount", "Please enter a valid amount (Minimum \u20A6500)");
        return;
    }
    
    const totalAmount = Number(baseAmount * (1 + payAheadCount));
    const user = Shared.currentUser;

    if (!user) {
        Shared.showModal("Error", "User session invalid. Please reload.");
        return;
    }

    const squadInstance = new squad({
        onSuccess: async(d) => {
            try {
                if (!d || (!d.transaction_ref && !d.reference)) throw new Error("Reference missing.");
                const ref = d.transaction_ref || d.reference;
                await processDailyDeposit(user.uid, totalAmount, ref);
                closeDailyModal(); 
                Shared.showModal("Success", "Contribution recorded!"); 
                window.location.reload(); 
            } catch(e) { 
                console.error("Daily Payment Record Error:", e);
                Shared.showModal("Error", "Payment successful, but records update failed: " + (e.message || "Unknown error")); 
            }
        },
        onClose: () => { console.log("Squad Widget Closed"); },
        key: "pk_59f298e7999d3bef0293627a86b20786947a6c15",
        email: user.email, 
        amount: totalAmount * 100, 
        currency_code: "NGN"
    });
    squadInstance.setup(); squadInstance.open();
}

// --- AUTH LOGIC ---
function openAuthModal(isEarly) {
    pendingWithdrawalEarly = isEarly;
    document.getElementById('auth-modal').classList.remove('hidden');
    document.getElementById('auth-password-input').value = '';
    document.getElementById('auth-password-input').focus();
}

function closeAuthModal() { document.getElementById('auth-modal').classList.add('hidden'); }

function toggleAuthPassword() {
    const inp = document.getElementById('auth-password-input');
    const icon = document.getElementById('auth-eye-icon');
    if(inp.type === 'password') { inp.type = 'text'; icon.textContent = 'visibility_off'; } 
    else { inp.type = 'password'; icon.textContent = 'visibility'; }
}

async function handleAuthSubmit() {
    const pwd = document.getElementById('auth-password-input').value;
    const btn = document.getElementById('auth-submit-btn');
    if(!pwd) return Shared.showModal("Error", "Please enter password.");

    btn.disabled = true; btn.textContent = "Verifying...";
    const recaptchaAction = 'DAILY_WITHDRAW_AUTH';

    // FIX: Using exact Enterprise Logic from login page
    grecaptcha.enterprise.ready(async () => {
        try {
            const token = await grecaptcha.enterprise.execute('6Lc_9DIsAAAAAK5CvT8tlPhK-vWeVp25Xcb7nWi3', {action: recaptchaAction});
            
            const verifyRecaptcha = httpsCallable(functions, 'verifyRecaptcha');
            const result = await verifyRecaptcha({ token: token, action: recaptchaAction });
            
            if (!result.data.success) {
                throw new Error("Security check failed. Score: " + (result.data.score || "N/A"));
            }

            const credential = EmailAuthProvider.credential(Shared.currentUser.email, pwd);
            await reauthenticateWithCredential(Shared.currentUser, credential);
            
            closeAuthModal();
            
            const destText = withdrawalDestination === 'savings' ? "your Cooperative Savings?" : "your bank account?";
            Shared.showModal("Final Confirmation", `Confirm transfer to ${destText} Whole amount - fees will be processed. This cannot be undone.`, true, () => executeDailyWithdrawal(pendingWithdrawalEarly));
        } catch(error) {
            console.error(error);
            Shared.showModal("Authentication Failed", error.message.includes("Security") ? "Security check failed." : "Incorrect password.");
        } finally {
            btn.disabled = false; btn.textContent = "Confirm";
        }
    });
}

async function executeDailyWithdrawal(isEarly) {
    Shared.showModal("Processing", "Please wait...", false);
    try {
        // NEW: Pass cached memberId and bankDetails (Test 10 Fix)
        await processDailyWithdrawal(
            Shared.currentUser.uid, 
            isEarly, 
            withdrawalDestination, 
            cachedBankDetails.memberId, 
            cachedBankDetails
        );
        
        let msg = "Withdrawal processed.";
        if (withdrawalDestination === 'savings') msg = "Funds transferred to Savings successfully.";
        
        // Contextual Success Message
        if (isEarly && dailyData.isActive) msg += " (25% penalty applied)";
        else if (!dailyData.isActive) msg += " (Grace withdrawal - No fees)";
        
        Shared.showModal("Success", msg);
        window.location.reload(); 
    } catch(e) { Shared.showModal("Error", e.message||e); }
}