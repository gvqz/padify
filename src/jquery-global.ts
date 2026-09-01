import $ from 'jquery';

// Bootstrap 3's UMD build expects jQuery on the global scope. Assigning it
// here (in its own module) guarantees the assignment runs before the
// `import 'bootstrap'` in main.ts is evaluated.
(window as unknown as { jQuery: typeof $; $: typeof $ }).jQuery = $;
(window as unknown as { jQuery: typeof $; $: typeof $ }).$ = $;

export default $;
