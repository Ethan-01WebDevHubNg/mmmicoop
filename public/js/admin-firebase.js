import { 
    db, 
    auth, 
    collection, 
    collectionGroup, 
    getDocs, 
    getDoc, 
    doc, 
    query, 
    where, 
    orderBy, 
    updateDoc, 
    runTransaction, 
    serverTimestamp,
    limit, 
    setDoc, 
    deleteDoc, 
    sendPasswordResetEmail, 
    functions, 
    httpsCallable,
    // Security/Config Imports
    firebaseConfig,
    initializeApp,
    deleteApp,
    getAuth,
    createUserWithEmailAndPassword,
    signOut
} from './firebase-init.js';

// No direct CDN imports here to prevent version/config conflicts.
// Everything is sourced from the central firebase-init.js file.

export { auth };

// --- SHARED UTILS ---

const roundMoney = (num) => Math.round((Number(num) + Number.EPSILON) * 100) / 100;

export const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(amount);
};

export const formatDate = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
};

// --- LOGIC CALCULATORS ---

export const calculateDailyCycle = (startDate, dailyAmount, accumulated) => {
    if (!startDate || !dailyAmount) return { day: 0, status: 'N/A', diff: 0 };

    const start = startDate.toDate ? startDate.toDate() : new Date(startDate);
    start.setHours(0, 0, 0, 0);
    
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const timeDiff = now - start;
    const daysElapsed = Math.floor(timeDiff / (1000 * 60 * 60 * 24)) + 1;
    
    const currentDay = daysElapsed > 0 ? daysElapsed : 1;

    const expectedTotal = currentDay * dailyAmount;
    const actualTotal = accumulated || 0;
    const balance = actualTotal - expectedTotal;
    const daysDiff = Math.floor(balance / dailyAmount);

    return {
        currentDay,
        daysDiff, 
        expectedTotal
    };
};

export const getCycleProgress = (planStartDate) => {
    if (!planStartDate) return "Cycle: N/A";
    
    const start = planStartDate.toDate ? planStartDate.toDate() : new Date(planStartDate);
    start.setHours(0, 0, 0, 0);
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const CYCLE_LENGTH = 90; 
    
    const timeDiff = now - start;
    let daysElapsed = Math.floor(timeDiff / (1000 * 60 * 60 * 24)) + 1;
    
    if (daysElapsed < 1) daysElapsed = 1;
    
    return `Day ${daysElapsed} of ${CYCLE_LENGTH}`;
};

// --- WITHDRAWAL & TRANSACTION LOGIC ---

export async function fetchPendingWithdrawals() {
    try {
        const q = query(
            collectionGroup(db, 'transactions'),
            where('status', '==', 'Pending'),
            orderBy('date', 'desc')
        );
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => {
            const data = d.data();
            const userId = data.userId || d.ref.parent.parent.id;
            return { id: d.id, userId, ...data, ref: d.ref };
        });
    } catch (e) {
        console.error("Error fetching withdrawals:", e);
        throw new Error("Unable to load withdrawal requests.");
    }
}

export async function approveWithdrawal(txnPath, txnId) {
    try {
        const txnRef = doc(db, txnPath);
        await updateDoc(txnRef, {
            status: 'Success',
            adminActionDate: serverTimestamp(),
            adminAction: 'Approved'
        });
        return { success: true };
    } catch (e) {
        console.error("Approval Error:", e);
        throw new Error("Approval failed. Please try again.");
    }
}

/**
 * REJECT WITHDRAWAL
 */
export async function rejectWithdrawal(uid, txnId, amountToRefund) {
    if (!uid || !txnId) throw new Error("Invalid parameters for rejection.");
    
    try {
        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", uid);
            const txnRef = doc(db, "users", uid, "transactions", txnId);
            
            const userDoc = await transaction.get(userRef);
            const txnDoc = await transaction.get(txnRef);

            if (!userDoc.exists()) throw new Error("User profile not found.");
            if (!txnDoc.exists()) throw new Error("Transaction record not found.");
            
            const txnData = txnDoc.data();
            const relatedFees = txnData.related_fees || [];
            const isDaily = txnData.category === 'daily'; 
            
            let walletRefundTotal = roundMoney(amountToRefund);
            let interestRestorationTotal = 0;
            let restoredDailyAmount = 0; 

            for (const fee of relatedFees) {
                const feeAmt = roundMoney(fee.amount);
                
                if (fee.type === 'INTEREST_REVOCATION') {
                    interestRestorationTotal += feeAmt;
                } else if (fee.type === 'FEE_SERVICE') {
                    restoredDailyAmount = feeAmt;
                    walletRefundTotal += feeAmt; 
                } else {
                    walletRefundTotal += feeAmt;
                }
                
                const feeRef = doc(db, "users", uid, "transactions", fee.id);
                transaction.update(feeRef, { adminAction: 'Auto-Refunded due to Rejection' });

                const feeRefundId = `txn-refund-${fee.type}-${Date.now()}`;
                transaction.set(doc(db, "users", uid, "transactions", feeRefundId), {
                    transactionId: feeRefundId, userId: uid, amount: feeAmt, type: 'Credit',
                    category: isDaily ? 'daily' : 'savings', sub_type: 'REFUND_REVERSAL',
                    related_transaction_id: fee.id,
                    description: fee.type === 'INTEREST_REVOCATION' ? 'Refund: Interest Restored' : 'Refund: Fee Reversal',
                    status: 'Success', date: new Date()
                });
            }

            if (isDaily) {
                let daily = userDoc.data().dailyContribution || {};
                const snapshot = txnData.cycle_snapshot;

                if (daily.isActive === false) {
                    daily.isActive = true;
                    if (snapshot) {
                         if (snapshot.startDate) daily.startDate = snapshot.startDate;
                         if (snapshot.dailyAmount) daily.dailyAmount = Number(snapshot.dailyAmount);
                    } else {
                        if (restoredDailyAmount > 0) daily.dailyAmount = restoredDailyAmount;
                        if (!daily.startDate) daily.startDate = txnData.date || new Date().toISOString();
                    }
                }

                const newAccumulated = roundMoney((Number(daily.accumulated) || 0) + walletRefundTotal + interestRestorationTotal);
                daily.accumulated = newAccumulated;
                const divAmount = (daily.dailyAmount > 0) ? daily.dailyAmount : 1;
                daily.count = Math.floor(newAccumulated / divAmount);

                transaction.update(userRef, { dailyContribution: daily });
            } else {
                const currentBalance = Number(userDoc.data()["Wallet balance"] || 0);
                const currentCycleInterest = Number(userDoc.data().cycleAccumulatedInterest || 0);

                transaction.update(userRef, {
                    "Wallet balance": roundMoney(currentBalance + walletRefundTotal),
                    "cycleAccumulatedInterest": roundMoney(currentCycleInterest + interestRestorationTotal)
                });
            }

            transaction.update(txnRef, {
                status: 'Rejected',
                adminActionDate: serverTimestamp(),
                adminAction: 'Rejected - Refunded'
            });

            const refundTxnRef = doc(db, "users", uid, "transactions", `txn-refund-${Date.now()}`);
            transaction.set(refundTxnRef, {
                transactionId: `txn-refund-${Date.now()}`,
                userId: uid, amount: roundMoney(amountToRefund), type: 'Credit',
                category: isDaily ? 'daily' : 'refund', sub_type: "REFUND_REVERSAL",
                related_transaction_id: txnId, description: `Refund for Rejected Withdrawal (${txnId})`,
                status: 'Success', date: new Date()
            });
        });
        return { success: true };
    } catch (e) {
        console.error("Rejection Error:", e);
        throw e; // Bubble up sanitized or original error
    }
}

/**
 * ULTIMATE REVERSE (Atomic & Linked)
 * Updated to handle 3 Specific Scenarios for Daily Contribution
 */
export async function reverseTransaction(uid, txnId, adminEmail) {
    if (!uid || !txnId) throw new Error("Invalid parameters.");

    try {
        await runTransaction(db, async (transaction) => {
            // PHASE 1: READ EVERYTHING 
            const userRef = doc(db, "users", uid);
            const txnRef = doc(db, "users", uid, "transactions", txnId);
            
            const userDoc = await transaction.get(userRef);
            const txnDoc = await transaction.get(txnRef);

            if (!userDoc.exists()) throw new Error("User not found.");
            if (!txnDoc.exists()) throw new Error("Transaction not found.");

            const txn = txnDoc.data();
            const userData = userDoc.data();

            if (txn.status !== 'Success') throw new Error("Only successful transactions can be reversed.");
            if ((txn.adminAction || "").includes("Ultimate Reversal")) throw new Error("Transaction has already been reversed.");

            let linkedRef = null;
            let linkedDoc = null;
            let linkedTxn = null;

            if (txn.related_transaction_id) {
                linkedRef = doc(db, "users", uid, "transactions", txn.related_transaction_id);
                linkedDoc = await transaction.get(linkedRef);
                if (linkedDoc.exists()) linkedTxn = linkedDoc.data();
            }

            const feeReads = [];
            const queueFeeReads = (feesList) => {
                if (feesList && Array.isArray(feesList)) {
                    feesList.forEach(fee => {
                        const feeRef = doc(db, "users", uid, "transactions", fee.id);
                        feeReads.push({ meta: fee, ref: feeRef }); 
                    });
                }
            };

            queueFeeReads(txn.related_fees);
            if (linkedTxn) queueFeeReads(linkedTxn.related_fees);

            const feeDocs = [];
            for (const item of feeReads) {
                const fDoc = await transaction.get(item.ref);
                if (fDoc.exists()) feeDocs.push({ ref: item.ref, data: fDoc.data(), meta: item.meta });
            }

            // PHASE 2: CALCULATE & PREPARE WRITES
            let walletChange = 0;
            let dailyAccumulatedChange = 0;
            let savingsInterestChange = 0;
            let restoreDailyCycle = false;
            let restoredDailyAmount = 0;
            const isOriginalCredit = txn.type === 'Credit';
            const reversalType = isOriginalCredit ? 'Debit' : 'Credit';
            const modifier = isOriginalCredit ? -1 : 1; 
            const amount = roundMoney(txn.amount);

            // Attempt to find Daily Service Fee
            if (linkedTxn && linkedTxn.related_fees) {
                const svc = linkedTxn.related_fees.find(x => x.type === 'FEE_SERVICE');
                if (svc) restoredDailyAmount = svc.amount;
            }
            if (txn.related_fees) {
                const svc = txn.related_fees.find(x => x.type === 'FEE_SERVICE');
                if (svc) restoredDailyAmount = svc.amount;
            }

            const processFeeLogic = (feeDocObj) => {
                const { ref, data, meta } = feeDocObj;
                if (meta.id === txnId) return; // Don't process self if self is a fee

                if (data.status === 'Success') {
                    transaction.update(ref, { adminAction: 'Auto-Reversed via Parent' });
                    const amt = roundMoney(meta.amount);
                    if (meta.type === 'INTEREST_REVOCATION') {
                        savingsInterestChange += amt;
                    } else if (meta.type === 'FEE_SERVICE') {
                        restoredDailyAmount = amt;
                        dailyAccumulatedChange += amt;
                    } else {
                        if (data.category === 'daily') dailyAccumulatedChange += amt;
                        else walletChange += amt;
                    }

                    const feeRevId = `txn-rev-fee-${meta.id}-${Date.now()}`;
                    transaction.set(doc(db, "users", uid, "transactions", feeRevId), {
                        transactionId: feeRevId, userId: uid, amount: amt, type: 'Credit',
                        category: data.category, sub_type: 'REFUND_REVERSAL',
                        related_transaction_id: meta.id, description: `Auto-Reversal of Fee ${meta.id}`,
                        status: 'Success', date: new Date()
                    });
                }
            };
            feeDocs.forEach(processFeeLogic);

            if (txn.category === 'daily') {
                dailyAccumulatedChange += (amount * modifier);
                if (txn.type === 'Debit') restoreDailyCycle = true;
            } else {
                walletChange += (amount * modifier);
            }

            if (linkedTxn && linkedTxn.status === 'Success') {
                transaction.update(linkedRef, { adminAction: 'Auto-Reversed via Link' });
                const linkedAmt = roundMoney(linkedTxn.amount);
                const linkedModifier = linkedTxn.type === 'Credit' ? -1 : 1; 
                if (linkedTxn.category === 'daily') {
                    dailyAccumulatedChange += (linkedAmt * linkedModifier);
                    if (linkedTxn.type === 'Debit') restoreDailyCycle = true;
                } else {
                    walletChange += (linkedAmt * linkedModifier);
                }
                const linkedRevId = `txn-rev-link-${Date.now()}`;
                transaction.set(doc(db, "users", uid, "transactions", linkedRevId), {
                    transactionId: linkedRevId, userId: uid, amount: linkedAmt,
                    type: linkedTxn.type === 'Credit' ? 'Debit' : 'Credit',
                    category: linkedTxn.category, sub_type: 'ADMIN_REVERSAL',
                    related_transaction_id: txn.related_transaction_id, description: `Auto-Reversal of Linked ${txn.related_transaction_id}`,
                    status: 'Success', date: new Date()
                });
            }

            // PHASE 3: EXECUTE PROFILE UPDATES
            if (walletChange !== 0) {
                const newBal = roundMoney((Number(userData["Wallet balance"] || 0)) + walletChange);
                transaction.update(userRef, { "Wallet balance": newBal });
            }

            if (savingsInterestChange !== 0) {
                const newInterest = roundMoney((Number(userData.cycleAccumulatedInterest || 0)) + savingsInterestChange);
                transaction.update(userRef, { cycleAccumulatedInterest: newInterest });
            }

            // --- STRICT DAILY CONTRIBUTION LOGIC (RESTORED) ---
            if (dailyAccumulatedChange !== 0 || restoreDailyCycle) {
                let daily = userData.dailyContribution || {};
                
                const snapshot = txn.cycle_snapshot || (linkedTxn ? linkedTxn.cycle_snapshot : null);
                let targetDailyAmount = 0;
                if (snapshot && snapshot.dailyAmount) targetDailyAmount = Number(snapshot.dailyAmount);
                else if (restoredDailyAmount > 0) targetDailyAmount = restoredDailyAmount;
                else if (daily.dailyAmount > 0) targetDailyAmount = daily.dailyAmount;

                const newAccumulated = roundMoney((Number(daily.accumulated) || 0) + dailyAccumulatedChange);
                daily.accumulated = newAccumulated;

                // SCENARIO 1: Penalty Only Reversal
                if (txn.sub_type === 'FEE_PENALTY_EARLY') {
                    daily.isActive = false;      // Explicitly Inactive
                    daily.startDate = null; 
                    daily.dailyAmount = 0;       // No new fees
                    daily.count = 0;
                    // Accumulated has money (Grace Withdrawal state)
                } 
                // SCENARIO 2: Service Fee Only Reversal
                else if (txn.sub_type === 'FEE_SERVICE') {
                    daily.isActive = true;
                    // Start Fresh Cycle NOW
                    daily.startDate = new Date().toISOString(); 
                    daily.lastContributionDate = new Date().toISOString();
                    // Use the specific reversed amount as the new plan amount
                    daily.dailyAmount = amount; 
                    const rate = daily.dailyAmount > 0 ? daily.dailyAmount : 1;
                    daily.count = Math.floor(newAccumulated / rate);
                }
                // SCENARIO 3: Standard Atomic Reversal (Parent/Net)
                else {
                    daily.isActive = true;
                    daily.dailyAmount = targetDailyAmount;
                    
                    // Resurrect Snapshot Date (Last Closed Cycle)
                    if (snapshot && snapshot.startDate) {
                        daily.startDate = snapshot.startDate;
                    } else if (!daily.startDate) {
                         // Fallback if snapshot missing
                         daily.startDate = new Date().toISOString();
                    }
                    
                    if (snapshot && snapshot.lastContributionDate) daily.lastContributionDate = snapshot.lastContributionDate;

                    const rate = daily.dailyAmount > 0 ? daily.dailyAmount : 1;
                    daily.count = Math.floor(newAccumulated / rate);
                }

                transaction.update(userRef, { dailyContribution: daily });
            }

            // PHASE 4: FINALIZE
            transaction.update(txnRef, {
                status: 'Reversed', lastUpdatedBy: adminEmail, lastUpdatedAt: serverTimestamp(), adminAction: 'Ultimate Reversal Performed'
            });
            const revTxnId = `txn-rev-${Date.now()}`;
            transaction.set(doc(db, "users", uid, "transactions", revTxnId), {
                transactionId: revTxnId, userId: uid, amount: amount, type: reversalType,
                category: txn.category, sub_type: 'ADMIN_REVERSAL', related_transaction_id: txnId,
                description: `Reversal of ${txnId}`, status: 'Success', date: new Date(), performedBy: adminEmail
            });
        });
        
        return { success: true };
    } catch (e) {
        console.error("Ultimate Reversal Error:", e);
        throw e;
    }
}

export async function updateTransactionStatus(uid, txnId, newStatus) {
    const txnRef = doc(db, "users", uid, "transactions", txnId);
    await updateDoc(txnRef, { status: newStatus, lastUpdatedBy: 'Admin', lastUpdatedAt: serverTimestamp() });
}

// --- USER & ADMIN MANAGEMENT ---

export async function checkUserPendingTransactions(uid) {
    try {
        const q = query(
            collection(db, "users", uid, "transactions"), 
            where("status", "==", "Pending"),
            limit(1) 
        );
        const snap = await getDocs(q);
        return !snap.empty;
    } catch (e) {
        console.error("Error checking pending txns:", e);
        return true; 
    }
}

export async function getAllMembers(limitCount = 100) {
    // 🛑 LEGACY DATA SAFEGUARD:
    const q = query(collection(db, "users"), limit(limitCount + 50));
    const snap = await getDocs(q);
    
    // Client-side filter: Only return users who are NOT deleted.
    return snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.isDeleted !== true);
}

export async function getDeletedMembers() {
    const q = query(collection(db, "users"), where("isDeleted", "==", true));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

export async function getMemberDetails(uid) {
    const docSnap = await getDoc(doc(db, "users", uid));
    if(docSnap.exists()) return { uid: docSnap.id, ...docSnap.data() };
    return null;
}

export async function updateMemberProfile(uid, data) {
    const userRef = doc(db, "users", uid);
    await updateDoc(userRef, data);
    return { success: true };
}

export async function toggleMemberStatus(uid, isActive) {
    const userRef = doc(db, "users", uid);
    await updateDoc(userRef, { isAccountActive: isActive });
}

export async function deleteMember(uid) {
    try {
        const deleteUserFunc = httpsCallable(functions, 'deleteUser');
        await deleteUserFunc({ uid: uid });
        return { success: true };
    } catch (e) {
        console.error("Delete Member Error:", e);
        throw new Error("Unable to archive member. Please check logs.");
    }
}

export async function createAdminUser(adminData) {
    let secondaryApp = null;
    try {
        // Init Secondary App using SHARED CONFIG from firebase-init.js
        secondaryApp = initializeApp(firebaseConfig, "SecondaryApp");
        const secondaryAuth = getAuth(secondaryApp);
        
        const userCred = await createUserWithEmailAndPassword(secondaryAuth, adminData.email, adminData.password);
        const newUid = userCred.user.uid;
        
        await setDoc(doc(db, "admins", newUid), {
            name: adminData.name, email: adminData.email, phoneNumber: adminData.phoneNumber || "",
            role: adminData.role, isActive: true, createdAt: new Date().toISOString(), createdBy: "Super Admin"
        });
        
        await signOut(secondaryAuth);
        return { success: true };
    } catch (error) { 
        console.error("Create Admin Error:", error);
        throw new Error("Failed to create admin. Email might be in use."); 
    } finally { 
        if (secondaryApp) await deleteApp(secondaryApp); 
    }
}

export async function sendAdminPasswordReset() {
    const user = auth.currentUser;
    if (!user) throw new Error("No authenticated user found.");
    await sendPasswordResetEmail(auth, user.email);
    return user.email;
}

// --- SAVINGS PLAN MANAGEMENT ---
export async function createSavingsPlan(planData) {
    const docId = planData.name.trim().toLowerCase().replace(/\s+/g, '_');
    await setDoc(doc(db, "savings_plans", docId), { ...planData, isActive: true, createdAt: serverTimestamp() });
    return { success: true };
}
export async function updateSavingsPlan(planId, updates) {
    await updateDoc(doc(db, "savings_plans", planId), updates);
    return { success: true };
}
export async function deleteSavingsPlan(planId) {
    await deleteDoc(doc(db, "savings_plans", planId));
    return { success: true };
}
export async function getSavingsPlans() {
    const q = query(collection(db, "savings_plans"), orderBy("rank", "asc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}