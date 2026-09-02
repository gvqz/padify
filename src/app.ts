import $ from 'jquery';
import { selector } from './selector';
import {
        showToast,
        calculateCharactersAndWords,
        calculateNoteStatistics,
        copyNotesToClipboard,
        debounce,
        saveTextAsFile,
        enableDarkMode,
        enableLightMode,
        enableDeviceTheme,
        resetFontSize,
        resetLineHeight,
        resetFontWeight,
        resetShowWordCountPill,
        resetWriteDirection,
        resetTexture,
        resetFont,
        resetOptimalLineLength,
        deleteNotes,
        toggleFocusMode,
        turnOffFocusMode,
        toggleFullScreen,
        shareNotes,
        exportNotesAsPDF,
        exportNotesAsDocx,
        downloadHTML,
        updateWordCountPill,
        getPWADisplayMode,
        getFileName,
        getPdfFileName,
        getDocxFileName,
        getHtmlFileName
} from './utils';
import Swal from 'sweetalert2';
import { initUnicodePicker } from './unicode/picker';
import { timerConfig, stopTimer } from './timer';

// Bootstrap 3's jQuery plugins (registered globally by the `bootstrap` import
// in main.ts) are not covered by @types/jquery. The `modal` member is also
// declared in utils.ts; identical declarations merge.
declare global {
        interface JQuery {
                modal(action: string | { [key: string]: unknown }): JQuery;
                tooltip(options?: Record<string, unknown>): JQuery;
        }
}

// The original app.js relies on the browser's named-element global for the
// `<textarea id="note">` element. The ambient declaration keeps `note.value`
// working without emitting any runtime code.
declare const note: HTMLTextAreaElement;

// `beforeinstallprompt` is not part of lib.dom's WindowEventMap.
declare global {
        interface BeforeInstallPromptEvent extends Event {
                prompt(): Promise<void>;
                userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
        }
        interface WindowEventMap {
                beforeinstallprompt: BeforeInstallPromptEvent;
        }
}

interface BreakReminderState {
        accumulatedMs: number;
        lastActivityAt: number;
        snoozedUntil: number;
        dismissedUntil: number;
}

$(document).ready(function () {

        const breakReminderConfig = {
                // Show the reminder after this much active writing time.
                thresholdMs: 30 * 60 * 1000,

                // Ignore gaps longer than this so idle time does not count as writing.
                idleWindowMs: 2 * 60 * 1000,

                // Cap how much time a single input event can add to the session.
                activitySliceMs: 15000,

                // Hide the reminder for this long when the user snoozes it.
                snoozeMs: 10 * 60 * 1000,

                // Duration of the actual break countdown once started.
                breakDurationMs: 2 * 60 * 1000,

                // Keep the reminder suppressed for this long after dismissal.
                dismissCooldownMs: 30 * 60 * 1000,

                // localStorage key used to persist reminder state across reloads.
                storageKey: 'breakReminderState'
        };

        const breakReminderDefaults = {
                accumulatedMs: 0,
                lastActivityAt: 0,
                snoozedUntil: 0,
                dismissedUntil: 0
        };

        let breakReminderState = loadBreakReminderState();
        let breakReminderCountdownTimer: ReturnType<typeof setInterval> | null = null;
        let breakRemindersEnabled = false;

        function loadBreakReminderState(): BreakReminderState {
                const rawState = localStorage.getItem(breakReminderConfig.storageKey);

                if (!rawState) {
                        return { ...breakReminderDefaults };
                }

                try {
                        return {
                                ...breakReminderDefaults,
                                ...JSON.parse(rawState)
                        };
                } catch (error) {
                        return { ...breakReminderDefaults };
                }
        }

        function persistBreakReminderState(): void {
                localStorage.setItem(breakReminderConfig.storageKey, JSON.stringify(breakReminderState));
        }

        function clearBreakReminderState(): void {
                breakReminderState = { ...breakReminderDefaults };
                localStorage.removeItem(breakReminderConfig.storageKey);
        }

        function closeBreakReminderPopup(): void {
                const $breakPopup = $('#breakReminderPopup');
                $breakPopup.addClass('hide');
                $('#breakVeil').removeClass('active');
                setTimeout(function () {
                        $breakPopup.removeClass('show hide break-active');
                        $('#breakReminderActions').show();
                        $('#takeBreakAction').text('Take break');
                        $('#snoozeBreakAction').show();
                        $('#dismissBreakAction').show();
                        $('#breakReminderTitle').text('Time for a 2-minute break?');
                        $('#breakReminderText').text('Stand up, stretch, or look away from the screen for a minute.');
                }, 300);

                if (breakReminderCountdownTimer) {
                        clearInterval(breakReminderCountdownTimer);
                        breakReminderCountdownTimer = null;
                }
        }

        function resetBreakReminderSession(): void {
                breakReminderState.accumulatedMs = 0;
                breakReminderState.lastActivityAt = 0;
                persistBreakReminderState();
        }

        function disableBreakReminders(): void {
                breakRemindersEnabled = false;
                closeBreakReminderPopup();
                clearBreakReminderState();
        }

        function enableBreakReminders(): void {
                breakRemindersEnabled = true;
                breakReminderState = loadBreakReminderState();
        }

        function shouldBlockBreakReminder(now: number): boolean {
                return now < breakReminderState.snoozedUntil || now < breakReminderState.dismissedUntil;
        }

        function showBreakReminderPopup(): void {
                if (!breakRemindersEnabled) {
                        return;
                }

                if ($('#breakReminderPopup').hasClass('show')) {
                        return;
                }
                const $breakPopup = $('#breakReminderPopup');
                $breakPopup.removeClass('hide break-active').addClass('show');
                $('#breakReminderActions').show();
                $('#takeBreakAction').text('Take break');
                $('#snoozeBreakAction').show();
                $('#dismissBreakAction').show();
                $('#breakReminderTitle').text('Time for a 2-minute break?');
                $('#breakReminderText').text('Stand up, stretch, or look away from the screen for a minute.');
        }

        function maybeShowBreakReminder(now: number = Date.now()): void {
                if (!breakRemindersEnabled || document.hidden || shouldBlockBreakReminder(now)) {
                        return;
                }

                if (breakReminderState.accumulatedMs >= breakReminderConfig.thresholdMs) {
                        showBreakReminderPopup();
                }
        }

        function trackWritingActivity(): void {
                if (!breakRemindersEnabled || document.hidden) {
                        return;
                }

                const now = Date.now();

                if (breakReminderState.lastActivityAt) {
                        const delta = now - breakReminderState.lastActivityAt;

                        if (delta <= breakReminderConfig.idleWindowMs) {
                                breakReminderState.accumulatedMs += Math.min(delta, breakReminderConfig.activitySliceMs);
                        }
                }

                breakReminderState.lastActivityAt = now;
                persistBreakReminderState();
                maybeShowBreakReminder(now);
        }

        function formatBreakCountdown(msRemaining: number): string {
                const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
                const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
                const seconds = (totalSeconds % 60).toString().padStart(2, '0');

                return `${minutes}:${seconds}`;
        }

        function startBreakCountdown(): void {
                const breakEndsAt = Date.now() + breakReminderConfig.breakDurationMs;

                breakReminderState.snoozedUntil = breakEndsAt;
                resetBreakReminderSession();
                persistBreakReminderState();

                $('#breakReminderPopup').addClass('break-active');
                $('#breakVeil').addClass('active');
                $('#breakReminderActions').show();
                $('#breakReminderTitle').text(formatBreakCountdown(breakReminderConfig.breakDurationMs));
                $('#breakReminderText').text('Relax your eyes. Unclench your jaw. Breathe.');
                $('#takeBreakAction').text('Back to writing');
                $('#snoozeBreakAction').hide();
                $('#dismissBreakAction').hide();

                if (breakReminderCountdownTimer) {
                        clearInterval(breakReminderCountdownTimer);
                }

                breakReminderCountdownTimer = setInterval(() => {
                        const msRemaining = breakEndsAt - Date.now();

                        if (msRemaining <= 0) {
                                clearInterval(breakReminderCountdownTimer!);
                                breakReminderCountdownTimer = null;
                                closeBreakReminderPopup();
                                showToast('Break complete. Welcome back.');
                                return;
                        }

                        $('#breakReminderTitle').text(formatBreakCountdown(msRemaining));
                }, 1000);
        }

        $('#closeBreakReminderPopup').on('click', function () {
                breakReminderState.dismissedUntil = Date.now() + breakReminderConfig.dismissCooldownMs;
                resetBreakReminderSession();
                persistBreakReminderState();
                closeBreakReminderPopup();
        });

        $('#takeBreakAction').on('click', function () {
                if ($('#breakReminderPopup').hasClass('break-active')) {
                        closeBreakReminderPopup();
                        return;
                }

                startBreakCountdown();
        });

        $('#snoozeBreakAction').on('click', function () {
                breakReminderState.snoozedUntil = Date.now() + breakReminderConfig.snoozeMs;
                breakReminderState.lastActivityAt = 0;
                persistBreakReminderState();
                closeBreakReminderPopup();
        });

        $('#dismissBreakAction').on('click', function () {
                breakReminderState.dismissedUntil = Date.now() + breakReminderConfig.dismissCooldownMs;
                resetBreakReminderSession();
                persistBreakReminderState();
                closeBreakReminderPopup();
        });

        const welcomeText = `Welcome! Padify is an offline-capable notepad which is a Progressive Web App.

The app serves the following features:

- Your notes are saved in real-time as you type.
- Installable on supported browsers for offline usage.
- "Add To Home Screen" feature on Android-supported devices to launch the app from the home screen.
- Dark mode.
- Privacy-focused - Never collects your precious data.
- Light-weight - Loads almost instantly.
- Writing sessions with a pick-a-duration timer.
- View Note Statistics.
- Snapshots.
- Ability to mimic typewriter sound when typing.
- Optional break reminders after long writing sessions.
- Keyboard shortcuts for common actions.
- Focus mode to leave you with a barebones and pristine editor.
- Full-screen mode for a distraction-free writing experience.
- Floating window (in supported browsers) to effectively take notes across other apps.
- Download notes as plain text, PDF, HTML, and DOCX file.
- Ability to play generative ambient music and mix 25 ambience sounds to help you focus.

CAUTION: Since the app uses the browser's localStorage to store your notes,
it's recommended that you take a backup of your notes more often using the
"Download Notes" button or by pressing the "ctrl/command + s" keys.

** Delete this text and start writing your notes **`;

        const darkmodeText = 'Enable dark mode [Ctrl/Cmd + M]';
        const lightmodeText = 'Enable light mode [Ctrl/Cmd + M]';
        const darkMetaColor = '#0a0a0a';
        const lightMetaColor = '#ffffff';
        const metaThemeColor = document.querySelector('meta[name=theme-color]') as HTMLElement | null;
        const { notepad, state, setState, removeState, get } = selector();
        const optimalLineLengthPadding = '15px 15vw 40px';

        const editorConfig = selector().defaultConfig;

        const themeConfig = {
                lightmodeText,
                darkmodeText,
                lightMetaColor,
                darkMetaColor,
                metaThemeColor
        };

        const unicodePicker = initUnicodePicker(notepad);

        const noteItem = state.note && state.note != '' ? state.note : welcomeText;
        const characterAndWordCountText = calculateCharactersAndWords(noteItem);

        let typewriterSoundEnabled: boolean;
        const typeSound = new Audio('/sounds/typewriter/typewriter-key-press-02.mp3');
        const carriageReturnSound = new Audio('/sounds/typewriter/typewriter-carriage-return-01.mp3');
        const spacebarSound = new Audio('/sounds/typewriter/space.mp3');

        typeSound.volume = 0.2; // keep it subtle
        const userChosenTypewriterSound = state.userChosenTypewriterSound;
        const userChosenTypewriterVolume = state.userChosenTypewriterVolume;
        const userChosenExplodingEffect = state.userChosenExplodingEffect;

        let explodingEffectEnabled: boolean;
        let keyburstLayer = $('#keyburstLayer');
        let pendingKeyburst = false;
        let pendingKeyburstTarget: EventTarget | null = null;

        if (keyburstLayer.length === 0) {
                keyburstLayer = $('<div id="keyburstLayer" aria-hidden="true"></div>');
                $('body').append(keyburstLayer);
        }

        const keyburstColors = ['#ff4d6d', '#ffe66d', '#6bffb4', '#6bb7ff', '#d06bff', '#ff9f6b'];
        const keyburstParticleCount = 8;
        const keyburstMirrorProps = [
                'direction',
                'boxSizing',
                'overflowX',
                'overflowY',
                'borderTopWidth',
                'borderRightWidth',
                'borderBottomWidth',
                'borderLeftWidth',
                'borderTopStyle',
                'borderRightStyle',
                'borderBottomStyle',
                'borderLeftStyle',
                'paddingTop',
                'paddingRight',
                'paddingBottom',
                'paddingLeft',
                'fontStyle',
                'fontVariant',
                'fontWeight',
                'fontStretch',
                'fontSize',
                'lineHeight',
                'fontFamily',
                'textAlign',
                'textTransform',
                'textIndent',
                'letterSpacing',
                'wordSpacing',
                'tabSize',
                'textRendering'
        ] as const;

        function getCaretClientPosition(textarea: HTMLTextAreaElement & { _caretMirror?: HTMLDivElement }): { left: number; top: number; height: number } | null {
                if (!textarea || typeof textarea.selectionStart !== 'number') {
                        return null;
                }

                let mirror = textarea._caretMirror;

                if (!mirror) {
                        mirror = document.createElement('div');
                        mirror.setAttribute('aria-hidden', 'true');
                        document.body.appendChild(mirror);
                        textarea._caretMirror = mirror;
                }

                const computed = window.getComputedStyle(textarea);
                const rect = textarea.getBoundingClientRect();

                keyburstMirrorProps.forEach((prop) => {
                        mirror.style[prop] = computed[prop];
                });

                mirror.style.position = 'absolute';
                mirror.style.top = '0px';
                mirror.style.left = '-9999px';
                mirror.style.whiteSpace = 'pre-wrap';
                mirror.style.wordWrap = 'break-word';
                mirror.style.overflow = 'hidden';
                mirror.style.visibility = 'hidden';
                mirror.style.pointerEvents = 'none';
                const paddingLeft = parseFloat(computed.paddingLeft) || 0;
                const paddingRight = parseFloat(computed.paddingRight) || 0;
                const contentWidth = Math.max(0, textarea.clientWidth - paddingLeft - paddingRight);

                mirror.style.boxSizing = 'content-box';
                mirror.style.width = `${contentWidth}px`;
                mirror.style.height = `${textarea.clientHeight}px`;

                const value = textarea.value;
                const caretIndex = textarea.selectionStart;
                const textBefore = value.substring(0, caretIndex);
                const textAfter = value.substring(caretIndex);

                mirror.textContent = textBefore;

                const span = document.createElement('span');
                span.textContent = textAfter || '.';
                mirror.appendChild(span);

                const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
                const borderTop = parseFloat(computed.borderTopWidth) || 0;
                const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) || 16;
                const left = rect.left + span.offsetLeft + borderLeft - textarea.scrollLeft;
                const top = rect.top + span.offsetTop + borderTop - textarea.scrollTop;

                return {
                        left,
                        top,
                        height: lineHeight
                };
        }

        function triggerKeyburst(textarea: HTMLTextAreaElement): void {
                if (!keyburstLayer.length) {
                        return;
                }

                const caret = getCaretClientPosition(textarea);

                if (!caret) {
                        return;
                }

                const baseX = caret.left;
                const baseY = caret.top + caret.height * 0.6;
                const layer = keyburstLayer[0];

                for (let i = 0; i < keyburstParticleCount; i++) {
                        const particle = document.createElement('span');
                        const angle = Math.random() * Math.PI * 2;
                        const distance = 12 + Math.random() * 22;
                        const size = 3 + Math.random() * 4;
                        const color = keyburstColors[Math.floor(Math.random() * keyburstColors.length)];

                        particle.className = 'keyburst-particle';
                        particle.style.left = `${baseX}px`;
                        particle.style.top = `${baseY}px`;
                        particle.style.width = `${size}px`;
                        particle.style.height = `${size}px`;
                        particle.style.setProperty('--burst-x', `${Math.cos(angle) * distance}px`);
                        particle.style.setProperty('--burst-y', `${Math.sin(angle) * distance}px`);
                        particle.style.setProperty('--burst-color', color);

                        layer.appendChild(particle);
                        particle.addEventListener('animationend', () => {
                                particle.remove();
                        });
                }
        }

        // Initialize typewriter sound preference
        if (!userChosenTypewriterSound) {
                typewriterSoundEnabled = editorConfig.defaultTypewriterSound;
                $('#typewriterSound').prop('checked', typewriterSoundEnabled);
        } else {
                typewriterSoundEnabled = userChosenTypewriterSound == 'Yes';
                $('#typewriterSound').prop('checked', typewriterSoundEnabled);
        }

        if (typewriterSoundEnabled) {
                $('.typewriter-switch-volume').show();
        } else {
                $('.typewriter-switch-volume').hide();
        }

        if (!userChosenTypewriterVolume) {
                $('#typewriterVolume').val(editorConfig.defaultTypewriterVolume);
                $('#typewriterVolumeValue').text(editorConfig.defaultTypewriterVolume + '%');
        }else {
                $('#typewriterVolume').val(userChosenTypewriterVolume);
                $('#typewriterVolumeValue').text(userChosenTypewriterVolume + '%');
        }

        // Initialize explosion effect preference
        if (!userChosenExplodingEffect) {
                explodingEffectEnabled = editorConfig.defaultExplodingEffect;
                $('#explodingEffect').prop('checked', explodingEffectEnabled);
        } else {
                explodingEffectEnabled = userChosenExplodingEffect == 'Yes';
                $('#explodingEffect').prop('checked', explodingEffectEnabled);
        }

        function playTypeSound(): void {
                if (!typewriterSoundEnabled) return;

                // Clone so rapid typing doesn't cut the previous sound
                const s = typeSound.cloneNode() as HTMLAudioElement;

                // Add random pitch for realism (±5% variation)
                s.playbackRate = 0.95 + Math.random() * 0.1;
                const currentVolume = localStorage.getItem('userChosenTypewriterVolume');
                s.volume = currentVolume ? (Number(currentVolume) / 100) : (editorConfig.defaultTypewriterVolume / 100);
                s.play();
        }

        notepad.note.on('keydown', (e) => {
                const shouldExplode = explodingEffectEnabled
                        && !e.ctrlKey
                        && !e.metaKey
                        && !e.altKey
                        && (e.key.length === 1 || e.key === 'Enter');

                if (shouldExplode) {
                        pendingKeyburst = true;
                        pendingKeyburstTarget = e.target;
                }

                if (e.key === 'Enter') {
                        if (typewriterSoundEnabled) {
                                const s = carriageReturnSound.cloneNode() as HTMLAudioElement;
                                const currentVolume = localStorage.getItem('userChosenTypewriterVolume');
                                s.volume = currentVolume ? (Number(currentVolume) / 100) : (editorConfig.defaultTypewriterVolume / 100);
                                s.play();
                        }

                        return;
                } else if (e.key === ' ') {
                        if (typewriterSoundEnabled) {
                                const s = spacebarSound.cloneNode() as HTMLAudioElement;
                                const currentVolume = localStorage.getItem('userChosenTypewriterVolume');
                                s.volume = currentVolume ? (Number(currentVolume) / 100) : (editorConfig.defaultTypewriterVolume / 100);
                                s.play();
                        }

                        return;
                }

                const isPrintable = (
                        // Single character keys (letters, numbers, symbols)
                        e.key.length === 1 ||
                        // Common editing keys
                        [
                                'Delete', 'Backspace', 'Enter', ' ', 'Space',
                                'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                                'Home', 'End', 'PageUp', 'PageDown'
                        ].includes(e.key) ||
                        // Mobile-specific keys and special cases
                        e.key === 'Unidentified' ||  // Some mobile keyboards
                        e.key === 'Process' ||       // Some IME inputs
                        e.key === 'Dead' ||          // Dead keys (for accents)
                        e.key === 'Compose'          // Compose key
                );

                if (isPrintable) {
                        playTypeSound();
                }
        });

        // Handle editor auto-scroll for long notes
        var styles = window.getComputedStyle(notepad.note[0]);
        var paddingBottom = parseInt(styles.paddingBottom, 10) || 0;

        let pendingAutoScrollRaf: number | null = null;
        let pendingAutoScrollEl: EventTarget | null = null;

        notepad.note.on('input', (e) => {
                pendingAutoScrollEl = e.target;

                if (pendingAutoScrollRaf) return;

                pendingAutoScrollRaf = requestAnimationFrame(() => {
                        pendingAutoScrollRaf = null;

                        const textarea = pendingAutoScrollEl as HTMLTextAreaElement | null;
                        if (!textarea) return;

                        if (textarea.selectionStart >= textarea.value.length) {
                                textarea.scrollTop = textarea.scrollHeight + paddingBottom;
                        }
                });
        });
        // Handle editor auto-scroll for long notes

        notepad.note.on('input', (e) => {
                trackWritingActivity();

                if (!explodingEffectEnabled) {
                        pendingKeyburst = false;
                        pendingKeyburstTarget = null;
                        return;
                }

                const inputType = (e.originalEvent && (e.originalEvent as InputEvent).inputType) ? (e.originalEvent as InputEvent).inputType : (e as unknown as InputEvent).inputType;
                const isInsert = pendingKeyburst || (inputType && inputType.startsWith('insert') && inputType !== 'insertFromPaste' && inputType !== 'insertFromDrop');

                if (!isInsert) {
                        pendingKeyburst = false;
                        pendingKeyburstTarget = null;
                        return;
                }

                const target = (pendingKeyburstTarget || e.target) as HTMLTextAreaElement;
                pendingKeyburst = false;
                pendingKeyburstTarget = null;

                requestAnimationFrame(() => {
                        triggerKeyburst(target);
                });
        });

        document.addEventListener('visibilitychange', () => {
                if (document.hidden && breakRemindersEnabled) {
                        breakReminderState.lastActivityAt = 0;
                        persistBreakReminderState();
                }
        });

        // Handle typewriter sound toggle
        $('#typewriterSound').on('change', function() {
                const isEnabled = $(this).is(':checked');
                localStorage.setItem('userChosenTypewriterSound', isEnabled ? 'Yes' : 'No');
                typewriterSoundEnabled = isEnabled;

                if (isEnabled) {
                        $('.typewriter-switch-volume').show();
                } else {
                        $('.typewriter-switch-volume').hide();
                }
        });

        // Handle explosion effect toggle
        $('#explodingEffect').on('change', function() {
                const isEnabled = $(this).is(':checked');
                setState('userChosenExplodingEffect', isEnabled ? 'Yes' : 'No');
                explodingEffectEnabled = isEnabled;
        });

        // Handle typewriter volume change
        let volumePreviewTimer: ReturnType<typeof setTimeout> | null = null;
        $('#typewriterVolume').on('input', function() {
                const volume = $(this).val() as string;
                localStorage.setItem('userChosenTypewriterVolume', volume);

                if (typewriterSoundEnabled) {
                        typeSound.volume = Number(volume) / 100;
                        carriageReturnSound.volume = Number(volume) / 100;
                        $('#typewriterVolumeValue').text(volume + '%');
                }

                // Clear previous preview timer
                clearTimeout(volumePreviewTimer!);

                // Set new preview timer (user stopped sliding for 500ms)
                volumePreviewTimer = setTimeout(() => {
                        playTypeSound();
                }, 500);
        });

        notepad.wordCount.text(characterAndWordCountText);
        notepad.note.val(noteItem);

        $('[data-toggle="tooltip"]').tooltip({
                container: 'body'
        });

        if (!state.isUserPreferredTheme) {
                setState('isUserPreferredTheme', 'false');
        }

        if (state.userChosenFontSize) {
                notepad.note.css('font-size', state.userChosenFontSize + 'px');
                notepad.fontSize.val(state.userChosenFontSize);
        } else {
                resetFontSize(editorConfig.defaultFontSize);
        }

        if (state.userChosenFontWeight) {
                notepad.note.css('font-weight', state.userChosenFontWeight);
                notepad.fontWeight.val(state.userChosenFontWeight);
        } else {
                resetFontWeight(editorConfig.defaultFontWeight);
        }

        if (state.userChosenLineHeight) {
                notepad.note.css('line-height', state.userChosenLineHeight + 'px');
                notepad.lineHeight.val(state.userChosenLineHeight);
        } else {
                resetLineHeight(editorConfig.defaultLineHeight);
        }

        const userChosenWordCountPillSelected = state.userChosenWordCountPillSelected

        if (userChosenWordCountPillSelected) {
                if (userChosenWordCountPillSelected === 'Yes') {
                        notepad.wordCountContainer.show();
                } else {
                        notepad.wordCountContainer.hide();
                }
                notepad.showWordCountPill.prop('checked', userChosenWordCountPillSelected === 'Yes');
        } else {
                notepad.wordCountContainer.show();
                notepad.showWordCountPill.prop('checked', true);
        }

        // The word count pill always uses the counter pill style.
        notepad.wordCountContainer.addClass('transparency');

        if (state.userChosenWriteDirection) {
                notepad.note.css('direction', state.userChosenWriteDirection);
                notepad.writeDirection.val(state.userChosenWriteDirection);
        } else {
                resetWriteDirection(editorConfig.defaultWriteDirection);
        }

        if (state.userChosenTexture) {
                const allowedTextures = ['normal', 'dotted', 'graph', 'chessboard', 'starfield', 'grain', 'linen', 'recycled', 'newspaper', 'marble'];

                if (allowedTextures.includes(state.userChosenTexture)) {
                        $(document.body).removeClass('dotted-paper graph-paper chessboard-paper starfield-paper grain-paper linen-paper recycled-paper newspaper-paper marble-paper');

                        if (state.userChosenTexture == 'dotted') {
                                $(document.body).addClass('dotted-paper');
                        } else if (state.userChosenTexture == 'graph') {
                                $(document.body).addClass('graph-paper');
                        } else if (state.userChosenTexture == 'chessboard') {
                                $(document.body).addClass('chessboard-paper');
                        } else if (state.userChosenTexture == 'starfield') {
                                $(document.body).addClass('starfield-paper');
                        } else if (state.userChosenTexture == 'grain') {
                                $(document.body).addClass('grain-paper');
                        } else if (state.userChosenTexture == 'linen') {
                                $(document.body).addClass('linen-paper');
                        } else if (state.userChosenTexture == 'recycled') {
                                $(document.body).addClass('recycled-paper');
                        } else if (state.userChosenTexture == 'newspaper') {
                                $(document.body).addClass('newspaper-paper');
                        } else if (state.userChosenTexture == 'marble') {
                                $(document.body).addClass('marble-paper');
                        }

                        notepad.texture.val(state.userChosenTexture);
                } else {
                        removeState('userChosenTexture');
                        resetTexture(editorConfig.defaultTexture);
                }
        }

        if (state.userChosenOptimalLineLengthSelected) {
                const textArea = document.getElementById('note')!;

                if (state.userChosenOptimalLineLengthSelected === 'Yes') {
                        textArea.style.padding = optimalLineLengthPadding;
                } else {
                        textArea.style.padding = editorConfig.defaultOptimalLineLengthPadding;
                }

                notepad.optimalLineLength.prop('checked', state.userChosenOptimalLineLengthSelected === 'Yes');
        } else {
                notepad.optimalLineLength.prop('checked', false);
        }

        if (state.userChosenSpellCheck) {
                if (state.userChosenSpellCheck === 'Yes') {
                        notepad.note.attr('spellcheck', true as unknown as string);
                } else {
                        notepad.note.attr('spellcheck', false as unknown as string);
                }

                notepad.spellCheck.prop('checked', state.userChosenSpellCheck === 'Yes');
        } else {
                notepad.spellCheck.prop('checked', true);
        }

        if (state.userChosenBreakReminders) {
                const isBreakRemindersEnabled = state.userChosenBreakReminders === 'Yes';
                notepad.breakReminders.prop('checked', isBreakRemindersEnabled);

                if (isBreakRemindersEnabled) {
                        enableBreakReminders();
                } else {
                        disableBreakReminders();
                }
        } else {
                notepad.breakReminders.prop('checked', editorConfig.defaultBreakReminders);
                disableBreakReminders();
        }

        if (state.mode && state.mode === 'dark') {
                enableDarkMode(lightmodeText, darkMetaColor, metaThemeColor);

                $('input[name="themes"][value="dark"]').prop('checked', true);
        } else if (state.mode && state.mode === 'light') {
                enableLightMode(darkmodeText, lightMetaColor, metaThemeColor);

                $('input[name="themes"][value="light"]').prop('checked', true);
        } else {
                enableDeviceTheme(themeConfig);

                $('input[name="themes"][value="device"]').prop('checked', true);
        }

        const themeRadios = document.querySelectorAll('input[name="themes"]');

        themeRadios.forEach(radio => {
                radio.addEventListener('change', (event) => {
                        switch ((event.target as HTMLInputElement).value) {
                                case 'dark':
                                        enableDarkMode(lightmodeText, darkMetaColor, metaThemeColor);
                                        break;
                                case 'light':
                                        enableLightMode(darkmodeText, lightMetaColor, metaThemeColor);
                                        break;
                                case 'device':
                                        enableDeviceTheme(themeConfig);
                                        break;
                        }
                });
        });

        notepad.note.on('input', debounce(function (this: HTMLElement) {
                setState('note', get(this).val() as string);
                updateWordCountPill(get(this).val() as string);
        }, 500));

        notepad.note.keydown(function (e) {
                if (e.key === "Tab") {
                        e.preventDefault();

                        let textarea = e.target as HTMLTextAreaElement;
                        let start = textarea.selectionStart!;
                        let end = textarea.selectionEnd!;
                        let tabCharacter = "\t";

                        if (start === end) {
                                // Single cursor position: Insert tab
                                document.execCommand("insertText", false, tabCharacter);
                                textarea.selectionStart = textarea.selectionEnd = start + tabCharacter.length;
                        } else {
                                // Multi-line selection: Add tab to each line
                                let value = textarea.value;
                                let selectedText = value.substring(start, end);
                                let lines = selectedText.split("\n");

                                if (e.shiftKey) {
                                        // Shift+Tab: Remove leading tab if present
                                        let unindentedLines = lines.map(line =>
                                                line.startsWith(tabCharacter) ? line.substring(tabCharacter.length) : line
                                        );
                                        document.execCommand("insertText", false, unindentedLines.join("\n"));
                                } else {
                                        // Tab: Indent each line
                                        let indentedLines = lines.map(line => tabCharacter + line);
                                        document.execCommand("insertText", false, indentedLines.join("\n"));
                                }
                        }
                }
        });

        notepad.clearNotes.on('click', function () {
                deleteNotes();
        });

        notepad.copyToClipboard.click(function () {
                copyNotesToClipboard(notepad.note.val() as string);
        })

        notepad.downloadNotes.click(function (e) {
                e.stopPropagation(); // Stop click event from bubbling
                $('#iconDropdown').toggleClass('show');
                $('#moreToolsDropdown').removeClass('show');
        })

        notepad.moreTools.click(function (e) {
                e.stopPropagation(); // Stop click event from bubbling
                $('#moreToolsDropdown').toggleClass('show');
                $('#iconDropdown').removeClass('show');
        })

        notepad.downloadNotesPlain.click(function (e) {
                saveTextAsFile(note.value, getFileName());
        });

        notepad.downloadNotesPdf.click(function (e) {
                exportNotesAsPDF(note.value, getPdfFileName());
        });

        notepad.downloadNotesDocx.click(function (e) {
                const textToWrite = note.value;
                const fileNameToSaveAs = getDocxFileName();

                exportNotesAsDocx(textToWrite, fileNameToSaveAs);
        });

        notepad.downloadNotesHtml.click(function (e) {
                const textToWrite = note.value;
                const fileNameToSaveAs = getHtmlFileName();

                downloadHTML(textToWrite, fileNameToSaveAs);
        });

        // Close dropdown if clicked outside
        $(document).on('click', function () {
                $('#iconDropdown').removeClass('show');
                $('#moreToolsDropdown').removeClass('show');
        });

        notepad.fullScreenButton.click(function () {
                toggleFullScreen();
        })

        notepad.focusModeButton.click(function () {
                toggleFocusMode(notepad);
        })

        notepad.focusModeCloseButton.click(function () {
                turnOffFocusMode(notepad);
        })

        // Update statistics when modal is shown
        notepad.statisticsModal.on('show.bs.modal', function () {
                const noteText = notepad.note.val() as string;
                const stats = calculateNoteStatistics(noteText);

                $('#statWords').text(stats.words);
                $('#statCharacters').text(stats.characters);
                $('#statSentences').text(stats.sentences);
                $('#statParagraphs').text(stats.paragraphs);
                $('#statAvgWordLength').text(stats.averageWordLength);
                $('#statReadingTime').text(stats.readingTime);
                $('#statUniqueWords').text(stats.uniqueWords);
                $('#statMostCommonWord').text(stats.mostCommonWord);
                $('#statLexicalDensity').text(stats.lexicalDensityScore);
                $('#statReadabilityScore').text(stats.readabilityScore);
                $('#statEstimatedPages').text(stats.estimatedPages);
                $('#statEstimatedSpeakingTime').text(stats.estimatedSpeakingTime);
        });

        notepad.fontSize.on('change', function (e) {
                const fontSizeSelected = (this as HTMLSelectElement).value;

                notepad.note.css('font-size', fontSizeSelected + 'px');
                setState('userChosenFontSize', fontSizeSelected);
        });

        notepad.lineHeight.on('change', function (e) {
                const lineHeightSelected = (this as HTMLSelectElement).value;

                notepad.note.css('line-height', lineHeightSelected + 'px');
                setState('userChosenLineHeight', lineHeightSelected);
        });

        notepad.fontWeight.on('change', function (e) {
                const fontWeightSelected = (this as HTMLSelectElement).value;

                notepad.note.css('font-weight', fontWeightSelected);
                setState('userChosenFontWeight', fontWeightSelected);
        });

        notepad.writeDirection.on('change', function (e) {
                const writeDirectionSelected = (this as HTMLSelectElement).value;

                notepad.note.css('direction', writeDirectionSelected);
                setState('userChosenWriteDirection', writeDirectionSelected);
        });

        notepad.texture.on('change', function (e) {
                const textureSelected = (this as HTMLSelectElement).value;

                $(document.body).removeClass('dotted-paper graph-paper chessboard-paper starfield-paper grain-paper linen-paper recycled-paper newspaper-paper marble-paper');

                if (textureSelected == 'dotted') {
                        $(document.body).addClass('dotted-paper');
                } else if (textureSelected == 'graph') {
                        $(document.body).addClass('graph-paper');
                } else if (textureSelected == 'chessboard') {
                        $(document.body).addClass('chessboard-paper');
                } else if (textureSelected == 'starfield') {
                        $(document.body).addClass('starfield-paper');
                } else if (textureSelected == 'grain') {
                        $(document.body).addClass('grain-paper');
                } else if (textureSelected == 'linen') {
                        $(document.body).addClass('linen-paper');
                } else if (textureSelected == 'recycled') {
                        $(document.body).addClass('recycled-paper');
                } else if (textureSelected == 'newspaper') {
                        $(document.body).addClass('newspaper-paper');
                } else if (textureSelected == 'marble') {
                        $(document.body).addClass('marble-paper');
                }

                setState('userChosenTexture', textureSelected);
        });

        notepad.showWordCountPill.on('change', function (e) {
                if ($(this).is(':checked')) {
                        notepad.wordCountContainer.show();
                        setState('userChosenWordCountPillSelected', 'Yes');
                } else {
                        notepad.wordCountContainer.hide();
                        setState('userChosenWordCountPillSelected', 'No');
                }
        });

        notepad.clearTabIndentation.on('click', function () {
                const noteText = notepad.note.val() as string;
                const tabCount = (noteText.match(/\t/g) || []).length;

                if (tabCount === 0) {
                        showToast('No tab indentation found in your notes.');
                        return;
                }

                Swal.fire({
                        title: 'Remove all tabs?',
                        text: `This will remove ${tabCount} tab${tabCount === 1 ? '' : 's'} of indentation from your notes. You can undo it with Ctrl/Cmd + Z.`,
                        icon: 'warning',
                        showCancelButton: true,
                        confirmButtonText: 'Remove tabs'
                }).then((result) => {
                        if (!result.isConfirmed) {
                                return;
                        }

                        const textarea = notepad.note.get(0) as HTMLTextAreaElement;
                        const cleanedText = noteText.replace(/\t/g, '');

                        const applyEdit = () => {
                                // Replace the whole content through insertText so the
                                // browser keeps the edit on its native undo stack.
                                textarea.focus();
                                textarea.setSelectionRange(0, textarea.value.length);
                                const inserted = document.execCommand('insertText', false, cleanedText);

                                // execCommand can fail silently while a Bootstrap modal
                                // holds the focus — verify the result and repair.
                                if (!inserted || textarea.value !== cleanedText) {
                                        textarea.setRangeText(cleanedText, 0, textarea.value.length, 'end');
                                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                                }

                                setState('note', cleanedText);
                                updateWordCountPill(cleanedText);
                                showToast(`Removed ${tabCount} tab${tabCount === 1 ? '' : 's'} from your notes.`);
                        };

                        // Bootstrap modals trap focus, which corrupts execCommand's
                        // selection. Let the preferences dialog fade out first.
                        if ($('#preferencesModal').hasClass('in')) {
                                $('#preferencesModal').one('hidden.bs.modal', applyEdit);
                                $('#preferencesModal').modal('hide');
                        } else {
                                applyEdit();
                        }
                });
        });

        notepad.optimalLineLength.on('change', function (e) {
                const textArea = document.getElementById('note')!;

                if ($(this).is(':checked')) {
                        textArea.style.padding = optimalLineLengthPadding;
                        setState('userChosenOptimalLineLengthSelected', 'Yes');
                } else {
                        textArea.style.padding = editorConfig.defaultOptimalLineLengthPadding;
                        setState('userChosenOptimalLineLengthSelected', 'No');
                }
        })

        notepad.spellCheck.on('change', function (e) {
                if ($(this).is(':checked')) {
                        notepad.note.attr('spellcheck', true as unknown as string);
                        setState('userChosenSpellCheck', 'Yes');
                } else {
                        notepad.note.attr('spellcheck', false as unknown as string);
                        setState('userChosenSpellCheck', 'No');
                }
        })

        notepad.breakReminders.on('change', function () {
                const isEnabled = $(this).is(':checked');
                setState('userChosenBreakReminders', isEnabled ? 'Yes' : 'No');

                if (isEnabled) {
                        enableBreakReminders();
                } else {
                        disableBreakReminders();
                }
        })

        notepad.resetPreferences.click(function () {
                if (selector().state.userChosenFontSize) {
                        removeState('userChosenFontSize');
                        resetFontSize(editorConfig.defaultFontSize);
                }

                if (selector().state.userChosenLineHeight) {
                        removeState('userChosenLineHeight');
                        resetLineHeight(editorConfig.defaultLineHeight);
                }

                if (selector().state.userChosenFontWeight) {
                        removeState('userChosenFontWeight');
                        resetFontWeight(editorConfig.defaultFontWeight);
                }

                if (selector().state.userChosenWordCountPillSelected) {
                        removeState('userChosenWordCountPillSelected');
                        resetShowWordCountPill(editorConfig.defaultShowWordCountPill);
                }

                if (selector().state.userChosenWriteDirection) {
                        removeState('userChosenWriteDirection');
                        resetWriteDirection(editorConfig.defaultWriteDirection);
                }

                if (selector().state.userChosenTexture) {
                        removeState('userChosenTexture');
                        resetTexture(editorConfig.defaultTexture);
                }

                if (selector().state.userChosenOptimalLineLengthSelected) {
                        removeState('userChosenOptimalLineLengthSelected');
                        resetOptimalLineLength(editorConfig.defaultOptimalLineLengthPadding, editorConfig.defaultOptimalLineLength);
                }

                if (selector().state.selectedFont) {
                        removeState('selectedFont');
                        resetFont(editorConfig.defaultFont);
                }

                if (selector().state.userChosenSpellCheck) {
                        removeState('userChosenSpellCheck');
                        notepad.note.attr('spellcheck', false as unknown as string);
                        notepad.spellCheck.prop('checked', editorConfig.defaultSpellCheck);
                }

                // Tab indentation is always enabled now — drop any legacy state.
                if (selector().state.userChosenTabIndentation) {
                        removeState('userChosenTabIndentation');
                }

                if (selector().state.userChosenTypewriterSound) {
                        removeState('userChosenTypewriterSound');
                        typewriterSoundEnabled = editorConfig.defaultTypewriterSound;
                        $('#typewriterSound').prop('checked', typewriterSoundEnabled);
                        $('.typewriter-switch-volume').hide();
                }

                if (selector().state.userChosenTypewriterVolume) {
                        removeState('userChosenTypewriterVolume');
                        $('#typewriterVolume').val(editorConfig.defaultTypewriterVolume);
                        $('#typewriterVolumeValue').text(editorConfig.defaultTypewriterVolume + '%');
                }

                if (selector().state.userChosenBreakReminders) {
                        removeState('userChosenBreakReminders');
                }

                disableBreakReminders();
                notepad.breakReminders.prop('checked', editorConfig.defaultBreakReminders);

                if (selector().state.userChosenExplodingEffect) {
                        removeState('userChosenExplodingEffect');
                        explodingEffectEnabled = editorConfig.defaultExplodingEffect;
                        $('#explodingEffect').prop('checked', explodingEffectEnabled);
                }

                // Reset to device theme as default
                $('input[name="themes"][value="device"]').prop('checked', true);
                enableDeviceTheme(themeConfig);
        });

        if (navigator.share !== undefined && window.self === window.top) {
                $('#shareNotesContainer').show();
        }

        notepad.shareNotes.click(function (e) {
                e.stopPropagation();
                const textToShare = note.value;
                shareNotes(textToShare);
        });

        const pipButton = document.getElementById('pip')!;

        // Only show the Picture-in-Picture
        // button if the browser supports it
        if ('documentPictureInPicture' in window) {
                $('#pipContainer').show();

                pipButton.addEventListener('click', async () => {
                        const appTextarea = document.getElementById("textareaContainer");

                        if (!appTextarea) return;

                        // Open a Picture-in-Picture window.
                        const pipWindow = await documentPictureInPicture!.requestWindow({
                                width: 350,
                                height: 500,
                        });

                        Array.from(document.styleSheets).forEach((styleSheet) => {
                                try {
                                        const cssRules = Array.from(styleSheet.cssRules).map((rule) => rule.cssText).join('');
                                        const style = document.createElement('style');

                                        style.textContent = cssRules;
                                        pipWindow.document.head.appendChild(style);
                                } catch (e) {
                                        const link = document.createElement('link');

                                        link.rel = 'stylesheet';
                                        link.type = styleSheet.type;
                                        link.media = styleSheet.media as unknown as string;
                                        link.href = styleSheet.href!;
                                        pipWindow.document.head.appendChild(link);
                                }
                        });

                        // Move the textarea to the Picture-in-Picture window.
                        pipWindow.document.body.append(appTextarea);

                        // Move the textarea back when the Picture-in-Picture window closes.
                        pipWindow.addEventListener("pagehide", (event) => {
                                const mainContainer = document.querySelector("#mainContainer");
                                const textareaContainer = (event.target as Document).querySelector("#textareaContainer");
                                const overlay = document.querySelector(".overlay") as HTMLElement | null;
                                mainContainer!.append(textareaContainer!);
                                mainContainer!.classList.remove("pip");

                                overlay!.style.display = "none";
                                overlay!.style.pointerEvents = "none";

                                textareaContainer!.classList.remove("dark");
                        });
                });

                documentPictureInPicture!.addEventListener("enter", (event) => {
                        const playerContainer = document.querySelector("#mainContainer");
                        const textareaContainer = document.querySelector("#textareaContainer");
                        const overlay = document.querySelector(".overlay") as HTMLElement | null;

                        playerContainer!.classList.add("pip");
                        overlay!.style.display = "block";
                        overlay!.style.pointerEvents = "all";

                        // Stop the writing timer
                        // if it is running (js/timer.js)
                        if (timerConfig.timer) {
                                stopTimer();
                        }

                        if (localStorage.getItem('mode') && localStorage.getItem('mode') == 'dark') {
                                textareaContainer!.classList.add("dark");
                        }

                        if (localStorage.getItem('mode') && localStorage.getItem('mode') == 'device' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                                textareaContainer!.classList.add("dark");
                        }
                });
        }

        // This changes the application's theme when
        // user toggles device's theme preference
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                if (state.mode && state.mode === 'device') {
                        enableDeviceTheme(themeConfig);
                }
        });

        // This hides the install app button
        // if the app is already installed
        if (getPWADisplayMode() === 'standalone') {
                notepad.installApp.hide();
        }

        window.matchMedia('(display-mode: standalone)').addEventListener('change', ({ matches }) => {
                if (matches) {
                        notepad.installApp.hide();
                } else {
                        notepad.installApp.show();
                }
        });

        // This listens for keyboard shortcuts
        document.onkeydown = function (event: KeyboardEvent) {
                event = event || (window.event as KeyboardEvent);

                if (event.key === 'Escape') {
                        $('.modal').modal('hide');
                        $('#iconDropdown').removeClass('show');
                        $('#moreToolsDropdown').removeClass('show');
                        // Only exit focus mode when it is actually on — otherwise
                        // every Escape keypress (context menu, dialogs, etc.)
                        // yanked focus back to the note textarea.
                        if (document.documentElement.hasAttribute('data-focus-mode')) {
                                turnOffFocusMode(notepad);
                        }
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
                        saveTextAsFile(note.value, getFileName());
                        event.preventDefault();
                }

                if (event.altKey && event.code === 'KeyS') {
                        exportNotesAsPDF(note.value, getPdfFileName());
                        event.preventDefault();
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'Comma') {
                        event.preventDefault();

                        if (notepad.preferencesModal.hasClass('in'))
                                return;

                        $('.modal').modal('hide');
                        notepad.preferencesModal.modal('show');
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
                        event.preventDefault();

                        if (notepad.keyboardShortcutsModal.hasClass('in'))
                                return;

                        $('.modal').modal('hide');
                        notepad.keyboardShortcutsModal.modal('show');
                }

                if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyO') {
                        event.preventDefault();
                        unicodePicker.open();
                }

                if (event.altKey && event.code === 'KeyC') {
                        event.preventDefault();
                        copyNotesToClipboard(notepad.note.val() as string);
                }

                if (
                        (event.ctrlKey && event.shiftKey && event.code === 'Delete')
                        || (event.metaKey && event.shiftKey && event.code === 'Backspace')
                ) {
                        event.preventDefault();
                        deleteNotes();
                }

                if (event.altKey && event.code === 'KeyF') {
                        event.preventDefault();

                        toggleFocusMode(notepad);
                }
        };

        // Font selection handler
        const fontSelect = document.getElementById('font') as HTMLSelectElement;

        // Check for legacy font preferences and migrate them to the new system
        function migrateLegacyFontPrefs(): void {
                const dyslexicFont = localStorage.getItem('dyslexicFont') === 'true';
                const monospacedFont = localStorage.getItem('monospaced') === 'true';
                const serifFont = localStorage.getItem('serifFont') === 'true';

                if (dyslexicFont) {
                        localStorage.setItem('selectedFont', 'dyslexic');
                } else if (monospacedFont) {
                        localStorage.setItem('selectedFont', 'monospaced');
                } else if (serifFont) {
                        localStorage.setItem('selectedFont', 'serif');
                } else {
                        localStorage.setItem('selectedFont', 'default');
                }

                // Clear old preferences
                localStorage.removeItem('dyslexicFont');
                localStorage.removeItem('monospaced');
                localStorage.removeItem('serifFont');
        }

        // Apply font based on selection
        function applyFont(fontType: string): void {
                // Remove all font classes first
                notepad.note.removeClass('dyslexic monospaced serif handwritten humanist pixel typewriter crayon');

                // Add the selected font class
                switch(fontType) {
                        case 'dyslexic':
                                notepad.note.addClass('dyslexic');
                                break;
                        case 'monospaced':
                                notepad.note.addClass('monospaced');
                                break;
                        case 'serif':
                                notepad.note.addClass('serif');
                                break;
                        case 'handwritten':
                                notepad.note.addClass('handwritten');
                                break;
                        case 'humanist':
                                notepad.note.addClass('humanist');
                                break;
                        case 'pixel':
                                notepad.note.addClass('pixel');
                                break;
                        case 'typewriter':
                                notepad.note.addClass('typewriter');
                                break;
                        case 'crayon':
                                notepad.note.addClass('crayon');
                                break;
                        // 'default' case doesn't need any class
                }
        }

        // Initialize font selection
        function initFontSelection(): void {
                // Migrate legacy preferences if needed
                if (localStorage.getItem('dyslexicFont') !== null ||
                        localStorage.getItem('monospaced') !== null ||
                        localStorage.getItem('serifFont') !== null) {
                        migrateLegacyFontPrefs();
                }

                // Get the selected font or default to 'default'
                const selectedFont = localStorage.getItem('selectedFont') || 'default';

                // Set the dropdown value
                fontSelect.value = selectedFont;

                // Apply the font
                applyFont(selectedFont);
        }

        // Handle font selection change
        fontSelect.addEventListener('change', (e) => {
                const selectedFont = (e.target as HTMLSelectElement).value;
                localStorage.setItem('selectedFont', selectedFont);
                applyFont(selectedFont);
        });

        // Initialize font selection on page load
        initFontSelection();
});

document.addEventListener("fullscreenchange", function () {
        if (!document.fullscreenElement) {
                $('#arrowPointsIn').hide();
                $('#arrowPointsOut').show();
        }
});

// Registering ServiceWorker
if ('serviceWorker' in navigator && import.meta.env.PROD) {
        navigator.serviceWorker.register('sw.js').then(function (registration) {
                // Registration was successful
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
        }, function (err) {
                // registration failed :(
                console.log('ServiceWorker registration failed: ', err);
        });
}

let deferredPrompt: BeforeInstallPromptEvent | null;

window.addEventListener('beforeinstallprompt', (e) => {
        selector().notepad.installAppButtonContainer.show();
        deferredPrompt = e;

        e.userChoice.then(function (choiceResult) {
                if (choiceResult.outcome === 'accepted') {
                        deferredPrompt = null;
                }
        });
});

const installApp = document.getElementById('installApp')!;

installApp.addEventListener('click', async () => {
        if (deferredPrompt !== null) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                        deferredPrompt = null;
                }
        } else {
                showToast('Padify is already installed.')
        }
});

window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
});
