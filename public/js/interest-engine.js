/**
 * Interest Engine & Plan Manager (Firestore Driven)
 */

const InterestEngine = (function() {
    
    let _plans = []; 
    let _db, _userId, _fs, _applyInterestFn;
    let _pendingMessage = null; 
    
    const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;
    const CYCLE_DURATION_DAYS = 90; 

    const Toast = {
        show: (message, type = 'success') => {
            const existing = document.getElementById('interest-toast');
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

            const div = document.createElement('div');
            div.id = 'interest-toast';
            div.className = `fixed top-5 right-5 z-[100000] flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl text-white transform transition-all duration-300 translate-y-[-20px] opacity-0 ${colors[type] || colors.info}`;
            div.style.fontFamily = "'Manrope', sans-serif";
            
            div.innerHTML = `
                <span class="material-symbols-outlined text-xl" style="font-size:20px;">${icons[type] || 'info'}</span>
                <span class="font-bold text-sm tracking-wide">${message}</span>
            `;

            document.body.appendChild(div);

            requestAnimationFrame(() => {
                div.classList.remove('translate-y-[-20px]', 'opacity-0');
            });

            setTimeout(() => {
                div.classList.add('opacity-0', 'translate-y-[-20px]');
                setTimeout(() => div.remove(), 300);
            }, 4000); 
        }
    };

    async function getUserData() {
        if (!_db || !_userId || !_fs) return null;
        const docRef = _fs.doc(_db, "users", _userId);

        try {
            if (_fs.getDocFromServer) {
                const snap = await _fs.getDocFromServer(docRef);
                return snap.exists() ? { ref: snap.ref, data: snap.data() } : null;
            } else {
                const snap = await _fs.getDoc(docRef);
                return snap.exists() ? { ref: snap.ref, data: snap.data() } : null;
            }
        } catch (e) {
            console.warn("Server fetch failed (offline?), falling back to cache:", e);
            try {
                const snap = await _fs.getDoc(docRef);
                return snap.exists() ? { ref: snap.ref, data: snap.data() } : null;
            } catch (err2) { return null; }
        }
    }

    async function init(firestoreDb, userId, firebaseFunctions, applyInterestFn) {
        _db = firestoreDb;
        _userId = userId;
        _fs = firebaseFunctions; 
        _applyInterestFn = applyInterestFn;
        _pendingMessage = null;

        await fetchPlans();
        await checkAndApplyInterest(); 
    }

    function showNotification() {
        if (_pendingMessage) {
            setTimeout(() => {
                Toast.show(_pendingMessage.msg, _pendingMessage.type);
                _pendingMessage = null;
            }, 800); 
        }
    }

    async function fetchPlans() {
        try {
            const q = _fs.query(_fs.collection(_db, "savings_plans"), _fs.orderBy("minAmount", "asc"));
            const querySnapshot = await _fs.getDocs(q);
            _plans = [];
            querySnapshot.forEach((doc) => {
                _plans.push({ id: doc.id, ...doc.data() });
            });
        } catch (e) {
            console.error("Error fetching plans:", e);
            try {
                const qFallback = _fs.collection(_db, "savings_plans");
                const snap = await _fs.getDocs(qFallback);
                _plans = [];
                snap.forEach((doc) => _plans.push({ id: doc.id, ...doc.data() }));
                _plans.sort((a,b) => a.minAmount - b.minAmount);
            } catch (err2) { _plans = []; }
        }
    }

    function getPlans() { 
        return _plans; 
    }
    
    async function checkUpgradeAvailability() {
        if (!_plans || _plans.length === 0) return null;
        
        const record = await getUserData();
        if (!record) return null;
        
        const balance = parseFloat(record.data["Wallet balance"] || 0);
        const currentPlanName = record.data["User_Plan"] || 'Bronze';
        
        const currentPlanObj = _plans.find(p => p.name.toLowerCase() === currentPlanName.toLowerCase());
        const currentRank = currentPlanObj ? currentPlanObj.rank : 0;

        const eligiblePlans = _plans.filter(p => {
            const isBalanceEligible = balance >= p.minAmount && (p.maxAmount === null || balance <= p.maxAmount);
            const isActive = p.isActive !== false; 
            return isBalanceEligible && isActive;
        });

        eligiblePlans.sort((a,b) => b.rank - a.rank);
        
        const bestEligible = eligiblePlans[0];
        
        if (bestEligible && bestEligible.rank > currentRank) {
            return {
                available: true,
                currentPlan: currentPlanName,
                eligiblePlan: bestEligible.name,
                message: `Your balance qualifies you for the ${bestEligible.name} Plan (${bestEligible.rate}% rate). Upgrade to start a new cycle.`
            };
        }
        return null;
    }

    async function attemptChange(newPlanName) {
        const record = await getUserData();
        if (!record) return false;
        const data = record.data;
        const balance = parseFloat(data["Wallet balance"] || 0);

        const targetPlan = _plans.find(p => p.name === newPlanName);
        if (!targetPlan) {
            Toast.show("Invalid Plan Selected", 'error');
            return false;
        }

        if (targetPlan.isActive === false) {
            Toast.show("This plan is no longer active.", 'error');
            return false;
        }

        if (balance < targetPlan.minAmount || (targetPlan.maxAmount !== null && balance > targetPlan.maxAmount)) {
             Toast.show(`Balance must be between ₦${targetPlan.minAmount.toLocaleString()} and ₦${(targetPlan.maxAmount || '∞').toLocaleString()} for ${newPlanName}.`, 'error');
             return false;
        }

        try {
            const now = _fs.serverTimestamp ? _fs.serverTimestamp() : new Date(); 
            
            const updatePayload = {
                "User_Plan": newPlanName,
                planStartDate: now,
                lastInterestApplied: now,
                firstCycleProcessed: false,
                cycleAccumulatedInterest: 0
            };

            if (_fs.updateDoc) {
                await _fs.updateDoc(record.ref, updatePayload);
            } else {
                await _fs.setDoc(record.ref, updatePayload, { merge: true });
            }
            Toast.show(`Plan upgraded to ${newPlanName}! New 90-day cycle started.`);
            return true;
        } catch (e) {
            console.error("Plan Change Error:", e);
            Toast.show("Plan update failed. Please check your connection.", 'error');
            return false;
        }
    }

    async function checkAndApplyInterest() {
        const record = await getUserData();
        if (!record) return;

        const data = record.data;
        const currentBalance = parseFloat(data["Wallet balance"] || 0);
        const currentPlanName = data["User_Plan"] || 'Bronze';
        
        if (currentBalance <= 0) return;

        const plan = _plans.find(p => p.name.toLowerCase() === currentPlanName.toLowerCase());
        if (!plan) return; 

        let planStartDate;
        if (data.planStartDate && typeof data.planStartDate.toDate === 'function') {
            planStartDate = data.planStartDate.toDate();
        } else {
            planStartDate = new Date(data.planStartDate || Date.now());
        }

        let lastRunDate;
        if (data.lastInterestApplied && typeof data.lastInterestApplied.toDate === 'function') {
            lastRunDate = data.lastInterestApplied.toDate();
        } else {
            lastRunDate = new Date(data.lastInterestApplied || planStartDate);
        }

        if (isNaN(lastRunDate.getTime())) {
            const nowTS = _fs.serverTimestamp ? _fs.serverTimestamp() : new Date();
            await _fs.setDoc(record.ref, { 
                planStartDate: nowTS, 
                lastInterestApplied: nowTS, 
                cycleAccumulatedInterest: 0,
                firstCycleProcessed: false
            }, { merge: true });
            return;
        }

        let anchor = new Date(lastRunDate);
        const now = new Date();
        let daysToCredit = 0;
        let requiresFlagUpdate = false;

        // --- PHASE 1: FIRST 24-HOUR & HEALING CHECK ---
        const firstCycleTarget = new Date(planStartDate.getTime() + MILLISECONDS_PER_DAY);
        const hasPassedFirst24h = now.getTime() >= firstCycleTarget.getTime();
        const isFlaggedAsPaid = data.firstCycleProcessed === true;

        if (hasPassedFirst24h && !isFlaggedAsPaid) {
            if (anchor.getTime() < firstCycleTarget.getTime()) {
                console.log("Phase 1: Paying First 24h cycle.");
                daysToCredit++;
                anchor = new Date(firstCycleTarget);
                requiresFlagUpdate = true; 
            } else {
                console.log("Phase 1: Healing missing flag (Already paid).");
                requiresFlagUpdate = true;
            }
        }

        let safetyCounter = 0;

        // --- PHASE 2: MIDNIGHT ALIGNMENT (STRICTLY UTC) ---
        while (safetyCounter < 365) {
            let nextMidnight = new Date(anchor);
            
            // Advance by 1 day and lock to exactly 00:00:00 UTC
            nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
            nextMidnight.setUTCHours(0, 0, 0, 0); 

            if (nextMidnight.getTime() <= anchor.getTime()) {
                nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
            }
            
            if (now.getTime() >= nextMidnight.getTime()) {
                daysToCredit++;
                anchor = new Date(nextMidnight);
                safetyCounter++;
            } else {
                break;
            }
        }
        
        if (requiresFlagUpdate && daysToCredit === 0) {
            try {
                if (_fs.updateDoc) {
                    await _fs.updateDoc(record.ref, { firstCycleProcessed: true });
                } else {
                    await _fs.setDoc(record.ref, { firstCycleProcessed: true }, { merge: true });
                }
            } catch(e) {}
        }

        const previousTimestamp = lastRunDate.getTime();
        const newTimestamp = anchor.getTime();

        if (daysToCredit > 0 && newTimestamp > previousTimestamp) {
            const dailyRate = (plan.rate / 100) / CYCLE_DURATION_DAYS;
            const interestToCredit = (currentBalance * dailyRate) * daysToCredit;

            if (_applyInterestFn) {
                try {
                    const secureTimestamp = _fs.serverTimestamp ? _fs.serverTimestamp() : new Date();

                    const res = await _applyInterestFn(_userId, interestToCredit, secureTimestamp, daysToCredit, true, requiresFlagUpdate);
                    
                    if (res && res.skipped) {
                        console.log("Engine: Cycle skipped to prevent double payment.");
                        return;
                    }
                    
                    const formattedInterest = new Intl.NumberFormat('en-NG', {style:'currency', currency:'NGN'}).format(interestToCredit);
                    
                    _pendingMessage = { 
                        msg: `Daily Interest: ${formattedInterest} credited for ${daysToCredit} day(s).`,
                        type: 'success'
                    };
                    
                    console.log(`Credited ₦${interestToCredit.toFixed(2)} interest for ${daysToCredit} days.`);
                } catch (e) { 
                    const isPermissionDenied = e.message && e.message.includes("permission-denied");
                    
                    if (isPermissionDenied) {
                        console.debug("Interest Engine: Cycle securely skipped or deferred by Rules.");
                    } else {
                        console.error("Interest Error:", e);
                        _pendingMessage = { msg: "Unable to process daily interest.", type: 'error' };
                    }
                }
            }
        }
    }

    return { init, attemptChange, getPlans, checkUpgradeAvailability, showNotification };
})();

window.InterestEngine = InterestEngine;