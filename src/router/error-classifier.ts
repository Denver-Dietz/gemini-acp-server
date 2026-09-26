export type FailureKind = 'limit' | 'capacity' | 'auth' | 'stall' | 'other';

export interface Failure {
  kind: FailureKind;
  message: string;
  /** Milliseconds until the provider says the model works again, when the message states it. */
  resetMs?: number;
  code?: number;
  status?: string;
}

export interface AgyErrorLine {
  short_error?: string;
  status?: string;
  error_code?: number;
  retryable?: boolean;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * Extracts "how long until this works again" from provider error text. Understands
 * "Resets in 98h29m44s", "try again in 4 hours", "in a minute", and "resets at <ISO time>".
 */
export function parseResetMs(text: string, now: number = Date.now()): number | undefined {
  const compact = /resets?\s+in\s+((?:\d+(?:\.\d+)?\s*[dhms]\s*)+)/i.exec(text);
  if (compact?.[1]) {
    let total = 0;
    for (const m of compact[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
      total += Number(m[1]) * (UNIT_MS[(m[2] ?? '').toLowerCase()] ?? 0);
    }
    if (total > 0) return total;
  }

  const spelled = /(?:try again|retry|available|resets?|wait)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)/i.exec(
    text,
  );
  if (spelled?.[1] && spelled[2]) {
    return Number(spelled[1]) * (UNIT_MS[spelled[2].toLowerCase()] ?? 0);
  }

  if (/(?:try again|retry)\s+in\s+a\s+minute/i.test(text)) return 60_000;

  const iso = /resets?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso?.[1]) {
    const at = Date.parse(iso[1]);
    if (!Number.isNaN(at) && at > now) return at - now;
  }
  return undefined;
}

/** Finds the structured `AGY_ERROR: {...}` line agy prints to stderr on failure. */
export function parseAgyErrorLine(stderr: string): AgyErrorLine | undefined {
  const line = stderr.split('\n').find((l) => l.startsWith('AGY_ERROR:'));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice('AGY_ERROR:'.length).trim()) as AgyErrorLine;
  } catch {
    return undefined;
  }
}

const LIMIT_TEXT = /quota|rate.?limit|resource_exhausted|exhausted|usage limit|too many requests|billing/i;
const CAPACITY_TEXT = /no capacity|high traffic|overloaded|service unavailable|temporarily unavailable|try again in a minute/i;
const AUTH_TEXT = /not logged in|unauthenticated|unauthorized|invalid (api )?key|token (expired|invalid)|permission denied/i;

/**
 * Turns whatever agy reported (result-event error text, stderr, exit code) into a routing decision.
 * Real samples: "RESOURCE_EXHAUSTED (code 429): Individual quota reached ... Resets in 98h29m44s" and
 * "UNAVAILABLE (code 503): No capacity available for model ...".
 */
export function classifyFailure(input: {
  error?: string;
  stderr?: string;
  stalled?: boolean;
  now?: number;
}): Failure {
  const structured = input.stderr ? parseAgyErrorLine(input.stderr) : undefined;
  const message = (input.error || structured?.short_error || input.stderr || 'unknown error').trim();
  const code = structured?.error_code ?? Number(/\(code (\d{3})\)/.exec(message)?.[1] ?? NaN);
  const status = structured?.status ?? /\b([A-Z_]{6,})\b\s*\(code/.exec(message)?.[1];
  const resetMs = parseResetMs(`${message}\n${input.stderr ?? ''}`, input.now);
  const base = { message, ...(Number.isNaN(code) ? {} : { code }), ...(status ? { status } : {}), ...(resetMs ? { resetMs } : {}) };

  if (input.stalled) return { ...base, kind: 'stall' };
  if (code === 429 || status === 'RESOURCE_EXHAUSTED') return { ...base, kind: 'limit' };
  if (code === 401 || code === 403 || status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') {
    return { ...base, kind: 'auth' };
  }
  if (code === 503 || code === 502 || code === 504 || status === 'UNAVAILABLE') return { ...base, kind: 'capacity' };

  if (AUTH_TEXT.test(message)) return { ...base, kind: 'auth' };
  if (LIMIT_TEXT.test(message)) return { ...base, kind: 'limit' };
  if (CAPACITY_TEXT.test(message)) return { ...base, kind: 'capacity' };
  return { ...base, kind: 'other' };
}
