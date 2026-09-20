/**
 * Padify Drawingpad — cloud backup for the drawing scene.
 *
 * The main app owns the sync session (supabase-js on the main page stores it
 * in localStorage under `sb-<project-ref>-auth-token`). This static page
 * reuses that session read-only for simple REST calls against the same
 * Supabase project, so a drawing saved here survives a lost browser the same
 * way notes do.
 *
 * Deliberately conservative:
 *  • No token refreshing — if the access token is expired, cloud work is
 *    skipped silently and the drawing keeps autosaving locally. (Refreshing
 *    from two independent pages could rotate the refresh token out from
 *    under the main app.)
 *  • Every failure is non-fatal and quiet — drawing must never break
 *    because the network is down.
 *
 * Last-write-wins on `updated_at` (epoch ms), which is exactly the scene's
 * existing `savedAt` stamp.
 */
(function () {
    'use strict';

    var CONFIG_KEY = 'padifyCloudConfig';

    function readConfig() {
        try {
            var raw = localStorage.getItem(CONFIG_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (parsed && parsed.url && parsed.anonKey) {
                return { url: String(parsed.url).replace(/\/+$/, ''), anonKey: parsed.anonKey };
            }
        } catch (error) { /* fall through */ }
        return null;
    }

    /**
     * Reads the main app's auth session. Returns null when signed out, the
     * config is missing, or the access token is expired (no refresh here —
     * see the header comment).
     */
    function readSession(config) {
        try {
            var prefix = 'sb-';
            var suffix = '-auth-token';
            for (var i = 0; i < localStorage.length; i++) {
                var key = localStorage.key(i);
                if (!key || key.indexOf(prefix) !== 0 || key.slice(-suffix.length) !== suffix) {
                    continue;
                }
                var parsed = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(parsed)) {
                    parsed = parsed[0];
                }
                if (parsed && parsed.currentSession) {
                    parsed = parsed.currentSession;
                }
                if (!parsed || !parsed.access_token || !parsed.user) {
                    continue;
                }
                // v2 stores expires_at as epoch seconds.
                var expiresAt = typeof parsed.expires_at === 'number'
                    ? parsed.expires_at * 1000
                    : 0;
                if (!expiresAt || Date.now() > expiresAt - 60_000) {
                    return null; // expired — let the main app refresh it
                }
                var userId = parsed.user && parsed.user.id;
                if (!userId) {
                    return null;
                }
                return { token: parsed.access_token, userId: userId };
            }
        } catch (error) { /* session unreadable — stay local */ }
        return null;
    }

    function authHeaders(config, session) {
        return {
            'authorization': 'Bearer ' + session.token,
            'apikey': config.anonKey,
            'content-type': 'application/json'
        };
    }

    /**
     * Returns the scene to open with: the local one, unless the cloud holds
     * a strictly newer version. Races the network against a short timeout so
     * the canvas never waits on a slow connection.
     */
    function getInitialScene(localScene) {
        var config = readConfig();
        var session = config && readSession(config);

        if (!config || !session) {
            return Promise.resolve(localScene);
        }

        var network = fetch(config.url + '/rest/v1/drawings?select=*', {
            method: 'GET',
            headers: authHeaders(config, session)
        })
            .then(function (response) {
                if (!response.ok) return null;
                return response.json();
            })
            .then(function (rows) {
                if (!Array.isArray(rows)) return null;
                var mine = null;
                rows.forEach(function (row) {
                    if (row && row.user_id === session.userId) {
                        mine = row;
                    }
                });
                if (!mine || !mine.scene || !Array.isArray(mine.scene.elements)) {
                    return null;
                }
                var localSavedAt = (localScene && localScene.savedAt) || 0;
                if ((mine.updated_at || 0) > localSavedAt) {
                    return {
                        elements: mine.scene.elements,
                        appState: mine.scene.appState || {},
                        savedAt: mine.updated_at || 0
                    };
                }
                return null; // local is current; keep it
            })
            .catch(function () {
                return null;
            });

        var timeout = new Promise(function (resolve) {
            setTimeout(function () { resolve(null); }, 700);
        });

        return Promise.race([network, timeout]).then(function (remote) {
            return remote || localScene;
        });
    }

    var pushTimer = null;

    /** Debounced best-effort push of a saved scene. */
    function pushScene(payload) {
        if (pushTimer) {
            clearTimeout(pushTimer);
        }

        pushTimer = setTimeout(function () {
            pushTimer = null;

            var config = readConfig();
            var session = config && readSession(config);
            if (!config || !session || !payload || !Array.isArray(payload.elements)) {
                return;
            }

            fetch(config.url + '/rest/v1/drawings', {
                method: 'POST',
                headers: Object.assign(authHeaders(config, session), {
                    'prefer': 'resolution=merge-duplicates'
                }),
                body: JSON.stringify([{
                    user_id: session.userId,
                    scene: payload,
                    updated_at: payload.savedAt || Date.now()
                }])
            }).catch(function () {
                /* offline or rejected — the local copy already saved */
            });
        }, 2000);
    }

    window.PadifyDrawingCloud = {
        getInitialScene: getInitialScene,
        pushScene: pushScene
    };
})();
