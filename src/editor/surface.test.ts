/**
 * The surface registry's type-keyed layer — the precedence rules, pinned.
 *
 * The kind registry serves every note; the type layer exists for the one
 * case a kind cannot: two types sharing a content kind but needing
 * different surfaces ('tasks' and 'drawing' are both 'json'). These
 * tests pin the lookup ORDER — a type claim wins, an unclaimed type
 * falls to its kind, an unknown type falls to opaque — because a change
 * in that order silently re-routes a note kind's whole presentation.
 */
import { describe, expect, it } from 'vitest';
import {
  htmlNoteSurface,
  noteSurfaceFor,
  noteSurfaceForKind,
  opaqueNoteSurface,
  registerNoteSurface,
  registerNoteSurfaceForType,
  type NoteSurface,
  type SurfaceNote,
} from './surface';

/** A minimal stand-in surface for the precedence probes. */
const stubSurface = (kind: NoteSurface['kind']): NoteSurface =>
  ({
    kind,
    editable: false,
    display: () => undefined,
    capture: () => null,
    visibleText: () => '',
    commit: () => false,
    clear: () => undefined,
  }) as NoteSurface;

const note = (noteType?: string): SurfaceNote => ({ content: '', noteType });

describe('the kind layer (unchanged behavior)', () => {
  it('serves registered kinds', () => {
    expect(noteSurfaceForKind('html')).toBe(htmlNoteSurface);
    expect(noteSurfaceForKind('opaque')).toBe(opaqueNoteSurface);
  });

  it('falls to the opaque fallback for unregistered kinds', () => {
    // 'text'/'json' stay unregistered in this file's module graph on
    // purpose — that is exactly the old-build-meets-new-kind story.
    expect(noteSurfaceForKind('text')).toBe(opaqueNoteSurface);
    expect(noteSurfaceForKind('json')).toBe(opaqueNoteSurface);
  });
});

describe('the type-keyed layer (the new precedence)', () => {
  it('a type claim wins over the kind lookup', () => {
    const stub = stubSurface('json');
    registerNoteSurfaceForType('probe-kind-override', stub);
    expect(noteSurfaceFor(note('probe-kind-override'))).toBe(stub);
  });

  it('a type claim wins even over the html default when the kind says html', () => {
    const stub = stubSurface('html');
    registerNoteSurfaceForType('probe-html-override', stub);
    expect(noteSurfaceFor(note('probe-html-override'))).toBe(stub);
  });

  it('an unclaimed type falls to its kind', () => {
    expect(noteSurfaceFor(note('rich'))).toBe(htmlNoteSurface);
  });

  it('an absent type is the default note — the html surface', () => {
    expect(noteSurfaceFor(undefined)).toBe(htmlNoteSurface);
    expect(noteSurfaceFor(null)).toBe(htmlNoteSurface);
    expect(noteSurfaceFor({ content: '' })).toBe(htmlNoteSurface);
  });

  it('a fresh kind registration still serves that kind’s registered types', () => {
    // A kind surface serves the REGISTERED types of its kind (an unknown
    // type id answers opaque through contentKindFor itself — that is the
    // forward-compat path, and it never consults a kind surface). This
    // is exactly how the real Markdown surface took over 'text'.
    const stub = stubSurface('text');
    registerNoteSurface('text', stub);
    expect(noteSurfaceForKind('text')).toBe(stub);
    expect(noteSurfaceFor(note('markdown'))).toBe(stub);
  });
});
