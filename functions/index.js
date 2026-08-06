const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require('firebase-functions/params'); 
const admin = require("firebase-admin");
const axios = require("axios");
const { RecaptchaEnterpriseServiceClient } = require("@google-cloud/recaptcha-enterprise");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const squadTestKey = defineSecret('SQUAD_TEST_KEY');
const squadLiveKey = defineSecret('SQUAD_LIVE_KEY');

const IS_PROD = true; 

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

let recaptchaClient;

exports.verifyRecaptcha = onCall(
    { region: "us-central1" }, 
    async (request) => {
        if (!recaptchaClient) {
            recaptchaClient = new RecaptchaEnterpriseServiceClient();
        }

        const { token, action } = request.data;
        const projectID = "mmmi-cooperative-portal"; 
        const recaptchaKey = "6Lc_9DIsAAAAAK5CvT8tlPhK-vWeVp25Xcb7nWi3"; 

        if (!token) throw new HttpsError("invalid-argument", "Missing reCAPTCHA token.");

        try {
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

const STATS_DOC_REF = db.collection("metadata").doc("dashboard_stats");

exports.aggregateTransactions = onDocumentWritten(
    { region: "europe-west1", document: "users/{userId}/transactions/{txnId}" },
    async (event) => {
        if (!event.data) return;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();

        let inflowDelta = 0;
        let outflowDelta = 0;

        const processSnapshot = (data, multiplier) => {
            if (!data || data.status !== 'Success') return; 
            const amount = Number(data.amount) || 0;
            if (data.type === 'Credit') inflowDelta += (amount * multiplier);
            else if (data.type === 'Debit') outflowDelta += (amount * multiplier);
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
    }
);

exports.verifyAndCreditTopUp = onCall(
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
            const decodedToken = await admin.auth().verifyIdToken(userToken, true);
            if (decodedToken.uid !== userId) throw new HttpsError('permission-denied', 'User mismatch.');

            const existingTxn = await db.collection("users").doc(userId)
                .collection("transactions").where("reference", "==", reference).get();
            if (!existingTxn.empty) return { success: true, message: "Transaction already processed." };

            const squadUrl = `${BASE_URL}/transaction/verify/${reference}`;
            const response = await axios.get(squadUrl, {
                headers: { "Authorization": `Bearer ${SQUAD_SECRET_KEY}` }
            });

            const data = response.data;
            if (!data.status || data.data.transaction_status !== "success") {
                throw new HttpsError('aborted', 'Payment verification failed or pending.');
            }

            const koboAmount = Number(data.data.transaction_amount);
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
                        payment_gateway_ref: data.data.transaction_ref
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
                        payment_gateway_ref: data.data.transaction_ref
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

exports.deleteUser = onCall(
    { region: "us-central1" }, 
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'User must be logged in.');
        const targetUid = request.data.uid;
        if (!targetUid) throw new HttpsError('invalid-argument', 'UID required.');

        try {
            await admin.auth().updateUser(targetUid, { disabled: true });
            await admin.auth().revokeRefreshTokens(targetUid);
            await admin.firestore().collection("users").doc(targetUid).update({
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
                    await admin.firestore().collection("users").doc(targetUid).update({
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

exports.subscribeToBroadcast = onCall(
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

exports.sendBroadcast = onCall(
    { region: "us-central1" },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
        
        const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
        if (!adminDoc.exists) throw new HttpsError('permission-denied', 'Not an admin.');

        const { title, body, imageUrl, clickUrl } = request.data;

        if (!title || !body) {
            throw new HttpsError('invalid-argument', 'Broadcast title and body cannot be empty.');
        }

        const targetUrl = clickUrl || '/member/memberDashboard.html';

        const message = {
            notification: {
                title: title,
                body: body,
            },
            webpush: {
                notification: {
                    icon: '/assets/icon-192.png',
                    badge: '/assets/badge.png' // INJECTS BADGE INTO SYSTEM TRAY
                },
                fcm_options: {
                    link: targetUrl
                }
            },
            data: {
                url: targetUrl,
                click_action: 'FLUTTER_NOTIFICATION_CLICK' 
            },
            topic: 'broadcast'
        };

        if (imageUrl) {
            message.notification.image = imageUrl; 
            message.webpush.notification.image = imageUrl; 
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