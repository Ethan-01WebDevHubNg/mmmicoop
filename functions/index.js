const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require('firebase-functions/params'); 
const admin = require("firebase-admin");
const axios = require("axios");
const { RecaptchaEnterpriseServiceClient } = require("@google-cloud/recaptcha-enterprise");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getStorage } = require("firebase-admin/storage");
const Busboy = require("busboy");
const sharp = require("sharp");
const crypto = require("crypto"); 

const squadTestKey = defineSecret('SQUAD_TEST_KEY');
const squadLiveKey = defineSecret('SQUAD_LIVE_KEY');

const IS_PROD = false; 

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
        const beforeData = event.data.before ? event.data.before.data() : null;
        const afterData = event.data.after ? event.data.after.data() : null;

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
                        daily.dailyAmount = amountInNaira;
                        daily.startDate = new Date().toISOString();
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
        const uid = request.auth.uid;

        if (!fcmToken) throw new HttpsError('invalid-argument', 'Token required.');

        try {
            await getMessaging().subscribeToTopic(fcmToken, 'broadcast');
            await db.collection('users').doc(uid).set({
                fcmToken: fcmToken,
                notificationsEnabled: true,
                lastTokenUpdate: FieldValue.serverTimestamp()
            }, { merge: true });

            const adminDoc = await db.collection('admins').doc(uid).get();
            if (adminDoc.exists) {
                await getMessaging().subscribeToTopic(fcmToken, 'broadcast_admins');
                await db.collection('admins').doc(uid).set({
                    fcmToken: fcmToken,
                    notificationsEnabled: true,
                    lastTokenUpdate: FieldValue.serverTimestamp()
                }, { merge: true });
            }

            return { success: true };
        } catch (error) {
            console.error("Sub Error:", error);
            throw new HttpsError('internal', 'Subscription failed.');
        }
    }
);

// RESTORED MULTIPART UPLOAD PIPELINE
exports.sendBroadcast = onRequest(
    { 
        region: "us-central1",
        cors: true,
        invoker: "public" // <-- THIS IS THE MISSING PIECE THAT BYPASSES THE CLOUD RUN IAM BLOCK
    }, 
    async (req, res) => {
        try {
            const authHeader = req.headers.authorization || '';
            if (!authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Unauthenticated.' });
            }
            const token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            
            const adminDoc = await db.collection('admins').doc(decodedToken.uid).get();
            if (!adminDoc.exists) {
                return res.status(403).json({ error: 'Permission denied. Not an admin.' });
            }

            await new Promise((resolve, reject) => {
                const busboy = Busboy({ headers: req.headers });
                const fields = {};
                let fileBuffer = null;
                let mimeType = '';

                busboy.on('field', (name, val) => {
                    fields[name] = val;
                });

                busboy.on('file', (name, file, info) => {
                    if (name === 'imageFile') {
                        mimeType = info.mimeType;
                        const chunks = [];
                        file.on('data', (data) => chunks.push(data));
                        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
                    } else {
                        file.resume();
                    }
                });

                busboy.on('close', async () => {
                    try {
                        const { title, body, clickUrl, audience = 'users' } = fields;

                        if (!title || !body) {
                            res.status(400).json({ error: 'Broadcast title and body cannot be empty.' });
                            return resolve(); 
                        }

                        let fullGraphicUrl = '';
                        let graphicIconUrl = '';
                        
                        if (fileBuffer) {
                            if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
                                res.status(400).json({ error: 'Invalid format. Only JPG, PNG, WEBP allowed.' });
                                return resolve();
                            }

                            const processedImage = await sharp(fileBuffer)
                                .resize({ width: 1000, withoutEnlargement: true })
                                .jpeg({ quality: 85 })
                                .toBuffer();

                            const processedIcon = await sharp(fileBuffer)
                                .resize(192, 192, { fit: 'cover' })
                                .jpeg({ quality: 85 })
                                .toBuffer();

                            const bucket = getStorage().bucket();
                            const now = new Date();
                            const yyyy = now.getFullYear();
                            const mm = String(now.getMonth() + 1).padStart(2, '0');
                            const uniqueId = crypto.randomUUID(); 
                            const basePath = `notification-assets/broadcasts/${yyyy}/${mm}/${uniqueId}`;
                            
                            const imageRef = bucket.file(`${basePath}/image.jpg`);
                            await imageRef.save(processedImage, { metadata: { contentType: 'image/jpeg' } });
                            fullGraphicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(`${basePath}/image.jpg`)}?alt=media`;

                            const iconRef = bucket.file(`${basePath}/icon.jpg`);
                            await iconRef.save(processedIcon, { metadata: { contentType: 'image/jpeg' } });
                            graphicIconUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(`${basePath}/icon.jpg`)}?alt=media`;
                        }

                        let targetUrl = '/member/memberDashboard.html';
                        
                        if (clickUrl && clickUrl.trim() !== '') {
                            const rawUrl = clickUrl.trim();
                            const lowerUrl = rawUrl.toLowerCase();
                            
                            const isWhatsApp = /(whatsapp|watsapp|whatsap|watsap|whatapp|wa\.me)/i.test(lowerUrl);
                            const isTel = /^[\d\+\-\s\(\)]+$/.test(rawUrl) || /(call|tel|phone|dial)/i.test(lowerUrl);
                            
                            if (isWhatsApp || isTel) {
                                const phoneMatch = rawUrl.match(/(?:\+?\d[\d\-\s()]{7,}\d)/);
                                let digits = phoneMatch ? phoneMatch[0].replace(/\D/g, '') : rawUrl.replace(/\D/g, '');
                                
                                if (digits.startsWith('0') && digits.length === 11) {
                                    digits = '234' + digits.substring(1);
                                } else if (digits.length === 10 && /^[789][01]/.test(digits)) {
                                    digits = '234' + digits;
                                }
                                
                                if (isWhatsApp) {
                                    targetUrl = `https://wa.me/${digits}`;
                                } else {
                                    targetUrl = `/member/memberDashboard.html?intent=tel&number=%2B${digits}`;
                                }
                            } 
                            else {
                                if (!lowerUrl.startsWith('http') && !lowerUrl.startsWith('/') && !lowerUrl.startsWith('tel:') && !lowerUrl.startsWith('mailto:')) {
                                    targetUrl = `https://${rawUrl}`;
                                } else {
                                    targetUrl = rawUrl;
                                }
                            }
                        }

                        const message = {
                            data: {
                                title: title,
                                body: body,
                                url: targetUrl,
                                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                                attachedImage: fullGraphicUrl || '', 
                                attachedIcon: graphicIconUrl || '',
                                forceDrawer: 'false'
                            },
                            topic: audience === 'admins' ? 'broadcast_admins' : 'broadcast'
                        };

                        const responseId = await getMessaging().send(message);
                        res.status(200).json({ success: true, messageId: responseId });
                        resolve();
                        
                    } catch (err) {
                        console.error("Broadcast Build/Send Error:", err);
                        res.status(500).json({ error: 'Broadcast failed.' });
                        resolve();
                    }
                });

                busboy.on('error', (err) => {
                    console.error("Busboy Parse Error:", err);
                    res.status(500).json({ error: 'File stream parsing failed.' });
                    resolve();
                });

                if (req.rawBody) {
                    busboy.end(req.rawBody);
                } else {
                    req.pipe(busboy);
                }
            });
            
        } catch (error) {
            console.error("Auth/Processing Error:", error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error.' });
            }
        }
    }
);

// RESTORED DATA-ONLY TRANSACTION PAYLOADS
exports.notifyOnTransaction = onDocumentWritten(
    { region: "europe-west1", document: "users/{userId}/transactions/{txnId}" },
    async (event) => {
        if (!event.data) return;
        const beforeData = event.data.before ? event.data.before.data() : null;
        const afterData = event.data.after ? event.data.after.data() : null;

        if (!afterData || afterData.status !== 'Success') return;
        if (beforeData && beforeData.status === 'Success') return; 

        const userId = event.params.userId;
        const amount = Number(afterData.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 });
        const type = afterData.type; 
        const category = afterData.category; 
        const subType = afterData.sub_type; 
        
        const interestDays = afterData.days || 1;

        try {
            const userDoc = await db.collection('users').doc(userId).get();
            if (!userDoc.exists) return;
            
            const userData = userDoc.data();
            const fcmToken = userData.fcmToken;

            if (!fcmToken || userData.notificationsEnabled === false) return; 

            const rawName = userData.firstName || userData.fullName || userData.name || 'Member';
            const firstName = rawName.split(' ')[0]; 

            let title = '';
            let body = '';

            if (category === 'daily') {
                if (type === 'Credit') {
                    title = 'Daily Target Hit! 🎯';
                    body = `Great job, ${firstName}! Your daily contribution of ₦${amount} is safely locked in.`;
                } else if (type === 'Debit') {
                    title = 'Daily Savings Withdrawal 💸';
                    body = `Hey ${firstName}, your withdrawal of ₦${amount} from your daily contribution is being processed and you should be credited soon.`;
                }
            } 
            else if (category === 'savings') {
                if (type === 'Credit') {
                    title = 'Wallet Top-up Successful 💳';
                    body = `${firstName}, your cooperative wallet was just credited with ₦${amount}.`;
                } else if (type === 'Debit') {
                    title = 'Wallet Debit 📉';
                    body = `₦${amount} has been debited from your cooperative wallet, ${firstName}.`;
                }
            } 
            else if (category === 'interest' || subType === 'INTEREST') {
                title = 'Daily Interest! 📈';
                const dayString = interestDays == 1 ? 'day' : 'days';
                body = `Hooray! ${firstName}, your cooperative savings just generated ₦${amount} in interest for the last ${interestDays} ${dayString}.`;
            } 
            else {
                const isCredit = type === 'Credit';
                title = isCredit ? 'Credit Alert! 💰' : 'Debit Alert! 💸';
                body = isCredit 
                    ? `Hi ${firstName}, your account was credited with ₦${amount}.` 
                    : `Hi ${firstName}, ₦${amount} was debited from your account.`;
            }

            const message = {
                data: {
                    title: title,
                    body: body,
                    url: '/member/memberDashboard.html',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    attachedImage: '',
                    attachedIcon: '',
                    forceDrawer: 'true' 
                },
                token: fcmToken 
            };

            await getMessaging().send(message);
            
        } catch (error) {
            console.error("Autonomous Notification Failed:", error);
        }
    }
);

// --- SCHEDULED MAINTENANCE: NOTIFICATION ASSET CLEANUP ---
exports.cleanupNotificationAssets = onSchedule("0 2 * * *", async (event) => {
    try {
        const bucket = getStorage().bucket();
        const [files] = await bucket.getFiles({ prefix: 'notification-assets/broadcasts/' });
        
        const now = Date.now();
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        let deletedCount = 0;

        for (const file of files) {
            const [metadata] = await file.getMetadata();
            const timeCreated = new Date(metadata.timeCreated).getTime();
            
            if (now - timeCreated > THIRTY_DAYS_MS) {
                await file.delete();
                deletedCount++;
            }
        }
        
        console.log(`Maintenance Complete: Deleted ${deletedCount} expired broadcast images.`);
    } catch (error) {
        console.error("Asset Cleanup Routine Error:", error);
    }
});