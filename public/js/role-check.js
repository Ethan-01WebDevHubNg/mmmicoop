import { auth, db, doc, getDoc, onAuthStateChanged, signOut } from './firebase-init.js';
import { NotificationService } from './admin-core.js';

(function initRoleCheck() {
    const preloader = document.getElementById('preloader');
    if (preloader) preloader.classList.remove('hidden');

    const htmlEl = document.documentElement;
    const themeToggle = document.getElementById('theme-toggle');

    function setTheme(isDark) {
        if (isDark) {
            htmlEl.classList.add('dark');
            localStorage.setItem('theme', 'dark');
        } else {
            htmlEl.classList.remove('dark');
            localStorage.setItem('theme', 'light');
        }
    }

    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        setTheme(true);
    } else {
        setTheme(false);
    }

    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            setTheme(!htmlEl.classList.contains('dark'));
        });
    }

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = '/auth/'; 
            return;
        }

        try {
            const adminDocRef = doc(db, 'admins', user.uid);
            const adminSnap = await getDoc(adminDocRef);

            if (adminSnap.exists()) {
                const adminData = adminSnap.data();
                
                if (adminData.isActive === false) {
                    throw new Error("Account Deactivated");
                }

                updateHeaderUI(adminData);

                if (adminData.role !== 'super_admin') {
                    document.querySelectorAll('.super-admin-only').forEach(el => el.remove());
                }

                const event = new CustomEvent('admin-ready', { detail: { adminData: { ...adminData, uid: user.uid } } });
                window.dispatchEvent(event);

                if (preloader) {
                    preloader.classList.add('opacity-0');
                    setTimeout(() => preloader.classList.add('hidden'), 500);
                }

            } else {
                if (window.location.pathname.includes('/admin/')) {
                    throw new Error("Not an Admin");
                } 
                if (preloader) preloader.classList.add('hidden');
            }
        } catch (error) {
            console.error('Access Denied:', error); // Silent Dev Log
            
            if (error.message.includes("400") || (error.code && error.code.includes("invalid-argument"))) {
                if (!sessionStorage.getItem('retry_400')) {
                    sessionStorage.setItem('retry_400', 'true');
                    window.location.reload();
                    return;
                }
            }
            
            // IMPROVED: Polite Toast Message
            if (NotificationService && NotificationService.toast) {
                NotificationService.toast('Access restricted. Redirecting...', 'error');
            }
            
            await signOut(auth);
            setTimeout(() => {
                window.location.href = '/auth/';
            }, 1500);
        }
    });

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.logout-trigger');
        if (btn) {
            e.preventDefault();
            
            // IMPROVED: Consistent Modal for Logout
            let confirmLogout = false;
            if (NotificationService && NotificationService.confirm) {
                confirmLogout = await NotificationService.confirm(
                    "Sign Out", 
                    "Are you sure you want to end your session?", 
                    "Sign Out"
                );
            } else {
                // Fallback if Service isn't loaded (Member Side)
                confirmLogout = confirm("Are you sure you want to sign out?");
            }

            if (confirmLogout) {
                await signOut(auth);
                window.location.href = '/auth/';
            }
        }
    });

    function updateHeaderUI(data) {
        const avatar = document.getElementById('admin-avatar');
        if (avatar) {
            avatar.src = data.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.name || 'Admin')}&background=random`;
            avatar.title = `${data.name} (${data.role})`;
        }
    }
})();