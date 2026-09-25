import $ from 'jquery';

// Bootstrap 3's UMD build expects jQuery on the global scope. Assigning it
// here (in its own module) guarantees the assignment runs before the
// `import 'bootstrap'` in main.ts is evaluated.
(window as unknown as { jQuery: typeof $; $: typeof $ }).jQuery = $;
(window as unknown as { jQuery: typeof $; $: typeof $ }).$ = $;

/**
 * INTERIM BRIDGE (deleted together with the bootstrap bundle).
 *
 * Bootstrap's plugins fire their lifecycle events (show.bs.modal,
 * hidden.bs.modal, …) through jQuery's event system only. Modules are being
 * migrated off jQuery onto the owned DOM facade (src/lib/q.ts) in batches —
 * this relay re-dispatches those jQuery events as native CustomEvents so
 * facade-bound listeners (addEventListener) receive them while the
 * bootstrap bundle is still driving modals. The ui/behavior controllers
 * dispatch natively themselves and this bridge goes away with the bundle.
 */
const BOOTSTRAP_EVENT_TYPES = [
  'show.bs.modal',
  'shown.bs.modal',
  'hide.bs.modal',
  'hidden.bs.modal',
  'show.bs.collapse',
  'shown.bs.collapse',
  'hide.bs.collapse',
  'hidden.bs.collapse',
].join(' ');

$(document).on(BOOTSTRAP_EVENT_TYPES, (event) => {
  const target = (event as unknown as { target: EventTarget | null }).target;
  if (target instanceof Element) {
    target.dispatchEvent(new CustomEvent(event.type));
  }
});

export default $;
