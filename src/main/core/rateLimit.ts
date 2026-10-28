export interface RateLimitInfo {
  limited: boolean;
  /** Moment odnowienia limitu, jeśli udało się go odczytać. */
  resetAt?: Date;
}

const LIMIT_WORDS =
  /(usage limit|rate limit|limit reached|hit your limit|limit will reset|out of (?:extra )?usage)/i;

/** Format używany przez Claude Code: „Claude AI usage limit reached|1760000000”. */
const EPOCH_FORM = /limit reached\|(\d{9,13})/i;

/** „resets 3pm”, „resets at 3:30 PM”, „resets at 15:30”. */
const CLOCK_FORM = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

function nextOccurrence(hour: number, minute: number, now: Date): Date {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

export function detectRateLimit(text: string, now = new Date()): RateLimitInfo {
  const epoch = EPOCH_FORM.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return { limited: true, resetAt: new Date(n < 1e12 ? n * 1000 : n) };
  }
  if (!LIMIT_WORDS.test(text)) return { limited: false };

  const clock = CLOCK_FORM.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    const valid = ampm ? hour >= 1 && hour <= 12 : hour <= 23;
    if (valid && minute <= 59) {
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return { limited: true, resetAt: nextOccurrence(hour, minute, now) };
    }
  }
  return { limited: true };
}

/** Gdy nie da się odczytać godziny, zakładamy typowe okno limitu (5 h). */
export const FALLBACK_RESET_MS = 5 * 60 * 60 * 1000;
