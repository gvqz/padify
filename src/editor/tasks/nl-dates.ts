/**
 * Reminders — the quick-add's natural language.
 *
 * The one input that makes dates easy: "call the dentist tomorrow 9am",
 * "ship the package friday", "pay rent nov 1", "standup at 9:30" — the
 * when-words are parsed out, the rest is the title. The grammar is
 * deliberately CONSERVATIVE: only a trailing cluster of when-words is
 * ever consumed ("buy monday newspaper" keeps its Monday — the date
 * word is not at the end), so a title can never lose words it meant.
 *
 * Pure: (input, now) → { title, dueDate, reminderAt }. No DOM, no wall
 * clock — `now` is always a parameter, so the tests pin it. Every rule
 * is documented where it is decided; the test file is the spec.
 */

import { dateAndTimeToIso, nextWeekendEvening, startOfDay } from './dates';

/** What the quick-add's parse produced. Empty dueDate/reminderAt = none. */
export interface ParsedQuickAdd {
  /** The input with the when-cluster removed, cleaned. */
  title: string;
  dueDate: string;
  reminderAt: string;
  /** The raw when-words that were consumed, in the order found. */
  matched: string[];
}

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  weds: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Word-numbers the "in …" pattern accepts besides digits. */
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };

const MONTH_ALT = Object.keys(MONTHS).join('|');
const WEEKDAY_ALT = Object.keys(WEEKDAYS).join('|');
const NUMBER_ALT = Object.keys(NUMBER_WORDS).join('|');

// ---------------------------------------------------------------------------
// Time math
// ---------------------------------------------------------------------------

/**
 * Hour/minute (+ optional meridiem) → minutes since midnight, or null
 * when the numbers say no. The documented ambiguity rule: a clock time
 * without a marker reads as the AFTERNOON (quick-adds are working-hours
 * reminders; Todoist does the same) — "at 9" is 21:00, "9:30" is 21:30.
 * 24h stays 24h: 19:00 is 19:00, and a leading zero pins the morning —
 * 09:30 is 09:30.
 */
function minutesOf(
  hour: number,
  minute: number,
  meridiem: string | undefined,
  raw: string,
): number | null {
  if (hour > 23 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const base = hour % 12;
    return (meridiem.startsWith('p') ? base + 12 : base) * 60 + minute;
  }
  if (hour >= 13) return hour * 60 + minute;
  if (hour === 12) return 12 * 60 + minute;
  if (hour === 0 || /^0\d$/.test(raw)) return hour * 60 + minute;
  return (hour + 12) * 60 + minute;
}

// ---------------------------------------------------------------------------
// The tail patterns — tried in order against the END of the working string
// ---------------------------------------------------------------------------

interface TailMatch {
  kind: 'date' | 'time' | 'daypart';
  /** The consumed suffix. */
  text: string;
  /** True when a preposition pins the phrase ("at night") — a bare
   * trailing daypart with nothing else is NOT a date. */
  prefixed?: boolean;
  /** The facts the phrase contributes, resolved against the context. */
  resolve: (ctx: ResolveCtx) => void;
}

interface ResolveCtx {
  now: Date;
  /** The resolved day once a date phrase has spoken (midnight, unless
   * the phrase itself carries a time — the weekend preset's 9:00). */
  date: Date | null;
  /** Minutes since midnight from an explicit clock time. */
  timeMinutes: number | null;
  /** Minutes since midnight implied by a daypart word. */
  daypart: number | null;
  /** Minutes a date phrase itself carries (weekend = Sat 9:00). */
  presetMinutes: number | null;
  /** "tonight" — implies 20:00 when nothing more specific shows up. */
  tonight: boolean;
}

const timeMatch = (text: string, minutes: number): TailMatch => ({
  kind: 'time',
  text,
  resolve: (ctx) => {
    ctx.timeMinutes = minutes;
  },
});

const dateMatch = (text: string, date: Date, presetMinutes: number | null = null): TailMatch => ({
  kind: 'date',
  text,
  resolve: (ctx) => {
    ctx.date = date;
    ctx.presetMinutes = presetMinutes;
  },
});

const H = '(\\d{1,2})(?::(\\d{2}))?';
const MER = '(?:\\s*(a\\.?m\\.?|p\\.?m\\.?))';

/** The tail patterns, top to bottom; the first hit wins. Each matches a
 * SUFFIX of the working string — the loop peels the cluster from the
 * end, one phrase per pass. */
const TAIL_PATTERNS: Array<(working: string, now: Date) => TailMatch | null> = [
  // 1. marked clock times: 9am · 9:30 pm · 21:15 · 09:30
  (working) => {
    const marked = working.match(new RegExp(`\\b${H}${MER}$`, 'i'));
    if (marked) {
      const minutes = minutesOf(Number(marked[1]), Number(marked[2] ?? 0), marked[3], marked[1]);
      return minutes === null ? null : timeMatch(marked[0], minutes);
    }
    const colon = working.match(/\b(\d{1,2}):(\d{2})[.,;!?]?$/);
    if (colon) {
      const minutes = minutesOf(Number(colon[1]), Number(colon[2]), undefined, colon[1]);
      return minutes === null ? null : timeMatch(colon[0], minutes);
    }
    return null;
  },
  // 2. at 9 · @ 9:30 · at 9 pm
  (working) => {
    const at = working.match(new RegExp(`\\b(?:at|@)\\s+${H}${MER}?[.,;!?]?$`, 'i'));
    if (!at) return null;
    const minutes = minutesOf(Number(at[1]), Number(at[2] ?? 0), at[3], at[1]);
    return minutes === null ? null : timeMatch(at[0], minutes);
  },
  // 3. noon / midnight
  (working) => {
    const word = working.match(/\b(?:at\s+)?(noon|midnight)[.,;!?]?$/i);
    if (!word) return null;
    return timeMatch(word[0], word[1].toLowerCase() === 'noon' ? 12 * 60 : 0);
  },
  // 4. oct 30 · october 30 2027
  (working, now) => {
    const m = working.match(
      new RegExp(
        `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?[.,;!?]?$`,
        'i',
      ),
    );
    if (!m) return null;
    const date = monthDay(
      MONTHS[m[1].toLowerCase()],
      Number(m[2]),
      m[3] ? Number(m[3]) : null,
      now,
    );
    return date ? dateMatch(m[0], date) : null;
  },
  // 5. 30 oct · 30th of october
  (working, now) => {
    const m = working.match(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\.?(?:,?\\s*(\\d{4}))?[.,;!?]?$`,
        'i',
      ),
    );
    if (!m) return null;
    const date = monthDay(
      MONTHS[m[2].toLowerCase()],
      Number(m[1]),
      m[3] ? Number(m[3]) : null,
      now,
    );
    return date ? dateMatch(m[0], date) : null;
  },
  // 6. monday · next friday · on sat
  (working, now) => {
    const m = working.match(
      new RegExp(`\\b(?:(next|this|on|coming)\\s+)?(${WEEKDAY_ALT})\\.?[.,;!?]?$`, 'i'),
    );
    if (!m || !(m[2].toLowerCase() in WEEKDAYS)) return null;
    const delta = weekdayOffset(m[2].toLowerCase(), (m[1] ?? '').toLowerCase() === 'next', now);
    return dateMatch(m[0], dayFrom(now, delta));
  },
  // 7. today · tonight · tomorrow (+ the typos people actually type)
  (working, now) => {
    const m = working.match(
      /\b(?:on\s+)?(today|tonight|tomorrow|tommorow|tommorrow|tmr|tmrw|tmw)[.,;!?]?$/i,
    );
    if (!m) return null;
    const word = m[1].toLowerCase();
    if (word === 'today' || word === 'tonight') {
      return {
        kind: 'date',
        text: m[0],
        resolve: (ctx) => {
          ctx.date = startOfDay(now);
          if (word === 'tonight') ctx.tonight = true;
        },
      };
    }
    return dateMatch(m[0], dayFrom(now, 1));
  },
  // 8. this weekend · weekend · next weekend — Saturday 9:00
  (working, now) => {
    const m = working.match(/\b(?:(this|next)\s+)?weekend[.,;!?]?$/i);
    return m ? dateMatch(m[0], nextWeekendEvening(now), 9 * 60) : null;
  },
  // 9. next week
  (working, now) => {
    const m = working.match(/\bnext\s+week[.,;!?]?$/i);
    return m ? dateMatch(m[0], dayFrom(now, 7)) : null;
  },
  // 10. in 3 days · in a week · in two weeks
  (working, now) => {
    const m = working.match(
      new RegExp(`\\bin\\s+(\\d{1,3}|${NUMBER_ALT})\\s+(days?|weeks?)[.,;!?]?$`, 'i'),
    );
    if (!m) return null;
    const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    if (!n || n < 1) return null;
    return dateMatch(m[0], dayFrom(now, m[2].toLowerCase().startsWith('week') ? n * 7 : n));
  },
  // 11. (in the) (at | this | on) morning/afternoon/evening/night — LAST:
  //     it needs a date beside it or a preposition in front; the parse
  //     rejects a bare trailing daypart with nothing else.
  (working) => {
    const m = working.match(
      /\b(?:(at|this|on|in\s+the)\s+)?(morning|afternoon|evening|night)[.,;!?]?$/i,
    );
    if (!m) return null;
    const hours: Record<string, number> = { morning: 9, afternoon: 13, evening: 18, night: 20 };
    const prefixed = Boolean(m[1]);
    const minutes = hours[m[2].toLowerCase()] * 60;
    return {
      kind: 'daypart',
      text: m[0],
      prefixed,
      resolve: (ctx) => {
        ctx.daypart = minutes;
      },
    };
  },
];

/** A weekday phrase → its day offset from today (0 = today). "next X"
 * always skips the coming one — 8..14 days out, never today. */
function weekdayOffset(name: string, next: boolean, now: Date): number {
  const delta = ((WEEKDAYS[name] ?? 0) - now.getDay() + 7) % 7;
  return next ? delta + 7 : delta;
}

/** A month-day phrase → the Date (this year; next year once passed). */
function monthDay(month: number, day: number, year: number | null, now: Date): Date | null {
  if (day < 1 || day > 31) return null;
  const y = year ?? now.getFullYear();
  const date = new Date(y, month, day);
  if (year === null && startOfDay(date).getTime() < startOfDay(now).getTime()) {
    date.setFullYear(y + 1);
  }
  if (date.getMonth() !== month || date.getDate() !== day) return null; // feb 30
  return date;
}

function dayFrom(now: Date, days: number): Date {
  return new Date(startOfDay(now).getTime() + days * MS_PER_DAY);
}

/** Cuts a matched suffix off the working string and cleans the join
 * ("buy milk on monday" → "buy milk on" → "buy milk"). Trailing
 * prepositions are always junk once the when-word they led is gone. */
function stripTail(working: string, text: string): string {
  let head = working.slice(0, working.length - text.length).replace(/\s+$/, '');
  for (;;) {
    const stripped = head.replace(/\s+(?:on|at|in|next|this|coming|of|the)$/i, '');
    if (stripped === head) break;
    head = stripped.replace(/\s+$/, '');
  }
  return head;
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/**
 * Parses a quick-add line. Only a TRAILING when-cluster is consumed —
 * up to one date phrase and one time-ish phrase (either order), each at
 * the string's end:
 *
 *   "call the dentist tomorrow 9am"       → tomorrow 09:00
 *   "ship the package friday"             → friday
 *   "standup at 9:30"                     → today/tomorrow 21:30 (PM rule)
 *   "pay rent nov 1"                      → nov 1 (next year once passed)
 *   "remind me to call mom tomorrow at 9" → reminder tomorrow 21:00
 *   "buy monday newspaper"                → nothing — the when-word isn't trailing
 *
 * When the parse would leave an empty title ("tomorrow" alone), nothing
 * is consumed — the whole line stays the title, no date.
 */
export function parseQuickAdd(input: string, now: Date): ParsedQuickAdd {
  const original = input.trim();
  const none: ParsedQuickAdd = { title: original, dueDate: '', reminderAt: '', matched: [] };
  if (!original) return none;

  let working = original;
  let date: TailMatch | null = null;
  let timeish: TailMatch | null = null; // a clock time or a daypart
  const matched: string[] = [];

  for (let i = 0; i < 4 && !(date && timeish); i += 1) {
    const cleaned = working.replace(/[.,;!?]+\s*$/, '');
    if (!cleaned) break;
    let hit: TailMatch | null = null;
    for (const attempt of TAIL_PATTERNS) {
      const candidate = attempt(cleaned, now);
      if (candidate) {
        hit = candidate;
        break;
      }
    }
    if (!hit) break;
    // A second date phrase or a second time-ish stays in the title.
    if (hit.kind === 'date' && !date) date = hit;
    else if (hit.kind !== 'date' && !timeish) timeish = hit;
    else break;
    matched.push(hit.text);
    working = stripTail(cleaned, hit.text);
  }

  let title = working.replace(/\s{2,}/g, ' ').trim();
  if (matched.length === 0 || !title) return none;

  // The polite prefix goes when a when-cluster was consumed ("remind me
  // to call mom tomorrow" → "call mom").
  title = title.replace(/^remind\s+me\s+(?:to|about|that)?\s*/i, '').trim();

  // A bare daypart ("watch the game night") is not a date — it needs a
  // date phrase beside it or a preposition in front ("at night").
  const daypart = timeish?.kind === 'daypart' ? timeish : null;
  if (daypart && !date && !daypart.prefixed) return none;

  const ctx: ResolveCtx = {
    now,
    date: null,
    timeMinutes: null,
    daypart: null,
    presetMinutes: null,
    tonight: false,
  };
  for (const match of [date, timeish]) match?.resolve(ctx);

  // The time stack: an explicit clock time beats a daypart beats a
  // preset the date phrase carried beats tonight's implied 20:00.
  const minutes =
    ctx.timeMinutes ?? ctx.daypart ?? ctx.presetMinutes ?? (ctx.tonight ? 20 * 60 : null);

  // A time without a date lands today — or tomorrow when that time has
  // already passed. "tonight" keeps its 8pm even once 8pm has passed
  // (it is tonight's 8pm by definition).
  if (ctx.date === null && minutes !== null && !ctx.tonight) {
    const candidate = new Date(now);
    candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    ctx.date = startOfDay(candidate);
  }

  const fmt = (day: Date, mins: number | null): string => {
    const pad = (v: number): string => String(v).padStart(2, '0');
    const time = mins === null ? '' : `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    return dateAndTimeToIso(
      `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
      time,
    );
  };
  const day = ctx.date ?? startOfDay(now);
  const clockTime = ctx.timeMinutes;

  if (/\bremind\b/i.test(original) && clockTime !== null) {
    // "remind me to X tomorrow at 9" — the ping carries the time, the
    // task keeps the plain day.
    return {
      title,
      dueDate: date ? fmt(day, null) : '',
      reminderAt: fmt(day, clockTime),
      matched,
    };
  }
  return { title, dueDate: ctx.date ? fmt(day, minutes) : '', reminderAt: '', matched };
}
