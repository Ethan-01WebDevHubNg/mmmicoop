/**
 * withdrawal-calc-box.js
 * Handles live calculation of withdrawal fees and interest forfeiture.
 */

let _isMature = false;
let _cycleInterestPaid = 0;

// DOM Elements
const elements = {
    box: null,
    input: null,
    req: null,
    fee: null,
    forfeit: null,
    net: null,
    note: null
};

export function initCalculationLogic() {
    elements.box = document.getElementById('payout-calc-box');
    elements.input = document.getElementById('amount-input');
    elements.req = document.getElementById('calc-req');
    elements.fee = document.getElementById('calc-fee');
    elements.forfeit = document.getElementById('calc-forfeit');
    elements.net = document.getElementById('calc-net');
    elements.note = document.getElementById('calc-note');

    if (elements.input) {
        elements.input.addEventListener('input', runCalculation);
    }
}

export function updateCycleState(isMature, cycleInterestPaid) {
    _isMature = isMature;
    _cycleInterestPaid = Number(cycleInterestPaid) || 0;
    
    // Re-run calc if user already typed something
    if (elements.input && elements.input.value) {
        runCalculation();
    }
}

function runCalculation() {
    const val = parseFloat(elements.input.value) || 0;

    if (val > 0) {
        elements.box.classList.remove('hidden');
        elements.req.textContent = `₦${val.toLocaleString()}`;
        
        if (!_isMature) {
            // EARLY WITHDRAWAL
            // 1. Penalty: 1% of requested amount
            const fee = val * 0.01;
            
            // 2. Forfeiture: Lose ALL interest paid in this cycle so far
            const forfeit = _cycleInterestPaid;
            
            // Net Payout
            const net = val - fee - forfeit;
            
            elements.fee.textContent = `-₦${fee.toLocaleString()}`;
            elements.fee.className = "text-red-500";
            
            elements.forfeit.textContent = `-₦${forfeit.toLocaleString()}`;
            elements.forfeit.className = "text-orange-500";
            
            if (net > 0) {
                elements.net.textContent = `₦${net.toLocaleString()}`;
                elements.net.className = "font-bold text-gray-900 dark:text-white";
            } else {
                elements.net.textContent = "₦0.00 (Insufficient)";
                elements.net.className = "font-bold text-red-500";
            }

            elements.note.classList.remove('hidden');
            elements.note.textContent = "*Early withdrawal: 1% fee + forfeiture of all cycle interest.";
        } else {
            // MATURE CYCLE
            elements.fee.textContent = `₦0.00`;
            elements.fee.className = "text-green-500"; 
            
            elements.forfeit.textContent = `₦0.00`;
            elements.forfeit.className = "text-green-500"; 
            
            elements.net.textContent = `₦${val.toLocaleString()}`;
            elements.net.className = "font-bold text-gray-900 dark:text-white";
            
            elements.note.classList.add('hidden');
        }
    } else {
        elements.box.classList.add('hidden');
    }
}