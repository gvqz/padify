/**
 * The attachment reference grammar + the garbage verdict, pinned.
 *
 * Everything here is shared by the app (export pass, local GC) and the
 * server (orphan GC) — these tests are the contract that keeps all
 * three readers agreeing. The pure planner runs against plain arrays;
 * no store, no DOM, no network.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_ORPHAN_GRACE_MS,
  collectAttachmentRefs,
  collectNoteAttachmentIds,
  collectSceneFileIds,
  isPadifyAttRef,
  orphanVerdicts,
  padifyAttId,
  padifyAttRef,
  sceneFileIdsFromSceneContent,
} from './att-refs';

describe('the reference scheme', () => {
  it('accepts exactly the store id shape', () => {
    expect(isPadifyAttRef('padify-att:att-0123456789abcdef01234567')).toBe(true);
    expect(isPadifyAttRef('padify-att:voice-2026-abcdef')).toBe(true);
    expect(isPadifyAttRef('padify-att:att-x')).toBe(false); // too short
    expect(isPadifyAttRef('padify-att:../../etc')).toBe(false);
    expect(isPadifyAttRef('padify-att:has:colon')).toBe(false);
    expect(isPadifyAttRef('https://example.com')).toBe(false);
    expect(isPadifyAttRef('')).toBe(false);
  });

  it('round-trips id → ref → id', () => {
    const id = 'att-0123456789abcdef01234567';
    expect(padifyAttId(padifyAttRef(id))).toBe(id);
    expect(padifyAttId('junk')).toBeNull();
  });
});

describe('collectAttachmentRefs', () => {
  it('collects inline images, definitions and raw-html img srcs', () => {
    const content = [
      'before',
      '',
      '![shot one](padify-att:att-aaaaaaaaaaaaaaaa)',
      '![ref][pic]',
      '',
      '[pic]: padify-att:att-bbbbbbbbbbbbbbbb',
      '',
      '<img src="padify-att:att-cccccccccccccccc" alt="raw">',
      "<img alt='q' src='padify-att:att-dddddddddddddddd'>",
      '![same again](padify-att:att-aaaaaaaaaaaaaaaa)',
    ].join('\n');
    expect(collectAttachmentRefs(content).sort()).toEqual([
      'att-aaaaaaaaaaaaaaaa',
      'att-bbbbbbbbbbbbbbbb',
      'att-cccccccccccccccc',
      'att-dddddddddddddddd',
    ]);
  });

  it('collects nothing from prose and junk (and never a malformed ref)', () => {
    const content = [
      'a normal note',
      '[a link](https://example.com)',
      '![x](padify-att:short)',
      '![x](padify-att:../../evil)',
      '<img src="https://example.com/i.png">',
    ].join('\n');
    expect(collectAttachmentRefs(content)).toEqual([]);
    expect(collectAttachmentRefs('')).toEqual([]);
  });
});

describe('collectSceneFileIds', () => {
  it('collects the image elements fileIds, in first-seen order', () => {
    const elements = [
      { type: 'rectangle', id: 'r1' },
      { type: 'image', fileId: 'att-bbbbbbbbbbbbbbbb' },
      { type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa' },
      { type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa' }, // duplicate — one entry
    ];
    expect(collectSceneFileIds(elements)).toEqual(['att-bbbbbbbbbbbbbbbb', 'att-aaaaaaaaaaaaaaaa']);
  });

  it('ignores deleted ghosts, non-images and junk fileIds', () => {
    const elements = [
      { type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa', isDeleted: true },
      { type: 'rectangle', fileId: 'att-bbbbbbbbbbbbbbbb' },
      { type: 'image', fileId: 'junk' },
      null,
      'string',
    ] as unknown as Record<string, unknown>[];
    expect(collectSceneFileIds(elements)).toEqual([]);
    expect(collectSceneFileIds([])).toEqual([]);
  });
});

describe('sceneFileIdsFromSceneContent', () => {
  const scene = (elements: unknown[]): string =>
    JSON.stringify({ version: 1, savedAt: 1, elements, appState: {} });

  it('reads a scene envelope through the elements walk (ghosts excluded)', () => {
    const content = scene([
      { type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa' },
      { type: 'image', fileId: 'att-bbbbbbbbbbbbbbbb', isDeleted: true },
    ]);
    expect(sceneFileIdsFromSceneContent(content)).toEqual(['att-aaaaaaaaaaaaaaaa']);
  });

  it('reads a future version verbatim when the elements array survives', () => {
    const content = JSON.stringify({
      version: 99,
      elements: [{ type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa' }],
    });
    expect(sceneFileIdsFromSceneContent(content)).toEqual(['att-aaaaaaaaaaaaaaaa']);
  });

  it('falls back to the generous read on corrupt bytes', () => {
    // The fileId string survives verbatim in the JSON text — the generous
    // read keeps it alive even when nothing can parse the envelope. JSON
    // vocabulary words come along as phantom ids (over-keep by design:
    // a phantom matches no stored row); the assertion pins the real one.
    const content = '{"elements":[{"type":"image","fileId":"att-aaaaaaaaaaaaaaaa"  ';
    expect(sceneFileIdsFromSceneContent(content)).toContain('att-aaaaaaaaaaaaaaaa');
  });

  it('falls back to the generous read when elements went missing', () => {
    const content = JSON.stringify({ version: 9, appState: {}, files: 'att-aaaaaaaaaaaaaaaa' });
    expect(sceneFileIdsFromSceneContent(content)).toContain('att-aaaaaaaaaaaaaaaa');
  });

  it('answers nothing from an empty or attachment-free scene', () => {
    expect(sceneFileIdsFromSceneContent(scene([]))).toEqual([]);
    expect(sceneFileIdsFromSceneContent('')).toEqual([]);
  });
});

describe('collectNoteAttachmentIds', () => {
  it('routes drawing notes through the scene reader', () => {
    const content = JSON.stringify({
      version: 1,
      elements: [{ type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa' }],
    });
    expect(collectNoteAttachmentIds({ content, noteType: 'drawing' })).toEqual([
      'att-aaaaaaaaaaaaaaaa',
    ]);
  });

  it('routes everything else through the content scan', () => {
    expect(collectNoteAttachmentIds({ content: '![x](padify-att:att-aaaaaaaaaaaaaaaa)' })).toEqual([
      'att-aaaaaaaaaaaaaaaa',
    ]);
    expect(collectNoteAttachmentIds({ content: 'plain text', noteType: 'standard' })).toEqual([]);
  });
});

describe('orphanVerdicts', () => {
  const NOW = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it('stamps a newcomer and never deletes it in the same sweep', () => {
    const verdicts = orphanVerdicts(
      [{ id: 'att-aaaaaaaaaaaaaaaa', orphanSince: null }],
      new Set(),
      NOW,
    );
    expect(verdicts).toEqual({ clearClock: [], stampClock: ['att-aaaaaaaaaaaaaaaa'], garbage: [] });
  });

  it('holds an unreferenced attachment inside the grace window', () => {
    const verdicts = orphanVerdicts(
      [{ id: 'att-aaaaaaaaaaaaaaaa', orphanSince: NOW - ATTACHMENT_ORPHAN_GRACE_MS + DAY }],
      new Set(),
      NOW,
    );
    expect(verdicts).toEqual({ clearClock: [], stampClock: [], garbage: [] });
  });

  it('deletes an unreferenced attachment past the grace window', () => {
    const verdicts = orphanVerdicts(
      [{ id: 'att-aaaaaaaaaaaaaaaa', orphanSince: NOW - ATTACHMENT_ORPHAN_GRACE_MS - DAY }],
      new Set(),
      NOW,
    );
    expect(verdicts.garbage).toEqual(['att-aaaaaaaaaaaaaaaa']);
  });

  it('clears the clock when a reference came back', () => {
    const verdicts = orphanVerdicts(
      [{ id: 'att-aaaaaaaaaaaaaaaa', orphanSince: NOW - ATTACHMENT_ORPHAN_GRACE_MS - DAY }],
      new Set(['att-aaaaaaaaaaaaaaaa']),
      NOW,
    );
    expect(verdicts).toEqual({
      clearClock: ['att-aaaaaaaaaaaaaaaa'],
      stampClock: [],
      garbage: [],
    });
  });

  it('never proposes a write for a referenced attachment without a clock', () => {
    const verdicts = orphanVerdicts(
      [{ id: 'att-aaaaaaaaaaaaaaaa', orphanSince: null }],
      new Set(['att-aaaaaaaaaaaaaaaa']),
      NOW,
    );
    expect(verdicts).toEqual({ clearClock: [], stampClock: [], garbage: [] });
  });

  it('judges each entry on its own clock (stamp, hold, delete)', () => {
    const verdicts = orphanVerdicts(
      [
        { id: 'att-aaaaaaaaaaaaaaaa', orphanSince: NOW - 2 * DAY }, // inside grace — hold
        { id: 'att-bbbbbbbbbbbbbbbb', orphanSince: NOW - 2 * ATTACHMENT_ORPHAN_GRACE_MS }, // past — garbage
        { id: 'att-cccccccccccccccc', orphanSince: null }, // newcomer — stamp
      ],
      new Set(),
      NOW,
    );
    expect(verdicts).toEqual({
      clearClock: [],
      stampClock: ['att-cccccccccccccccc'],
      garbage: ['att-bbbbbbbbbbbbbbbb'],
    });
  });
});
