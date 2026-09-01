import './jquery-global';
import 'bootstrap';
import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

import './app';
import './snapshots';
import './timer';
import './white-noise-player';

// Expose Swal for any legacy code paths that still reference the global.
(window as unknown as { Swal: typeof Swal }).Swal = Swal;
