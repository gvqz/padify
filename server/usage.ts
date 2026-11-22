/**
 * The usage report — GET /api/usage.
 *
 * The quotas existed before the app could see them: an account could fill
 * its 25 MB of notes or its 200 MB of attachments and the only symptom was
 * a 413 on the next push. This handler is the visible half of the same
 * numbers (the brainstorm's "usage & quota surface" item): one grouped
 * read over the owner's notes, one over the attachments table, folded
 * into the shared UsageReport shape (shared/wire.ts).
 *
 * Bytes come from length(cast(content as blob)) — the ONE measurement the
 * quota check counts (UTF-8 bytes, not characters; see the quota check in
 * server/notes.ts). The trash folds into its own slice, not a type's:
 * trashed rows keep their content on purpose, so they occupy exactly the
 * storage they look like, and the account page names that instead of
 * hiding it inside "Markdown note". Unknown type ids travel verbatim —
 * a type a newer build created is still bytes this account owns.
 */

import type { Db } from './db';
import { json } from './http';
import type { SessionUser } from './auth';
import { MAX_ATTACHMENT_COUNT, MAX_TOTAL_ATTACHMENT_BYTES, NOTE_BYTES_QUOTA } from './quota';
import type { UsageReport, UsageTypeSlice } from '../shared/wire';

export async function handleUsageGet(
  db: Db,
  request: Request,
  user: SessionUser
): Promise<Response> {
  const noteRows = await db.all(
    `select note_type, deleted, count(*) as n,
            coalesce(sum(length(cast(content as blob))), 0) as bytes
     from notes where user_id = ? group by note_type, deleted`,
    [user.id]
  );
  const attachmentRows = await db.all(
    'select count(*) as n, coalesce(sum(size), 0) as bytes from attachments where user_id = ?',
    [user.id]
  );

  const byType = new Map<string, UsageTypeSlice>();
  let trashBytes = 0;
  let trashCount = 0;
  let liveCount = 0;
  let noteBytes = 0;
  for (const row of noteRows) {
    const bytes = Number(row.bytes) || 0;
    const n = Number(row.n) || 0;
    noteBytes += bytes;
    if (Number(row.deleted) === 1) {
      trashBytes += bytes;
      trashCount += n;
      continue;
    }
    liveCount += n;
    const type = row.note_type == null ? 'standard' : String(row.note_type);
    const slice = byType.get(type) ?? { type, bytes: 0, count: 0 };
    slice.bytes += bytes;
    slice.count += n;
    byType.set(type, slice);
  }

  const attachments = attachmentRows[0];
  const report: UsageReport = {
    limits: {
      notes_bytes: NOTE_BYTES_QUOTA,
      attachments_bytes: MAX_TOTAL_ATTACHMENT_BYTES,
      attachments_count: MAX_ATTACHMENT_COUNT
    },
    notes: {
      bytes: noteBytes,
      live_count: liveCount,
      trash: { bytes: trashBytes, count: trashCount },
      by_type: Array.from(byType.values())
    },
    attachments: {
      bytes: Number(attachments?.bytes) || 0,
      count: Number(attachments?.n) || 0
    }
  };
  return json(request, report);
}
