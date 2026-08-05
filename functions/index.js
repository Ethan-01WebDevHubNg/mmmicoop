import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as functionsV1 from "firebase-functions/v1"; 
import { defineSecret } from "firebase-functions/params";

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import axios from "axios";
import { RecaptchaEnterpriseServiceClient } from "@google-cloud/recaptcha-enterprise";

// --- SECRETS CONFIGURATION ---
const squadTestKey = defineSecret('SQUAD_TEST_KEY');
const squadLiveKey = defineSecret('SQUAD_LIVE_KEY');

const IS_PROD = true; 

// --- INITIALIZATION ---
if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

let recaptchaClient = null;

// =========================================================
// 1. RECAPTCHA VERIFICATION (Gen 2)
// =========================================================
export const verifyRecaptcha = onCall(
    { region: "us-central1" }, 
    async (request) => {
        const { token, action } = request.data;
        const projectID = "mmmi-cooperative-portal"; 
        const recaptchaKey = "6Lc_9DIsAAAAAK5CvT8tlPhK-vWeVp25Xcb7nWi3"; 

        if (!token) throw new HttpsError("invalid-argument", "Missing reCAPTCHA token.");

        try {
            if (!recaptchaClient) {
                recaptchaClient = new RecaptchaEnterpriseServiceClient();
            }

            const projectPath = recaptchaClient.projectPath(projectID);
            const assessmentRequest = {
                assessment: { event: { token: token, siteKey: recaptchaKey, expectedAction: action } },
                parent: projectPath,
            };
            const [response] = await recaptchaClient.createAssessment(assessmentRequest);

            if (!response.tokenProperties.valid) return { success: false, error: "Invalid Token" };
            if (response.tokenProperties.action !== action) return { success: false, error: "Action Mismatch" };

            return { success: response.riskAnalysis.score >= 0.5, score: response.riskAnalysis.score };
        } catch (error) {
            console.error("reCAPTCHA Error:", error);
            throw new HttpsError("internal", "Verification service unavailable.");
        }
    }
);

// =========================================================
// 2. DASHBOARD AGGREGATION (Gen 1)
// =========================================================
const STATS_DOC_REF = db.collection("metadata").doc("dashboard_stats");

export const aggregateTransactions = functionsV1.region("europe-west1")
    .firestore.document("users/{userId}/transactions/{txnId}")
    .onWrite(async (change, context) => {
        const beforeData = change.before ? change.before.data() : null;
        const afterData = change.after ? change.after.data() : null;

        let inflowDelta = 0;
        let outflowDelta = 0;

        const processSnapshot = (dataObj, multiplier) => {
            if (!dataObj || dataObj.status !== 'Success') return; 
            const amount = Number(dataObj.amount) || 0;
            if (dataObj.type === 'Credit') inflowDelta += (amount * multiplier);
            else if (dataObj.type === 'Debit') outflowDelta += (amount * multiplier);
        };

        processSnapshot(beforeData, -1);
        processSnapshot(afterData, 1);

        if (inflowDelta === 0 && outflowDelta === 0) return;

        try {
            await STATS_DOC_REF.set({
                totalInflow: FieldValue.increment(inflowDelta),
                totalOutflow: FieldValue.increment(outflowDelta),
                lastUpdated: FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (error) {
            console.error("Aggregation Failed", error);
        }
    });

// =========================================================
// 3. SECURE DEPOSIT (Gen 2)
// =========================================================
export const verifyAndCreditTopUp = onCall(
    { 
        region: "us-central1",
        secrets: [squadTestKey, squadLiveKey] 
    }, 
    async (request) => {
        const SQUAD_SECRET_KEY = IS_PROD ? squadLiveKey.value() : squadTestKey.value();
        const BASE_URL = IS_PROD ? "https://api-d.squadco.com" : "https://sandbox-api-d.squadco.com";
        
        console.log(`Processing Deposit in ${IS_PROD ? 'LIVE' : 'SANDBOX'} mode`);

        const { reference, userId, userToken, category = 'savings' } = request.data;
        
        if (!userToken) throw new HttpsError('unauthenticated', 'Missing Auth Token.');
        if (!reference) throw new HttpsError('invalid-argument', 'Missing Transaction Reference.');

        try {
            const { getAuth } = await import("firebase-admin/auth");
            
            const decodedToken = await getAuth().verifyIdToken(userToken, true);
            if (decodedToken.uid !== userId) throw new HttpsError('permission-denied', 'User mismatch.');

            const existingTxn = await db.collection("users").doc(userId)
                .collection("transactions").where("reference", "==", reference).get();
            if (!existingTxn.empty) return { success: true, message: "Transaction already processed." };

            const squadUrl = `${BASE_URL}/transaction/verify/${reference}`;
            const response = await axios.get(squadUrl, {
                headers: { "Authorization": `Bearer ${SQUAD_SECRET_KEY}` }
            });

            const resData = response.data;
            if (!resData.status || resData.data.transaction_status !== "success") {
                throw new HttpsError('aborted', 'Payment verification failed or pending.');
            }

            const koboAmount = Number(resData.data.transaction_amount);
            const amountInNaira = koboAmount / 100;

            await db.runTransaction(async (t) => {
                const userRef = db.collection("users").doc(userId);
                const userDoc = await t.get(userRef);
                if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');

                const userData = userDoc.data();
                const txnId = `txn-${Date.now()}`;
                const txnRef = userRef.collection("transactions").doc(txnId);
                const serverTime = FieldValue.serverTimestamp();

                if (category === 'daily') {
                    let daily = userData.dailyContribution || { isActive: false, dailyAmount: 0, count: 0, accumulated: 0 };
                    
                    if (!daily.isActive) {
                        daily.isActive = true;
                        daily.startDate = new Date().toISOString();
                        daily.dailyAmount = amountInNaira;
                        daily.lastContributionDate = new Date().toISOString();
                        daily.count = 1;
                        daily.accumulated = amountInNaira;
                    } else {
                        daily.count = (Number(daily.count) || 0) + 1;
                        daily.accumulated = (Number(daily.accumulated) || 0) + amountInNaira;
                        daily.lastContributionDate = new Date().toISOString();
                    }

                    t.update(userRef, { 
                        "dailyContribution": daily,
                        "Credit_Transactions": FieldValue.increment(1)
                    });

                    t.set(txnRef, {
                        transactionId: txnId,
                        userId: userId,
                        amount: amountInNaira,
                        type: "Credit",
                        category: "daily",
                        sub_type: "DEPOSIT",
                        status: "Success",
                        reference: reference,
                        date: serverTime,
                        description: "Daily Contribution Deposit",
                        payment_gateway_ref: resData.data.transaction_ref
                    });

                } else {
                    const newBalance = (Number(userData["Wallet balance"]) || 0) + amountInNaira;
                    t.update(userRef, { 
                        "Wallet balance": newBalance,
                        "Credit_Transactions": FieldValue.increment(1)
                    });
                    t.set(txnRef, {
                        transactionId: txnId,
                        userId: userId,
                        amount: amountInNaira,
                        type: "Credit",
                        category: "savings", 
                        sub_type: "DEPOSIT",
                        status: "Success",
                        reference: reference,
                        date: serverTime,
                        description: "Wallet Top-up",
                        payment_gateway_ref: resData.data.transaction_ref
                    });
                }
            });

            return { success: true, amount: amountInNaira };

        } catch (error) {
            console.error("TopUp Error:", error);
            if (error.code === 'auth/id-token-revoked') {
                throw new HttpsError('unauthenticated', 'Session expired or logged out on another device.');
            }
            if (error instanceof HttpsError) throw error;
            throw new HttpsError('internal', error.message || 'Payment processing failed.');
        }
    }
);

// =========================================================
// 4. ADMIN USER MANAGEMENT (Gen 2)
// =========================================================
export const deleteUser = onCall(
    { region: "us-central1" }, 
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'User must be logged in.');
        const targetUid = request.data.uid;
        if (!targetUid) throw new HttpsError('invalid-argument', 'UID required.');

        try {
            const { getAuth } = await import("firebase-admin/auth");

            await getAuth().updateUser(targetUid, { disabled: true });
            await getAuth().revokeRefreshTokens(targetUid);
            await db.collection("users").doc(targetUid).update({
                isDeleted: true,
                isAccountActive: false,
                deletedAt: FieldValue.serverTimestamp(),
                previousStatus: 'Archived'
            });
            return { success: true };
        } catch (error) {
            console.error("Error archiving user:", error);
            if (error.code === 'auth/user-not-found') {
                 try {
                    await db.collection("users").doc(targetUid).update({
                        isDeleted: true,
                        deletedAt: FieldValue.serverTimestamp()
                    });
                    return { success: true };
                 } catch(e) { throw new HttpsError('internal', 'DB archive failed.'); }
            }
            throw new HttpsError('internal', 'Unable to archive user.');
        }
    }
);

// =========================================================
// 6. NOTIFICATION SYSTEM (Gen 2)
// =========================================================
export const subscribeToBroadcast = onCall(
    { region: "us-central1" },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'User must be logged in.');
        
        const { fcmToken } = request.data;
        if (!fcmToken) throw new HttpsError('invalid-argument', 'Token required.');

        try {
            await getMessaging().subscribeToTopic(fcmToken, 'broadcast');
            
            await db.collection('users').doc(request.auth.uid).set({
                fcmToken: fcmToken,
                notificationsEnabled: true,
                lastTokenUpdate: FieldValue.serverTimestamp()
            }, { merge: true });

            return { success: true };
        } catch (error) {
            console.error("Sub Error:", error);
            throw new HttpsError('internal', 'Subscription failed.');
        }
    }
);

export const sendBroadcast = onCall(
    { region: "us-central1" },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
        
        const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
        if (!adminDoc.exists) throw new HttpsError('permission-denied', 'Not an admin.');

        const { title, body, imageUrl } = request.data;

        if (!title || !body) {
            throw new HttpsError('invalid-argument', 'Broadcast title and body cannot be empty.');
        }

        const message = {
            notification: {
                title: title,
                body: body,
            },
            data: {
                url: '/member/memberDashboard.html',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            topic: 'broadcast'
        };

        if (imageUrl) {
            message.notification.image = imageUrl;
        }

        try {
            const response = await getMessaging().send(message);
            return { success: true, messageId: response };
        } catch (error) {
            console.error("Broadcast Error:", error);
            throw new HttpsError('internal', 'Broadcast failed.');
        }
    }
);