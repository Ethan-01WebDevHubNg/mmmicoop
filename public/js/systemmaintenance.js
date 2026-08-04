import { fetchAndActivate, getValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-remote-config.js";
// We import the initialized remoteConfig from your central init file
import { remoteConfig } from "./firebase-init.js";

// --- 1. REMOTE CONFIG CHECK & REDIRECT ---
async function checkMaintenanceStatus() {
  try {
    // Fetch and activate the latest values from Firebase
    await fetchAndActivate(remoteConfig);

    // Get the boolean value. Ensure this Key matches your Firebase Console exactly.
    // We agreed on: "system_maintenance_mode"
    const isMaintenanceActive = getValue(remoteConfig, "system_maintenance_mode").asBoolean();
    
    const pathName = window.location.pathname;
    const onMaintenancePage = pathName.includes("systemmaintenance");

    console.log("Remote Config Status:", isMaintenanceActive); 

    if (isMaintenanceActive) {
        // If Maintenance is ON and we are NOT on the maintenance page -> Redirect
        if (!onMaintenancePage) {
            console.warn("Maintenance mode active. Redirecting...");
            window.location.replace("/systemmaintenance.html");
        }
    } else {
        // If Maintenance is OFF and we ARE on the maintenance page -> Send back to Dashboard
        if (onMaintenancePage) {
            console.log("Maintenance mode ended. Redirecting...");
            // Redirect to dashboard as requested
            window.location.replace("/member/memberDashboard.html"); 
        }
    }

  } catch (error) {
    console.error("Error fetching Remote Config:", error);
    // Optional: Default to no maintenance if fetch fails
  }
}

// Execute the check immediately
checkMaintenanceStatus();


// --- 2. COUNTDOWN TIMER LOGIC ---
// This runs only if we are currently on the maintenance HTML page
if (window.location.pathname.includes("systemmaintenance")) {
    
    // Set your target end time here
    const targetDateString = "December 26, 2025 23:59:00"; 
    const countDownDate = new Date(targetDateString).getTime();

    const x = setInterval(function() {
        const now = new Date().getTime();
        const distance = countDownDate - now;

        const days = Math.floor(distance / (1000 * 60 * 60 * 24));
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);

        const elDays = document.getElementById("days");
        const elHours = document.getElementById("hours");
        const elMins = document.getElementById("minutes");
        const elSecs = document.getElementById("seconds");

        if (elDays && elHours && elMins && elSecs) {
            elDays.innerText = days < 10 ? "0" + days : days;
            elHours.innerText = hours < 10 ? "0" + hours : hours;
            elMins.innerText = minutes < 10 ? "0" + minutes : minutes;
            elSecs.innerText = seconds < 10 ? "0" + seconds : seconds;
        }

        if (distance < 0) {
            clearInterval(x);
            if (elDays) elDays.innerText = "00";
            if (elHours) elHours.innerText = "00";
            if (elMins) elMins.innerText = "00";
            if (elSecs) elSecs.innerText = "00";
            
            // Optional: Auto-refresh when timer hits zero to see if maintenance is actually off
            // location.reload(); 
        }
    }, 1000);
}