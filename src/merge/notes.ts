/**
 * Note-level three-way merge — what the sync layer calls when a note
 * changed on two devices at once.
 *
 * Two devices editing the same note is usually NOT a collision: one adds
 * milk to the top of the grocery list while the other fixes a typo at the
 * bottom — complementary edits over a shared ancestor. This module diffs
 * both sides against the ancestor (see diff3.ts) and splices them
 * together; only genuinely overlapping edits answer `conflict`, and the
 * caller routes those to review instead of minting a twin note.
 *
 * The guards, in order:
 *  • KIND — only html notes (tags stay atomic) and text notes merge.
 *    Everything else (a task list's JSON, a drawing's scene envelope) is
 *    opaque to a text diff and goes straight to review.
 *  • SIZE — past MAX_MERGE_BYTES the diffs stop being cheap and the
 *    honest answer is review, not a fifty-thousand-token splice.
 *  • BALANCE — merged html must still nest cleanly (tagsBalance); a hunk
 *    boundary that would split a tag pair answers conflict.
 *  • NAME — the title merges by the same three-way rule on its own; two
 *    different renames answer conflict (the words may merge, the review
 *    still gets to pick the name).
 */

import { mergeThreeWay } from './diff3';
import { contentKindFor, type NoteType } from '../editor/note-types';
import { detokenize, tagsBalance, tokenizeHtml, tokenizeText } from './tokens';

/** Notes past this size skip the merge and answer conflict. */
export const MAX_MERGE_BYTES = 400_000;

export interface NoteVersion {
  name: string | null;
  content: string;
  noteType?: NoteType;
}

export interface NoteMergeResult {
  /**
   * 'clean' — both sides' edits live in `content`/`name`; push it.
   * 'conflict' — the sides overlap (or a guard tripped); the caller keeps
   * mine canonical and parks theirs for review.
   * 'unmergeable' — the note's kind never merges (opaque formats); the
   * caller treats it exactly like a conflict.
   */
  status: 'clean' | 'conflict' | 'unmergeable';
  content: string;
  name: string | null;
}

/** The name's own three-way merge — null when the names collide. */
function mergeName(
  base: string | null,
  mine: string | null,
  theirs: string | null,
): { name: string | null; conflict: boolean } {
  if (mine === theirs) {
    return { name: mine, conflict: false };
  }
  if (base === mine) {
    return { name: theirs, conflict: false };
  }
  if (base === theirs) {
    return { name: mine, conflict: false };
  }
  return { name: mine, conflict: true };
}

/**
 * Merges theirs and mine over base. All three versions must come from the
 * same note id; the caller (cloud/sync.ts) guarantees that.
 */
export function mergeNoteVersions(
  base: NoteVersion,
  mine: NoteVersion,
  theirs: NoteVersion,
): NoteMergeResult {
  const unmergeable = (reason: 'kind' | 'size'): NoteMergeResult => ({
    status: reason === 'kind' ? 'unmergeable' : 'conflict',
    content: mine.content,
    name: mine.name,
  });

  // Only prose merges: html (tags stay atomic) and text (markdown source,
  // plain words). JSON task lists, drawing scenes and unknown-to-this-
  // build kinds are formats a text diff would mangle — they review.
  const baseKind = contentKindFor(base.noteType);
  const mineKind = contentKindFor(mine.noteType);
  const theirKind = contentKindFor(theirs.noteType);
  if (
    (baseKind !== 'html' && baseKind !== 'text') ||
    baseKind !== mineKind ||
    baseKind !== theirKind // includes a KIND CHANGE between versions —
  ) {
    // no shared format to merge over.
    return unmergeable('kind');
  }

  if (
    base.content.length > MAX_MERGE_BYTES ||
    mine.content.length > MAX_MERGE_BYTES ||
    theirs.content.length > MAX_MERGE_BYTES
  ) {
    return unmergeable('size');
  }

  const nameMerge = mergeName(base.name, mine.name, theirs.name);

  // Identical content on both sides: the merge is the name question alone.
  if (mine.content === theirs.content) {
    return nameMerge.conflict
      ? { status: 'conflict', content: mine.content, name: mine.name }
      : { status: 'clean', content: mine.content, name: nameMerge.name };
  }

  const tokenize = baseKind === 'html' ? tokenizeHtml : tokenizeText;
  const baseTokens = tokenize(base.content);
  const mineTokens = tokenize(mine.content);
  const theirTokens = tokenize(theirs.content);

  const result = mergeThreeWay(baseTokens, mineTokens, theirTokens);

  if (result.conflict) {
    return { status: 'conflict', content: mine.content, name: mine.name };
  }

  const mergedContent = detokenize(result.merged);
  if (baseKind === 'html' && !tagsBalance(result.merged)) {
    // A hunk boundary would have split a tag pair — review, not soup.
    return { status: 'conflict', content: mine.content, name: mine.name };
  }

  return nameMerge.conflict
    ? { status: 'conflict', content: mergedContent, name: mine.name }
    : { status: 'clean', content: mergedContent, name: nameMerge.name };
}
