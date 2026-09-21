/**
 * Padify Drawingpad — temporary PIN gate.
 *
 * The drawing pad is a work in progress, so it sits behind a 4-digit PIN
 * while the next version is being planned. The heavy canvas scripts are not
 * even requested until the right PIN is entered, so the pad never loads
 * (or renders) behind the gate.
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

    var SCRIPTS = [
        'vendor/react.production.min.js',
        'vendor/react-dom.production.min.js',
        'vendor/excalidraw.production.min.js',
        'app.js'
    ];

    var body = document.body;
    var overlay = document.getElementById('padLock');
    var dots = Array.prototype.slice.call(document.querySelectorAll('#padLockDots .padlock-dot'));
    var keypad = document.getElementById('padLockKeypad');
    var hint = document.getElementById('padLockHint');
    var entry = '';
    var loadingScripts = false;

    function unlock() {
        try { sessionStorage.setItem(UNLOCK_FLAG, '1'); } catch (e) { /* private mode */ }
        body.classList.remove('locked');
        if (overlay && overlay.parentNode) {
            overlay.classList.add('leaving');
            setTimeout(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 260);
        }
        loadScripts();
    }

    function loadScripts() {
        if (loadingScripts) return;
        loadingScripts = true;
        var index = 0;

        function next() {
            if (index >= SCRIPTS.length) return;
            var src = SCRIPTS[index];
            index += 1;
            var script = document.createElement('script');
            script.src = src;
            script.onload = next;
            script.onerror = function () {
                var loading = document.getElementById('padLoading');
                if (loading) loading.textContent = 'The drawing canvas failed to load. Try refreshing the page.';
            };
            document.body.appendChild(script);
        }

        next();
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
        if (loadingScripts) return;
        if (entry.length >= 4) return;
        entry += String(digit);
        renderDots();
        setHint(entry.length === 4 ? '' : ' ', false);
        if (entry.length === 4) {
            setTimeout(submit, 120);
        }
    }

    function backspace() {
        if (loadingScripts) return;
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

    // Already unlocked this session — open straight into the canvas.
    var unlocked = false;
    try { unlocked = sessionStorage.getItem(UNLOCK_FLAG) === '1'; } catch (e) { /* private mode */ }
    if (unlocked) {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        body.classList.remove('locked');
        loadScripts();
    }
})();
