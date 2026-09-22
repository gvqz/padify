/**
 * Padify Drawingpad — temporary PIN gate.
 *
 * The drawing pad is being rebuilt, so the page currently carries only its
 * shell (navbar + placeholder) behind this 4-digit PIN gate. When the new
 * canvas lands, its scripts mount here again — the unlock flag and the
 * session behaviour below are designed to carry over unchanged.
 *
 * Change the PIN here:
 */
var PADIFY_DRAWINGPAD_PIN = '1234';

/**
 * Entering the right PIN unlocks the pad for the current browser session
 * (until the tab/window is closed). Clear sessionStorage to lock it again.
 */
var UNLOCK_FLAG = 'padifyDrawingpadUnlocked';

(function () {
    'use strict';

    var body = document.body;
    var overlay = document.getElementById('padLock');
    var dots = Array.prototype.slice.call(document.querySelectorAll('#padLockDots .padlock-dot'));
    var keypad = document.getElementById('padLockKeypad');
    var hint = document.getElementById('padLockHint');
    var entry = '';
    var unlocked = false;

    function unlock() {
        unlocked = true;
        try { sessionStorage.setItem(UNLOCK_FLAG, '1'); } catch (e) { /* private mode */ }
        body.classList.remove('locked');
        if (overlay && overlay.parentNode) {
            overlay.classList.add('leaving');
            setTimeout(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 260);
        }
    }

    function renderDots() {
        dots.forEach(function (dot, i) {
            dot.classList.toggle('filled', i < entry.length);
        });
    }

    function setHint(message, isError) {
        if (!hint) return;
        hint.textContent = message;
        hint.classList.toggle('error', !!isError);
    }

    function submit() {
        if (entry === PADIFY_DRAWINGPAD_PIN) {
            setHint('Unlocking…', false);
            unlock();
            return;
        }
        setHint('Wrong PIN — try again.', true);
        overlay.classList.remove('shake');
        // Restart the shake animation.
        void overlay.offsetWidth;
        overlay.classList.add('shake');
        entry = '';
        renderDots();
    }

    function press(digit) {
        if (unlocked) return;
        if (entry.length >= 4) return;
        entry += String(digit);
        renderDots();
        setHint(entry.length === 4 ? '' : ' ', false);
        if (entry.length === 4) {
            setTimeout(submit, 120);
        }
    }

    function backspace() {
        if (unlocked) return;
        entry = entry.slice(0, -1);
        renderDots();
        setHint(' ', false);
    }

    if (keypad) {
        keypad.addEventListener('click', function (event) {
            var key = event.target.closest('button[data-key]');
            if (!key) return;
            var value = key.getAttribute('data-key');
            if (value === 'back') {
                backspace();
            } else {
                press(value);
            }
        });
    }

    document.addEventListener('keydown', function (event) {
        if (!overlay || overlay.parentNode === null) return;
        if (/^[0-9]$/.test(event.key)) {
            press(event.key);
        } else if (event.key === 'Backspace') {
            backspace();
        }
    });

    // Already unlocked this session — open straight into the pad shell.
    var wasUnlocked = false;
    try { wasUnlocked = sessionStorage.getItem(UNLOCK_FLAG) === '1'; } catch (e) { /* private mode */ }
    if (wasUnlocked) {
        unlock();
    }
})();
