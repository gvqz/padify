import $ from 'jquery';
import Swal from 'sweetalert2';
import { get, setState, selector } from './selector';
import type { NotepadUI } from './selector';
import { getTabManager } from './tabs';

// Bootstrap 3's jQuery modal plugin (registered globally by the `bootstrap`
// import in main.ts) is not covered by @types/jquery.
declare global {
  interface JQuery {
    modal(action: string | { [key: string]: unknown }): JQuery;
  }
}

export function getFileName(): string {
    return 'Notes-' + getCurrentDate() + '.txt';
}

export function getPdfFileName(): string {
    return 'Notes-' + getCurrentDate() + '.pdf';
}

export function getDocxFileName(): string {
    return 'Notes-' + getCurrentDate() + '.docx';
}

export function getHtmlFileName(): string {
    return 'Notes-' + getCurrentDate() + '.html';
}

export function getCurrentDate(): string {
    const currentDate = new Date();

    return currentDate.getDate() + '-' + (currentDate.getMonth() + 1) + '-' + currentDate.getFullYear();
}

export function showToast(message: string): void {
    const toast = document.getElementById('toast')!;
    toast.className = 'show';
    toast.innerHTML = message;

    setTimeout(function () {
        toast.className = toast.className.replace('show', '');
    }, 2000);
}

/**
 * Debounce wrapper. The returned function forwards its `this` value and all
 * arguments to `func` (the original implementation captured `this`/`arguments`
 * and re-applied them), so it can be used as a drop-in event handler.
 */
export function debounce<T extends (...args: never[]) => void>(
    func: T,
    wait: number,
    immediate?: boolean
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function (this: unknown, ...args: Parameters<T>) {
        const context = this;
        const later = function () {
            timeout = undefined;
            if (!immediate) {
                func.apply(context, args);
            }
        };

        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) {
            func.apply(context, args);
        }
    };
}

export function saveTextAsFile(textToWrite: string, fileNameToSaveAs: string): void {
    const textFileAsBlob = new Blob([textToWrite], { type: 'text/plain' });
    const downloadLink = document.createElement('a');
    downloadLink.download = fileNameToSaveAs;
    downloadLink.innerHTML = 'Download File';

    const webkitURL = (window as Window & { webkitURL?: typeof URL }).webkitURL;
    if (webkitURL != null) {
        downloadLink.href = webkitURL.createObjectURL(textFileAsBlob);
    } else {
        downloadLink.href = window.URL.createObjectURL(textFileAsBlob);
        downloadLink.style.display = 'none';
        document.body.appendChild(downloadLink);
    }

    downloadLink.click();
}

export function getPWADisplayMode(): 'twa' | 'standalone' | 'browser' {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

    if (document.referrer.startsWith('android-app://')) {
        return 'twa';
    } else if ((navigator as Navigator & { standalone?: boolean }).standalone || isStandalone) {
        return 'standalone';
    }

    return 'browser';
}

export function enableDarkMode(lightmodeText: string, darkMetaColor: string, metaThemeColor: HTMLElement | null): void {
    $(document.body).addClass('dark');
    $('.navbar').removeClass('navbar-default');
    $('#mode').attr('title', lightmodeText);
    $('#themeIcon').attr('src', 'img/navbar/light-theme.svg');
    metaThemeColor!.setAttribute('content', darkMetaColor);
    localStorage.setItem('mode', 'dark');
}

export function enableLightMode(darkmodeText: string, lightMetaColor: string, metaThemeColor: HTMLElement | null): void {
    $(document.body).removeClass('dark');
    $('.navbar').addClass('navbar-default');
    $('#mode').attr('title', darkmodeText);
    $('#themeIcon').attr('src', 'img/navbar/dark-theme.svg');
    metaThemeColor!.setAttribute('content', lightMetaColor);
    localStorage.setItem('mode', 'light');
}

export interface ThemeConfig {
    lightmodeText: string;
    darkmodeText: string;
    lightMetaColor: string;
    darkMetaColor: string;
    metaThemeColor: HTMLElement | null;
}

export function enableDeviceTheme(themeConfig: ThemeConfig): void {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        enableDarkMode(themeConfig.lightmodeText, themeConfig.darkMetaColor, themeConfig.metaThemeColor)
    } else {
        enableLightMode(themeConfig.darkmodeText, themeConfig.lightMetaColor, themeConfig.metaThemeColor)
    }

    localStorage.setItem('mode', 'device');
}

export function resetFontSize(defaultFontSize: number): void {
    $('#note').css('font-size', defaultFontSize + "px");
    $('#fontSize').val(defaultFontSize);
}

export function resetLineHeight(defaultLineHeight: number): void {
    $('#note').css('line-height', defaultLineHeight + "px");
    $('#lineHeight').val(defaultLineHeight);
}

export function resetFontWeight(defaultFontWeight: string): void {
    $('#note').css('font-weight', defaultFontWeight);
    $('#fontWeight').val(defaultFontWeight);
}

export function resetShowWordCountPill(defaultShowWordCountPill: string): void {
    defaultShowWordCountPill === 'Yes' ? $('.word-count-container').show() : $('.word-count-container').hide();
    $('#showWordCountPill').prop('checked', defaultShowWordCountPill === 'Yes');
}

export function resetWriteDirection(defaultWriteDirection: string): void {
    $('#note').css('direction', defaultWriteDirection);
    $('#writeDirection').val(defaultWriteDirection);
}

export function resetTexture(defaultTexture: string): void {
    $(document.body).removeClass('dotted-paper');
    $(document.body).removeClass('graph-paper');
    $(document.body).removeClass('chessboard-paper');
    $(document.body).removeClass('starfield-paper');
    $(document.body).removeClass('grain-paper');
    $(document.body).removeClass('linen-paper');
    $(document.body).removeClass('recycled-paper');
    $(document.body).removeClass('newspaper-paper');
    $(document.body).removeClass('marble-paper');
    $('#texture').val(defaultTexture);
}

export function resetFont(defaultFont: string): void {
    $('#note').removeClass('dyslexic monospaced serif handwritten humanist pixel typewriter crayon');
    $('#font').val(defaultFont);
}

export function resetOptimalLineLength(defaultEditorPadding: string, defaultOption: boolean): void {
    const textArea = document.getElementById('note')!;
    textArea.style.padding = defaultEditorPadding;
    $('#optimalLineLength').prop('checked', defaultOption);
}

export function countWords(str: string): number {
    const trimmedText = str.trim();

    if (trimmedText === '') {
        return 0;
    }

    return trimmedText.split(/\s+/).length;
}

export function extractWordTokens(str: string): string[] {
    return str.toLowerCase().match(/\b[a-z']+\b/g) || [];
}

export function countSyllables(word: string): number {
    const cleanedWord = word.toLowerCase().replace(/[^a-z']/g, '');

    if (cleanedWord.length === 0) {
        return 0;
    }

    const syllableMatches = cleanedWord
        .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
        .replace(/^y/, '')
        .match(/[aeiouy]{1,2}/g);

    return syllableMatches ? syllableMatches.length : 1;
}

export function calculateCharactersAndWords(str: string): string {
    const characterCount = str.length;
    const wordCount = str !== '' ? countWords(str) : 0;
    const characterString = characterCount > 1 ? 'characters' : 'character';
    const wordString = wordCount > 1 ? 'words' : 'word';
    const wordCountText = `${characterCount} ${characterString} • ${wordCount} ${wordString}`;

    return wordCountText;
}

export interface NoteStatistics {
    characters: number;
    words: number;
    sentences: number;
    paragraphs: number;
    averageWordLength: string | number;
    readingTime: string;
    uniqueWords: number;
    lexicalDensity: string;
    lexicalDensityScore: string;
    mostCommonWord: string;
    readabilityScore: string;
    estimatedPages: string;
    estimatedSpeakingTime: string;
}

export function calculateNoteStatistics(str: string): NoteStatistics {
    if (!str || str.trim() === '') {
        return {
            characters: 0,
            words: 0,
            sentences: 0,
            paragraphs: 0,
            averageWordLength: 0,
            readingTime: '0 min',
            uniqueWords: 0,
            lexicalDensity: '0%',
            lexicalDensityScore: '0%',
            mostCommonWord: 'N/A',
            readabilityScore: '0.0',
            estimatedPages: '0 pages',
            estimatedSpeakingTime: '0 min'
        };
    }

    const characters = str.length;
    const words = countWords(str);
    const wordTokens = extractWordTokens(str);

    // Count sentences (split by . ! ?)
    const sentences = str.split(/[.!?]+/).filter(s => s.trim().length > 0).length;

    // Count paragraphs (split by double newlines or multiple line breaks)
    const paragraphs = str.split(/\n\n+/).filter(p => p.trim().length > 0).length;

    // Calculate average word length
    const averageWordLength = words > 0 ? (characters / words).toFixed(2) : 0;

    // Calculate reading time (average 200 words per minute)
    const readingTimeMinutes = Math.ceil(words / 200);
    const readingTime = readingTimeMinutes === 1 ? '1 min' : `${readingTimeMinutes} mins`;

    const contentWords = wordTokens.filter(word => !STOP_WORDS.has(word));

    // Calculate unique words from the full token set
    const wordFrequency: Record<string, number> = {};
    wordTokens.forEach(word => {
        wordFrequency[word] = (wordFrequency[word] || 0) + 1;
    });

    // Calculate most common content word separately so stop words are excluded
    const contentWordFrequency: Record<string, number> = {};
    let maxCount = 0;
    let mostCommonWord = 'N/A';

    contentWords.forEach(word => {
        contentWordFrequency[word] = (contentWordFrequency[word] || 0) + 1;
        if (contentWordFrequency[word] > maxCount) {
            maxCount = contentWordFrequency[word];
            mostCommonWord = word;
        }
    });

    const uniqueWords = Object.keys(wordFrequency).length;
    const lexicalDensityScore = words > 0 ? ((contentWords.length / words) * 100).toFixed(1) : 0;

    const syllableCount = wordTokens.reduce((total, word) => total + countSyllables(word), 0);
    const averageWordsPerSentence = sentences > 0 ? words / sentences : words;
    const averageSyllablesPerWord = words > 0 ? syllableCount / words : 0;
    const readabilityScore = sentences > 0 && words > 0
        ? Math.max(0, Math.min(100, 206.835 - (1.015 * averageWordsPerSentence) - (84.6 * averageSyllablesPerWord))).toFixed(1)
        : '0.0';

    const estimatedPagesValue = Math.round((words / 250) * 10) / 10;
    const estimatedPages = estimatedPagesValue === 0
        ? '0.0 pages'
        : `${estimatedPagesValue.toFixed(1)} ${estimatedPagesValue === 1 ? 'page' : 'pages'}`;

    const speakingTimeMinutes = Math.ceil(words / 130);
    const estimatedSpeakingTime = speakingTimeMinutes === 1 ? '1 min' : `${speakingTimeMinutes} mins`;

    return {
        characters,
        words,
        sentences,
        paragraphs,
        averageWordLength,
        readingTime,
        uniqueWords,
        lexicalDensity: `${lexicalDensityScore}%`,
        mostCommonWord: mostCommonWord === 'N/A' ? mostCommonWord : mostCommonWord.charAt(0).toUpperCase() + mostCommonWord.slice(1),
        readabilityScore,
        estimatedPages,
        estimatedSpeakingTime,
        lexicalDensityScore: `${lexicalDensityScore}%`
    };
}

export const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
    'can', 'cannot', 'could',
    'did', 'do', 'does', 'doing', 'down', 'during',
    'each',
    'few', 'for', 'from', 'further',
    'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
    'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
    'just',
    'me', 'more', 'most', 'my', 'myself',
    'no', 'nor', 'not', 'now',
    'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
    'same', 'she', 'should', 'so', 'some', 'such',
    'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
    'those', 'through', 'to', 'too',
    'under', 'until', 'up',
    'very',
    'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
    'you', 'your', 'yours', 'yourself', 'yourselves'
]);

export function copyNotesToClipboard(note: string): void {
    navigator.clipboard.writeText(note).then(function () {
        Swal.fire({
            toast: true,
            position: 'bottom',
            icon: 'success',
            title: 'Notes copied to clipboard!',
            showConfirmButton: false,
            timer: 2000,
            customClass: {
                popup: 'swal-toast-bottom-offset'
            }
        });
    }, function () {
        Swal.fire({
            toast: true,
            position: 'bottom',
            icon: 'error',
            title: 'Fail to copy. Check permissions for clipboard.',
            showConfirmButton: false,
            timer: 2000,
            customClass: {
                popup: 'swal-toast-bottom-offset'
            }
        });
    });
}

export function toggleTheme({
    lightmodeText,
    darkmodeText,
    lightMetaColor,
    darkMetaColor,
    metaThemeColor
}: ThemeConfig): void {
    get(document.body).toggleClass('dark');
    const bodyClass = get(document.body).attr('class');

    if (bodyClass === 'dark') {
        enableDarkMode(lightmodeText, darkMetaColor, metaThemeColor)
    } else {
        enableLightMode(darkmodeText, lightMetaColor, metaThemeColor)
    }

    setState('isUserPreferredTheme', 'true');
}

export function deleteNotes(): void {
    Swal.fire({
        title: 'Want to delete notes?',
        text: "You won't be able to revert this!",
        icon: 'warning',
        showCancelButton: true,
        customClass: {
            confirmButton: 'swal-btn-danger'
        },
        confirmButtonText: 'Yes, Delete!',
        cancelButtonText: 'No, keep it.'
    }).then((result) => {
        if (result.value) {
            // save a snapshot before deleting it
            window.snapshotsManager!.createSnapshot();

            // Clear the active tab (delete-notes only ever deleted the note
            // that was on screen, so it stays per-tab now that tabs exist).
            getTabManager()?.clearActiveTab();

            Swal.fire(
                'Deleted!',
                'Your notes has been deleted.',
                'success'
            )
        }
    })
}

export let focusModeHoverTimer: ReturnType<typeof setTimeout> | null = null;

export function toggleFocusMode(notepad: NotepadUI): void {
    const navbar = document.querySelector('.navbar') as HTMLElement;
    const bodyElement = document.body;
    const textArea = document.getElementById('note')!;
    const closeButton = document.getElementById('focusModeCloseButton') as HTMLElement;

    // Check if focus mode is currently active
    const isFocusMode = document.documentElement.hasAttribute('data-focus-mode');

    if (!isFocusMode) {
        // Entering focus mode
        document.documentElement.setAttribute('data-focus-mode', 'true');
        navbar.style.display = 'none';
        bodyElement.style.paddingTop = '0';
        textArea.style.borderRight = 'none';
        textArea.style.borderLeft = 'none';

        // Show close button
        closeButton.style.display = 'block';

        // Hide toast popup
        const toastPopup = document.querySelector('.toast-popup');
        if (toastPopup) {
            toastPopup.classList.remove('show');
        }

        notepad.bottomLine.hide();

        // Keep focus on textarea
        textArea.focus();
    } else {
        // Exiting focus mode
        turnOffFocusMode(notepad);
    }
}

// a function for turning off focus mode
export function turnOffFocusMode(notepad: NotepadUI): void {
    const navbar = document.querySelector('.navbar') as HTMLElement;
    const bodyElement = document.body;
    const textArea = document.getElementById('note')!;
    const closeButton = document.getElementById('focusModeCloseButton') as HTMLElement;

    // Remove focus mode
    document.documentElement.removeAttribute('data-focus-mode');

    // Hide close button
    closeButton.style.display = 'none';

    // Reset styles
    navbar.style.display = '';
    bodyElement.style.paddingTop = '';
    textArea.style.borderRight = '';
    textArea.style.borderLeft = '';

    if (localStorage.getItem('userChosenWordCountPillSelected') === 'Yes' || selector().defaultConfig.defaultShowWordCountPill === 'Yes') {
        notepad.bottomLine.show();
    }

    // Keep focus on textarea
    textArea.focus();
}

export function toggleFullScreen(): void {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        $('#arrowPointsOut').hide();
        $('#arrowPointsIn').show();
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
            $('#arrowPointsIn').hide();
            $('#arrowPointsOut').show();
        }
    }
}

export function exportNotesAsPDF(textToWrite: string, fileNameToSaveAs: string): void {
    // jsPDF is heavy, so it is only fetched when a PDF export is requested.
    void import('jspdf').then(({ jsPDF }) => {
        const pdf = new jsPDF();
        const marginLeft = 10;
        const marginTop = 10;

        // Width of text area
        const maxWidth = 180;

        const lineHeight = 10;

        // Height of a single page
        const pageHeight = pdf.internal.pageSize.height;

        // Initial Y position for text
        let yPosition = marginTop;

        // Split content into lines that fit within maxWidth
        const lines = pdf.splitTextToSize(textToWrite, maxWidth);

        lines.forEach((line: string) => {
            if (yPosition + lineHeight > pageHeight) {
                pdf.addPage();  // Add a new page if content exceeds page height
                yPosition = marginTop; // Reset Y position for new page
            }
            pdf.text(line, marginLeft, yPosition);
            yPosition += lineHeight;
        });

        pdf.save(fileNameToSaveAs);
    });
}

export function exportNotesAsDocx(textToWrite: string, fileNameToSaveAs: string): void {
    // The docx bundle is heavy, so it is only fetched on demand.
    void import('docx').then(({ Document, Paragraph, TextRun, Packer }) => {
        const doc = new Document({
            sections: [{
                properties: {},
                children: [
                    new Paragraph({
                        children: [
                            new TextRun({
                                text: textToWrite,
                            }),
                        ],
                    }),
                ],
            }]
        });

        Packer.toBlob(doc).then(blob => {
            const downloadLink = document.createElement('a');
            downloadLink.href = window.URL.createObjectURL(blob);
            downloadLink.download = fileNameToSaveAs;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
        });
    });
}

export function downloadHTML(htmlContent: string, fileNameToSaveAs: string): void {
    // `htmlContent` arrives pre-sanitised from the editor's formatting subset.
    const html = `<html>
        <head><meta charset="utf-8"><title>Notes</title></head>
        <body>
            <div style="white-space: pre-wrap; word-wrap: break-word; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.55; padding: 24px;">${htmlContent}</div>
        </body>
    </html>`;

    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileNameToSaveAs;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}


export function updateWordCountPill(note: string = ''): void {
    const { notepad } = selector();
    const characterAndWordCountText = calculateCharactersAndWords(note);
    notepad.wordCount.text(characterAndWordCountText);
}
