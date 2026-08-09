import { 
    db, 
    doc, 
    runTransaction, 
    functions, 
    httpsCallable, 
    auth,
    toKobo,     
    fromKobo    
} from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const SAVINGS_CYCLE_DAYS = 90;

const waitForAuth = () => {
    return new Promise((resolve) => {
        if (auth.currentUser) { resolve(auth.currentUser); return; }
        const unsubscribe = onAuthStateChanged(auth, (user) => { unsubscribe(); resolve(user); });
    });
};

// --- 1. SECURE DEPOSIT FUNCTIONS ---

export async function recordTopUp(uid, amount, reference) {
    return await executeSecureDeposit(uid, amount, reference, 'savings');
}

export async function processDailyDeposit(uid, amount, reference) {
    return await executeSecureDeposit(uid, amount, reference, 'daily');
}

async function executeSecureDeposit(uid, amount, reference, category) {
    const user = await waitForAuth();
    if (!user) throw new Error("User session invalid.");
    if (user.uid !== uid) throw new Error("Security Mismatch.");

    try {
        const idToken = await user.getIdToken(true);
        const verifyFn = httpsCallable(functions, 'verifyAndCreditTopUp');
        
        const result = await verifyFn({ 
            reference: reference, 
            userId: uid,
            userToken: idToken,
            category: category
        });
        
        return result.data; 
    } catch (e) {
        console.error(`${category} Deposit failed: `, e); 
        const msg = e.message || "Payment verification failed";
        if (msg.includes("ALREADY_PROCESSED") || msg.includes("Transaction already processed")) {
             throw new Error("Transaction already recorded.");
        }
        throw new Error("Unable to verify deposit. Please contact support if debited.");
    }
}

// --- 2. LOCAL LOGIC (IDEMPOTENCY HARDENED) ---

export async function recordWithdrawal(uid, memberId, amountRequest, bankDetails) {
    if (!uid) throw new Error("User ID is required.");

    // Generate IDs outside the transaction loop to prevent duplicates on retries
    const ts = Date.now();
    const now = new Date(); 
    const mainTxnId = `txn-${memberId}-${ts}`;
    const penTxnId = `txn-pen-${ts}`;
    const fftTxnId = `txn-fft-${ts}`;
    
    const mainRef = `WDR-${ts}`;
    const penRef = `PEN-${ts}`;
    const fftRef = `INT-RVK-${ts}`;

    try {
        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", uid);
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists()) throw new Error("User profile not found. Please contact support.");

            const data = userDoc.data();
            
            // CONVERT TO KOBO (Integers)
            const currentBalanceKobo = toKobo(data["Wallet balance"] || 0);
            const requestKobo = toKobo(amountRequest);
            const cycleInterestPaidKobo = toKobo(data.cycleAccumulatedInterest || 0);

            if (requestKobo > currentBalanceKobo) {
                throw new Error(`Insufficient funds. Available Balance: ₦${fromKobo(currentBalanceKobo).toLocaleString()}`);
            }

            const planStart = data.planStartDate ? new Date(data.planStartDate) : new Date();
            
            const diffTime = Math.abs(now - planStart);
            const daysPassed = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            const isMature = daysPassed >= SAVINGS_CYCLE_DAYS;
            
            let finalPayoutKobo = 0;
            let penaltyKobo = 0;
            let interestForfeitKobo = 0;
            let description = "";

            if (isMature) {
                finalPayoutKobo = requestKobo;
                description = "Savings Withdrawal (Mature Cycle)";
                transaction.update(userRef, { cycleAccumulatedInterest: 0 });
            } else {
                penaltyKobo = Math.round(requestKobo * 0.01); 
                interestForfeitKobo = cycleInterestPaidKobo; 
                
                const totalDeductionKobo = penaltyKobo + interestForfeitKobo;
                finalPayoutKobo = requestKobo - totalDeductionKobo;

                if (finalPayoutKobo < 0) throw new Error("Withdrawal amount is too low to cover early withdrawal fees.");
                description = `Early Withdrawal (Day ${daysPassed}/${SAVINGS_CYCLE_DAYS})`;
                transaction.update(userRef, { cycleAccumulatedInterest: 0 });
            }

            const newBalanceKobo = currentBalanceKobo - requestKobo;

            let updates = {
                "Wallet balance": fromKobo(newBalanceKobo),
                "Debit_transactions": (data["Debit_transactions"] || 0) + 1
            };
            transaction.update(userRef, updates);

            const feeBreakdown = []; 

            if (penaltyKobo > 0) {
                const penAmt = fromKobo(penaltyKobo);
                feeBreakdown.push({ id: penTxnId, amount: penAmt, type: 'FEE_PENALTY_EARLY' });
                transaction.set(doc(db, "users", uid, "transactions", penTxnId), {
                    transactionId: penTxnId, userId: uid, amount: penAmt, type: "Debit", category: "savings",
                    sub_type: "FEE_PENALTY_EARLY", related_transaction_id: mainTxnId, description: "Early Withdrawal Penalty (1%)",
                    status: "Success", reference: penRef, date: now
                });
            }

            if (interestForfeitKobo > 0) {
                const fftAmt = fromKobo(interestForfeitKobo);
                feeBreakdown.push({ id: fftTxnId, amount: fftAmt, type: 'INTEREST_REVOCATION' });
                transaction.set(doc(db, "users", uid, "transactions", fftTxnId), {
                    transactionId: fftTxnId, userId: uid, amount: fftAmt, type: "Debit", category: "savings",
                    sub_type: "INTEREST_REVOCATION", related_transaction_id: mainTxnId, description: "Interest Forfeited (Early Withdrawal)",
                    status: "Success", reference: fftRef, date: now
                });
            }

            transaction.set(doc(db, "users", uid, "transactions", mainTxnId), {
                transactionId: mainTxnId, userId: uid, memberId: memberId, amount: fromKobo(finalPayoutKobo), ...bankDetails,
                description: description, status: "Pending", type: "Debit", category: "savings",
                sub_type: "WITHDRAWAL_REQUEST", related_fees: feeBreakdown, reference: mainRef, date: now
            });
        });
        return { success: true };
    } catch (e) { throw e; }
}

export async function applyDailyInterest(uid, interestAmount, datePayload, daysToCredit = 1, isAccrual = false, needsFirstCycleFlag = false) {
    if (!uid || interestAmount <= 0) return;
    
    const ts = Date.now(); 
    const txId = `txn-int-${ts}`;
    const refId = `INT-${ts}`;
    
    const interestKobo = toKobo(interestAmount);

    try {
        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", uid);
            const userDoc = await transaction.get(userRef);
            const data = userDoc.data();

            // --- IDEMPOTENCY CHECK (Prevents Race Conditions & Stale Data Loops) ---
            let lastAppliedMillis = 0;
            if (data.lastInterestApplied) {
                lastAppliedMillis = typeof data.lastInterestApplied.toMillis === 'function' 
                    ? data.lastInterestApplied.toMillis() 
                    : new Date(data.lastInterestApplied).getTime();
            }
            const nowMillis = typeof datePayload.toMillis === 'function' ? datePayload.toMillis() : datePayload.getTime();
            
            // If interest was credited less than 12 hours ago, safely abort to prevent double-payments
            if (nowMillis - lastAppliedMillis < 43200000) {
                throw new Error("ALREADY_APPLIED");
            }
            
            const currentBalanceKobo = toKobo(data["Wallet balance"] || 0);
            const currentCycleInterestKobo = toKobo(data.cycleAccumulatedInterest || 0);

            const newBalance = fromKobo(currentBalanceKobo + interestKobo);
            const newAccumulated = fromKobo(currentCycleInterestKobo + interestKobo);

            let updates = {
                "Wallet balance": newBalance,
                "cycleAccumulatedInterest": newAccumulated,
                "lastInterestApplied": datePayload // Secure server timestamp for Rules
            };

            // Atomically flag the first 24h cycle alongside the payment
            if (needsFirstCycleFlag) {
                updates["firstCycleProcessed"] = true;
            }

            transaction.update(userRef, updates);

            transaction.set(doc(db, "users", uid, "transactions", txId), {
                transactionId: txId, 
                userId: uid, 
                amount: fromKobo(interestKobo), 
                type: "Credit", 
                category: "savings", 
                sub_type: "INTEREST_ACCRUAL", 
                description: "Daily Interest Credit", 
                reference: refId,  
                status: "Success", 
                date: datePayload,
                days: daysToCredit 
            });
        });
        return { success: true };
    } catch (e) { 
        if (e.message === "ALREADY_APPLIED") {
            console.log("Interest already applied recently. Transaction safely aborted.");
            return { success: true, skipped: true };
        }
        throw e; 
    }
}

export async function processDailyWithdrawal(uid, isEarly, destination = 'bank', memberId = null, bankDetails = {}) {
    const ts = Date.now();
    const date = new Date();
    
    const feeTxnId = `txn-daily-fee-${ts}`;
    const penTxnId = `txn-daily-pen-${ts}`;
    const transferInId = `txn-transfer-in-${ts}`;
    const transferOutId = `txn-transfer-out-${ts}`;
    const bankOutId = `txn-daily-out-${ts}`;
    
    const refFee = `FEE-${ts}`;
    const refPen = `PEN-${ts}`;
    const refTrfIn = `TRF-IN-${ts}`;
    const refTrfOut = `TRF-OUT-${ts}`;
    const refWdr = `WDR-DLY-${ts}`;

    try {
        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", uid);
            const userDoc = await transaction.get(userRef);
            const data = userDoc.data();
            const daily = data.dailyContribution;

            if (!daily || daily.accumulated <= 0) throw new Error("No available funds to withdraw.");

            if (!daily.isActive) {
                destination = 'bank'; 
                isEarly = false;      
                daily.dailyAmount = 0; 
            }

            const cycleSnapshot = {
                startDate: daily.startDate || null,
                dailyAmount: Number(daily.dailyAmount) || 0,
                lastContributionDate: daily.lastContributionDate || null,
                accumulatedAtWithdrawal: Number(daily.accumulated) || 0
            };

            const grossKobo = toKobo(daily.accumulated);
            const holdingFeeKobo = toKobo(daily.dailyAmount);
            const penaltyKobo = isEarly ? Math.round(grossKobo * 0.25) : 0;
            
            const netKobo = grossKobo - holdingFeeKobo - penaltyKobo;

            if (netKobo <= 0) throw new Error("Balance is too low after fees to process this withdrawal.");

            transaction.update(userRef, { dailyContribution: { isActive: false, accumulated: 0, count: 0, dailyAmount: 0, startDate: null, lastContributionDate: null } });

            const feeBreakdown = [];

            if (holdingFeeKobo > 0) {
                feeBreakdown.push({ id: feeTxnId, amount: fromKobo(holdingFeeKobo), type: 'FEE_SERVICE' });
            }

            if (penaltyKobo > 0) {
                feeBreakdown.push({ id: penTxnId, amount: fromKobo(penaltyKobo), type: 'FEE_PENALTY_EARLY' });
            }

            if (destination === 'savings') {
                const currentSavingsKobo = toKobo(data["Wallet balance"] || 0);
                const newSavingsKobo = currentSavingsKobo + netKobo;
                
                transaction.update(userRef, { "Wallet balance": fromKobo(newSavingsKobo) });

                transaction.set(doc(db, "users", uid, "transactions", transferInId), {
                    transactionId: transferInId,
                    userId: uid,
                    amount: fromKobo(netKobo),
                    type: "Credit",
                    category: "savings",
                    sub_type: "TRANSFER_IN",
                    related_transaction_id: transferOutId,
                    description: "Transfer from Daily Contribution",
                    reference: refTrfIn,
                    status: "Success",
                    date: date
                });

                transaction.set(doc(db, "users", uid, "transactions", transferOutId), {
                    transactionId: transferOutId,
                    userId: uid,
                    amount: fromKobo(netKobo), 
                    type: "Debit",
                    category: "daily",
                    sub_type: "TRANSFER_OUT",
                    related_transaction_id: transferInId,
                    description: "Transfer to Savings",
                    related_fees: feeBreakdown,
                    cycle_snapshot: cycleSnapshot,
                    reference: refTrfOut,
                    status: "Success",
                    date: date
                });

            } else {
                transaction.set(doc(db, "users", uid, "transactions", bankOutId), {
                    transactionId: bankOutId,
                    userId: uid,
                    memberId: memberId,
                    ...bankDetails,
                    amount: fromKobo(netKobo),
                    type: "Debit",
                    category: "daily",
                    sub_type: "WITHDRAWAL_REQUEST",
                    description: (!daily.isActive) ? "Grace Withdrawal (Penalty Reversal)" : (isEarly ? "Early Daily Withdrawal" : "Daily Cycle Withdrawal"),
                    related_fees: feeBreakdown, 
                    cycle_snapshot: cycleSnapshot,
                    reference: refWdr,
                    status: "Pending",
                    date: date
                });
            }

            if (holdingFeeKobo > 0) {
                transaction.set(doc(db, "users", uid, "transactions", feeTxnId), {
                    transactionId: feeTxnId,
                    userId: uid,
                    amount: fromKobo(holdingFeeKobo),
                    type: "Debit",
                    category: "daily",
                    sub_type: "FEE_SERVICE",
                    description: "Holding Fee (1 Day)",
                    reference: refFee,
                    status: "Success",
                    date: date
                });
            }

            if (penaltyKobo > 0) {
                transaction.set(doc(db, "users", uid, "transactions", penTxnId), {
                    transactionId: penTxnId,
                    userId: uid,
                    amount: fromKobo(penaltyKobo),
                    type: "Debit",
                    category: "daily",
                    sub_type: "FEE_PENALTY_EARLY",
                    description: "Early Withdrawal Penalty (25%)",
                    reference: refPen,
                    status: "Success",
                    date: date
                });
            }
        });
        return { success: true };
    } catch (e) { throw e; }
}