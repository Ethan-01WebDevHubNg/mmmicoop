import { auth, db, storage, storageRef, uploadBytes, getDownloadURL, doc, updateDoc } from './firebase-init.js';
import { NotificationService } from './admin-core.js'; // Importing Toast Service

export function initProfileUpload() {
    const triggerBtn = document.getElementById('upload-trigger-btn');
    const fileInput = document.getElementById('hidden-file-input');
    const previewImg = document.getElementById('profile-picture-large');

    if (!triggerBtn || !fileInput) return;

    triggerBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 1. Validation: Size
        if (file.size > 2 * 1024 * 1024) {
            NotificationService.toast("File is too large. Max size is 2MB.", "error");
            return;
        }

        // 2. Validation: Type
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            NotificationService.toast("Invalid file type. Please use JPG, PNG, or WebP.", "error");
            return;
        }

        const originalIcon = triggerBtn.innerHTML;
        triggerBtn.disabled = true;
        triggerBtn.innerHTML = `<span class="material-symbols-outlined animate-spin">refresh</span>`;

        try {
            const userId = auth.currentUser.uid;
            const fileRef = storageRef(storage, `profile_images/${userId}/profile.jpg`);

            const snapshot = await uploadBytes(fileRef, file);
            const downloadURL = await getDownloadURL(snapshot.ref);

            const userRef = doc(db, "users", userId);
            await updateDoc(userRef, {
                photoURL: downloadURL
            });

            if (previewImg) {
                previewImg.style.backgroundImage = `url('${downloadURL}')`;
            }
            const headerImg = document.getElementById('header-profile-img');
            if(headerImg) headerImg.src = downloadURL;

            // 3. Success Toast
            NotificationService.toast("Profile picture updated successfully!", "success");

        } catch (error) {
            // 4. Silent Log + Generic Toast
            console.error("Profile Upload Error:", error); 
            NotificationService.toast("Unable to update profile picture. Please try again.", "error");
        } finally {
            triggerBtn.disabled = false;
            triggerBtn.innerHTML = originalIcon;
            fileInput.value = ''; 
        }
    });
}