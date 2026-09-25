import './jquery-global';
import 'bootstrap';
import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

// All app stylesheets load as ordered <link> tags from index.html (see the
// note there) — the app's styles stay fully static, no bundler involved.

import { storageReady } from './storage';
import { bootPadify } from './boot';

// Kick the IndexedDB open + hydration at module evaluation — the earliest
// possible moment — so it overlaps bundle evaluation and DOM parsing. Every
// consumer (app.ts, white-noise-player.ts) awaits storageReady() before
// reading any state, and app.ts constructs the music player only after.
void storageReady();

// Everything else starts through the composition root — boot.ts owns the
// startup sequence. No feature module may self-initialize on import.
void bootPadify();

// Expose Swal for any legacy code paths that still reference the global.
(window as unknown as { Swal: typeof Swal }).Swal = Swal;
