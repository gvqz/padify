// All app stylesheets load as ordered <link> tags from index.html (see the
// note there) — the app's styles stay fully static, no bundler involved.
//
// Bootstrap's JS bundle is GONE: its three used behaviors (modal, collapse,
// tooltip) live in src/ui/behavior/ as owned native-DOM controllers, wired
// by boot.ts. Only the vendored bootstrap stylesheet remains (a <link> in
// index.html), pinned by src/architecture.test.ts.

import { storageReady } from './storage';
import { bootPadify } from './boot';
import { installPlaceholderLinkGuard } from './ui/placeholder-links';

// Kick the IndexedDB open + hydration at module evaluation — the earliest
// possible moment — so it overlaps bundle evaluation and DOM parsing. Every
// consumer awaits storageReady() before reading any state; the music
// subsystem loads its engines on demand (app.ts's initMusicSubsystem)
// because their constructors read persisted state after hydration.
void storageReady();

// Placeholder anchors (href="#" where the behavior lives in delegated
// handlers) must never navigate — see ui/placeholder-links.ts. Registered
// first so no shell markup can be activated before the guard exists.
installPlaceholderLinkGuard();

// Everything else starts through the composition root — boot.ts owns the
// startup sequence. No feature module may self-initialize on import.
void bootPadify();
