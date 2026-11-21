/**
 * The per-user storage quotas — one home, so the ceilings the small
 * host survives by are a decision, not an accident scattered through
 * handlers.
 *
 * THE CHECKS ARE ADVISORY UNDER RACE, ON PURPOSE. Every quota read and
 * write is a separate round-trip (two racing pushes can each pass the
 * sum check before either's bytes land), so the caps can be overshot
 * by the width of one request's race window. The overshoot is bounded
 * and accepted: a racer can only add what its own body carries — the
 * note quota by the 2 MB request cap, the attachment quota by the 5 MB
 * per-file cap — so a burst of concurrent writers overshoots by
 * (racers × per-request ceiling), never unboundedly. Enforcing the cap
 * transactionally would mean serializing every write behind one user
 * lock (or a BEGIN IMMEDIATE transaction per request, which the Turso
 * HTTP path cannot do); a bounded, self-healing overshoot — the next
 * write past the cap is refused — is the cheaper honest answer.
 */

/** Total UTF-8 bytes of note content one account may hold (server/notes). */
export const NOTE_BYTES_QUOTA = 25 * 1024 * 1024;

/** Total attachment bytes one account may hold (server/attachments). */
export const MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** Attachment files one account may hold (server/attachments). */
export const MAX_ATTACHMENT_COUNT = 500;
