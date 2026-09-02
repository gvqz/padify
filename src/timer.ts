import $ from 'jquery';
import { showToast } from './utils';

// Timer configuration
interface TimerPreset {
    minutes: number;
    label: string;
}

interface TimerConfig {
    presets: TimerPreset[];
    timer: ReturnType<typeof setInterval> | null;
    isRunning: boolean;
    totalDurationSec: number;
    remainingTime: number;
    endTime: number | null;
    alarmSound: HTMLAudioElement | null;
}

export const timerConfig: TimerConfig = {
    presets: [
        { minutes: 10, label: 'Quick sprint' },
        { minutes: 15, label: 'Short focus' },
        { minutes: 25, label: 'Classic focus' },
        { minutes: 30, label: 'Half hour' },
        { minutes: 45, label: 'Deep work' },
        { minutes: 60, label: 'Full hour' }
    ],
    timer: null,
    isRunning: false,
    totalDurationSec: 0,
    remainingTime: 0,
    endTime: null,
    alarmSound: null
};

const CUSTOM_MIN_MINUTES = 1;
const CUSTOM_MAX_MINUTES = 240;
const LAST_CUSTOM_DURATION_KEY = 'lastCustomTimerMinutes';

const timerPillRightPositionWithoutWordCount = '1.4em';

function formatClock(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

const clockIconSvg = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M12 7v5l3.5 2"></path>
</svg>`;

// Chime sounds (loudness-normalized to the same perceived volume).
interface ChimeDef {
    id: string;
    name: string;
    file: string;
}

const CHIMES: ChimeDef[] = [
    { id: 'attention', name: 'Attention', file: 'sounds/chimes/attention.mp3' },
    { id: 'success', name: 'Success', file: 'sounds/chimes/success.mp3' },
    { id: 'melody', name: 'Melody', file: 'sounds/chimes/melody.mp3' },
    { id: 'melancholy', name: 'Melancholy', file: 'sounds/chimes/melancholy.mp3' }
];

const CHIME_STORAGE_KEY = 'timerChimeSound';
const DEFAULT_CHIME = 'attention';

const bellIconSvg = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path>
    <path d="M13.7 21a2 2 0 0 1-3.4 0"></path>
</svg>`;

const buildChimeOptions = (): string =>
    CHIMES.map(
        chime => `
        <button type="button" class="chime-option" data-chime="${chime.id}" role="radio" aria-checked="false" title="Select ${chime.name} chime">
            <span class="chime-option-icon" aria-hidden="true">${bellIconSvg}</span>
            <span class="chime-option-name">${chime.name}</span>
            <span class="chime-option-wave" aria-hidden="true"><span></span><span></span><span></span></span>
        </button>`
    ).join('');

// Timer modal HTML
const timerModalHtml = `
    <div class="timer-modal modal fade" id="timerModal" tabindex="-1" role="dialog">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <button type="button" class="close" data-dismiss="modal">&times;</button>
                    <h4 class="modal-title custom-modal-title generic-gap">
                        Writing Session
                        <a href="#" data-placement="bottom" data-toggle="tooltip" title="Pick a duration and the timer ticks at the bottom right corner. A chime marks the end of the session.">
                            <img src="img/tooltip.svg" alt="Tooltip Icon" />
                        </a>
                    </h4>
                </div>
                <div class="modal-body">
                    <div id="timerSelectView">
                        <p class="timer-subtitle">How long do you want to write?</p>
                        <div class="timer-presets">
                            ${timerConfig.presets.map(preset => `
                                <button type="button" class="timer-preset" data-minutes="${preset.minutes}">
                                    <span class="timer-preset-clock" aria-hidden="true">${clockIconSvg}</span>
                                    <span class="timer-preset-minutes">${preset.minutes}<small>min</small></span>
                                    <span class="timer-preset-label">${preset.label}</span>
                                </button>
                            `).join('')}
                        </div>
                        <div class="timer-custom">
                            <span class="timer-custom-label">Or set your own</span>
                            <div class="timer-stepper">
                                <button type="button" class="timer-stepper-btn" id="timerMinusBtn" aria-label="Decrease minutes">&minus;</button>
                                <input type="number" id="timerCustomMinutes" min="${CUSTOM_MIN_MINUTES}" max="${CUSTOM_MAX_MINUTES}" value="25" aria-label="Custom duration in minutes" inputmode="numeric" />
                                <span class="timer-stepper-unit">min</span>
                                <button type="button" class="timer-stepper-btn" id="timerPlusBtn" aria-label="Increase minutes">+</button>
                            </div>
                            <button type="button" class="btn btn-primary timer-start-btn" id="timerStartBtn">Start session</button>
                        </div>
                        <div class="chime-container">
                            <div class="checkbox checbox-switch">
                                <label>
                                    <input type="checkbox" id="timerChime" />
                                    <span></span>
                                </label>
                            </div>
                            <label for="timerChime" class="chime-label">Chime when the session ends</label>
                        </div>
                        <div class="chime-picker" id="chimePicker" role="radiogroup" aria-label="Session chime sound" hidden>
                            ${buildChimeOptions()}
                        </div>
                    </div>
                    <div id="timerRunningView" hidden>
                        <p class="timer-running-eyebrow">Session in progress</p>
                        <div class="timer-running-clock" id="timerRunningClock" aria-live="off">25:00</div>
                        <div class="timer-running-progress" role="progressbar" aria-label="Session progress">
                            <div class="timer-running-progress-fill" id="timerProgressBar"></div>
                        </div>
                        <p class="timer-running-hint">The timer keeps ticking in the bottom right corner. Keep writing!</p>
                        <div class="timer-running-actions">
                            <button type="button" class="btn btn-default" id="timerAddFiveBtn">+ 5 min</button>
                            <button type="button" class="btn btn-default" id="timerStopBtn">Stop session</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
`;

// Add timer HTML to the DOM
$(document.body).append(timerModalHtml);

$(document).ready(function () {
    if (localStorage.getItem('timerChime') && localStorage.getItem('timerChime') == 'true') {
        $('#timerChime').prop('checked', true);
    }

    $('#timerChime').change(function (this: HTMLElement) {
        const checkbox = this as HTMLInputElement;
        if (checkbox.checked) {
            localStorage.setItem('timerChime', 'true');
        } else {
            localStorage.setItem('timerChime', 'false');
        }
        refreshChimePicker();
    });

    // Chime sound selection — clicking a chime picks it and plays a preview.
    $(document).on('click', '.chime-option', function (this: HTMLElement) {
        const chimeId = $(this).data('chime') as string;
        localStorage.setItem(CHIME_STORAGE_KEY, chimeId);
        refreshChimeSelection();
        playChime(chimeId);
    });

    refreshChimeSelection();
    refreshChimePicker();

    const lastCustom = Number(localStorage.getItem(LAST_CUSTOM_DURATION_KEY));
    if (Number.isFinite(lastCustom) && lastCustom >= CUSTOM_MIN_MINUTES && lastCustom <= CUSTOM_MAX_MINUTES) {
        $('#timerCustomMinutes').val(lastCustom);
    }

    // Reflect the running state every time the modal opens.
    $('#timerModal').on('show.bs.modal', function () {
        refreshTimerViews();
    });
});

// ---------------------------------------------------------------------------
// Chime helpers
// ---------------------------------------------------------------------------

function getSelectedChime(): ChimeDef {
    const stored = localStorage.getItem(CHIME_STORAGE_KEY);
    return CHIMES.find(chime => chime.id === stored) || CHIMES[0];
}

function refreshChimeSelection(): void {
    const selected = getSelectedChime().id;
    document.querySelectorAll<HTMLElement>('.chime-option').forEach(option => {
        const isSelected = option.dataset.chime === selected;
        option.classList.toggle('is-selected', isSelected);
        option.setAttribute('aria-checked', String(isSelected));
    });
}

function refreshChimePicker(): void {
    const enabled = $('#timerChime').prop('checked');
    $('#chimePicker').prop('hidden', !enabled);
}

function playChime(chimeId: string): void {
    const chime = CHIMES.find(entry => entry.id === chimeId) || CHIMES[0];
    if (timerConfig.alarmSound) {
        timerConfig.alarmSound.pause();
        timerConfig.alarmSound.onended = null;
    }
    document.querySelectorAll<HTMLElement>('.chime-option.is-playing').forEach(option => {
        option.classList.remove('is-playing');
    });
    const optionEl = document.querySelector<HTMLElement>(`.chime-option[data-chime="${chime.id}"]`);
    timerConfig.alarmSound = new Audio(chime.file);
    timerConfig.alarmSound.loop = false;
    if (optionEl) {
        timerConfig.alarmSound.onended = () => optionEl.classList.remove('is-playing');
        timerConfig.alarmSound.onpause = () => optionEl.classList.remove('is-playing');
        optionEl.classList.add('is-playing');
    }
    timerConfig.alarmSound.play().catch(() => {
        /* Autoplay policy — the session-end chime retried after user gesture. */
        optionEl?.classList.remove('is-playing');
    });
}

// Timer functions
export function startTimer(minutes: number): void {
    if (timerConfig.timer) {
        stopTimer();
    }

    const durationInSeconds = minutes * 60;
    timerConfig.endTime = Date.now() + (durationInSeconds * 1000);
    timerConfig.remainingTime = durationInSeconds;
    timerConfig.totalDurationSec = durationInSeconds;
    timerConfig.isRunning = true;
    timerConfig.timer = setInterval(updateTimer, 1000);

    // Show timer pill
    $('.timer-pill').show().removeClass('timer-ending');
    updateTimerDisplay();

    // check if word-count-container is hidden and
    // based on that change right position of timer pill
    if ($('.word-count-container').is(':hidden')) {
        $('.timer-pill').css('right', timerPillRightPositionWithoutWordCount);
    }

    refreshTimerViews();
}

export function stopTimer(): void {
    if (timerConfig.timer) {
        clearInterval(timerConfig.timer);
    }
    timerConfig.timer = null;
    timerConfig.isRunning = false;
    timerConfig.remainingTime = 0;
    timerConfig.totalDurationSec = 0;
    timerConfig.endTime = null;
    $('.timer-pill').hide().removeClass('timer-ending');
    $('.timer-display').text('00:00');

    refreshTimerViews();
}

function addFiveMinutes(): void {
    if (!timerConfig.isRunning || timerConfig.endTime === null) {
        return;
    }

    timerConfig.endTime += 5 * 60 * 1000;
    timerConfig.totalDurationSec += 5 * 60;
    updateTimer();
    showToast('Added 5 minutes to your session.');
}

export function updateTimer(): void {
    // Interval callbacks can be throttled while the tab is in the background.
    // Calculate the remaining time from the deadline so that throttling only
    // delays the display update; it does not pause the timer itself.
    timerConfig.remainingTime = Math.max(
        0,
        Math.ceil((timerConfig.endTime! - Date.now()) / 1000)
    );

    if (timerConfig.remainingTime <= 0) {
        if (localStorage.getItem('timerChime') && localStorage.getItem('timerChime') == 'true') {
            playChimeSound();
        }

        stopTimer();
        showToast('Writing session complete. Nice work!');
        return;
    }

    $('.timer-pill').toggleClass('timer-ending', timerConfig.remainingTime <= 10);
    updateTimerDisplay();
}

export function updateTimerDisplay(): void {
    $('.timer-display').text(formatClock(timerConfig.remainingTime));

    // Live session view inside the modal
    $('#timerRunningClock').text(formatClock(timerConfig.remainingTime));

    const progress = timerConfig.totalDurationSec > 0
        ? Math.round(((timerConfig.totalDurationSec - timerConfig.remainingTime) / timerConfig.totalDurationSec) * 100)
        : 0;
    $('#timerProgressBar').css('width', `${progress}%`);
}

function refreshTimerViews(): void {
    const isRunning = timerConfig.isRunning;

    $('#timerSelectView').prop('hidden', isRunning);
    $('#timerRunningView').prop('hidden', !isRunning);

    if (isRunning) {
        updateTimerDisplay();
    }
}

// Initialize alarm sound
export function playChimeSound(): void {
    playChime(getSelectedChime().id);
}

function clampCustomMinutes(value: number): number {
    if (!Number.isFinite(value)) {
        return 25;
    }
    return Math.min(CUSTOM_MAX_MINUTES, Math.max(CUSTOM_MIN_MINUTES, Math.round(value)));
}

// Event listeners
$(document).on('click', '.timer-preset', function (this: HTMLElement) {
    const minutes = $(this).data('minutes') as number;
    startTimer(minutes);
    $('#timerModal').modal('hide');
    showToast(`Session started — ${minutes} minutes. Keep writing!`);
});

$(document).on('click', '#timerStartBtn', function () {
    const rawValue = Number(($('#timerCustomMinutes').val() as string | number | undefined) ?? 25);
    const minutes = clampCustomMinutes(rawValue);
    $('#timerCustomMinutes').val(minutes);
    localStorage.setItem(LAST_CUSTOM_DURATION_KEY, String(minutes));
    startTimer(minutes);
    $('#timerModal').modal('hide');
    showToast(`Session started — ${minutes} minutes. Keep writing!`);
});

$(document).on('click', '#timerMinusBtn', function () {
    const next = clampCustomMinutes(Number($('#timerCustomMinutes').val()) - 5);
    $('#timerCustomMinutes').val(next);
});

$(document).on('click', '#timerPlusBtn', function () {
    const next = clampCustomMinutes(Number($('#timerCustomMinutes').val()) + 5);
    $('#timerCustomMinutes').val(next);
});

$(document).on('click', '#timerAddFiveBtn', function () {
    addFiveMinutes();
});

$(document).on('click', '#timerStopBtn', function () {
    stopTimer();
    showToast('Session stopped.');
});

$(document).on('click', '#stopTimer', function () {
    stopTimer();
});

// Refresh immediately when returning to the tab. Browsers may pause or
// heavily throttle interval callbacks while a page is hidden.
document.addEventListener('visibilitychange', function () {
    if (!document.hidden && timerConfig.isRunning) {
        updateTimer();
    }
});
