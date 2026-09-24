import './jquery-global';
import 'bootstrap';
import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

import { storageReady } from './storage';

// Kick the IndexedDB open + hydration at module evaluation — the earliest
// possible moment — so it overlaps bundle evaluation and DOM parsing. Every
// consumer (app.ts, white-noise-player.ts) awaits storageReady() before
// reading any state, and app.ts constructs the music player only after.
void storageReady();

import './app';
import './help';
import './snapshots';
import './timer';
import './white-noise-player';
import './music-player';
import './context-menu';

// Expose Swal for any legacy code paths that still reference the global.
(window as unknown as { Swal: typeof Swal }).Swal = Swal;
