/**
 * Padify Drawingpad — a full-featured drawing canvas built on a self-hosted
 * copy of the Excalidraw canvas component.
 *
 * Everything is served from this directory (no CDN, no external requests) and
 * the app itself stays quiet: no links back to the vendor's site, no badge,
 * no telemetry. The scene autosaves to localStorage and is restored on load.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'padifyDrawingpadScene';
    var libs = window.ExcalidrawLib;

    if (!libs || !window.React || !window.ReactDOM) {
        var loading = document.getElementById('padLoading');
        if (loading) loading.textContent = 'The drawing canvas failed to load. Try refreshing the page.';
        return;
    }

    var Excalidraw = libs.Excalidraw;
    var Footer = libs.Footer;

    // ---------------------------------------------------------------------
    // Scene persistence
    // ---------------------------------------------------------------------

    function loadScene() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var data = JSON.parse(raw);
            if (!data || !Array.isArray(data.elements)) return null;
            return {
                elements: data.elements,
                appState: data.appState || {},
                savedAt: data.savedAt || 0
            };
        } catch (error) {
            return null;
        }
    }

    /** App-state bits worth persisting between visits. */
    var APP_STATE_KEYS = [
        'viewBackgroundColor',
        'currentItemStrokeColor',
        'currentItemBackgroundColor',
        'currentItemFillStyle',
        'currentItemStrokeWidth',
        'currentItemStrokeStyle',
        'currentItemRoughness',
        'currentItemOpacity',
        'currentItemFontFamily',
        'currentItemFontSize',
        'currentItemTextAlign',
        'currentItemStartArrowhead',
        'currentItemEndArrowhead',
        'currentItemRoundness',
        'currentItemEdgeKind',
        'gridSize',
        'gridModeEnabled'
    ];

    var saveTimer = null;
    var excalidrawApi = null;

    function saveScene(elements, appState) {
        if (saveTimer) {
            clearTimeout(saveTimer);
        }

        saveTimer = setTimeout(function () {
            saveTimer = null;
            try {
                var pickedAppState = {};
                APP_STATE_KEYS.forEach(function (key) {
                    if (appState && appState[key] !== undefined) {
                        pickedAppState[key] = appState[key];
                    }
                });

                var payload = {
                    version: 1,
                    savedAt: Date.now(),
                    elements: elements,
                    appState: pickedAppState
                };

                localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

                // Cloud backup — quiet no-op unless the main app's sync
                // session is available and fresh (see cloud.js).
                if (window.PadifyDrawingCloud) {
                    window.PadifyDrawingCloud.pushScene(payload);
                }
            } catch (error) {
                /* storage full or unavailable — drawing keeps working */
            }
        }, 300);
    }

    // ---------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------

    var rootElement = document.getElementById('drawingRoot');
    var localScene = loadScene();

    // The cloud check races a short timeout inside getInitialScene, so the
    // canvas opens with local data when offline or signed out, and with the
    // newer cloud scene when one exists (e.g. a fresh browser).
    var initialData = window.PadifyDrawingCloud
        ? window.PadifyDrawingCloud.getInitialScene(localScene)
        : Promise.resolve(localScene);

    function createElement(type, props) {
        return window.React.createElement(type, props);
    }

    var options = {
        initialData: initialData || undefined,
        // Themes follow the device preference.
        theme: (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
            ? 'dark'
            : 'light',
        // Hide every canvas action that links out or leaves the app.
        UIOptions: {
            canvasActions: {
                loadFile: true,
                saveToDisk: true,
                export: false,
                saveAsImage: true,
                clearCanvas: false, // the navbar has its own clear button
                changeCanvasBackground: true
            }
        },
        onChange: function (elements, appState) {
            saveScene(elements, appState);
        },
        excalidrawAPI: function (api) {
            excalidrawApi = api;
        }
    };

    // Replace the vendor footer (which links back to the vendor site) with a
    // quiet Padify label.
    var footer = createElement(Footer, null,
        createElement('span', {
            style: {
                fontSize: '11px',
                color: 'rgba(128,128,128,0.9)',
                pointerEvents: 'none',
                userSelect: 'none'
            }
        }, 'Padify')
    );

    var root = ReactDOM.createRoot(rootElement);
    root.render(createElement(Excalidraw, options, footer));

    var loadingNode = document.getElementById('padLoading');
    if (loadingNode && loadingNode.parentNode) {
        loadingNode.parentNode.removeChild(loadingNode);
    }

    // ---------------------------------------------------------------------
    // Clear canvas
    // ---------------------------------------------------------------------

    document.getElementById('clearCanvasBtn').addEventListener('click', function () {
        if (!window.confirm('Clear the whole canvas? This cannot be undone.')) {
            return;
        }

        if (excalidrawApi && typeof excalidrawApi.updateScene === 'function') {
            excalidrawApi.updateScene({ elements: [] });
        }
    });
})();
