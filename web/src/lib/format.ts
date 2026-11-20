/** The true minus sign, used for every negative figure on screen. */
const MINUS = '−';

/** A number that can be shown: NaN and Infinity never reach the screen. */
const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n);

/** `n` rounded to `digits` places, with -0 and dust that rounds to zero turned into a plain 0. */
const rounded = (n: number, digits: number): number => {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return r === 0 ? 0 : r;
};

/** A figure's sign: the minus only when what is shown is below zero, never "−$0.00". */
const signOf = (shown: number): string => (shown < 0 ? MINUS : '');

export const usd = (n: number, digits = 2) => {
  if (!finite(n)) return '–';
  const v = rounded(n, digits);
  return `${signOf(v)}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

/** Signed dollars for results: +$12.50 / −$10.00 / $0.00 */
export const usdSigned = (n: number) => {
  if (!finite(n)) return '–';
  const v = rounded(n, 2);
  return v > 0 ? `+${usd(v)}` : usd(v);
};

export const pct = (x: number, digits = 0) => {
  if (!finite(x)) return '–';
  const v = rounded(x * 100, digits);
  return `${signOf(v)}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
};

/** A price per $1 of payout, shown in cents: 0.554 -> 55¢ */
export const cents = (x: number) => {
  if (!finite(x)) return '–';
  const v = rounded(x * 100, 0);
  return `${signOf(v)}${Math.abs(v)}¢`;
};

/**
 * A call's edge, per $1: "+0.31", "−0.31", "0.00". Rounded before the sign is chosen, so a value that shows as zero has
 * none. A dash for anything that is not a number.
 */
export const edgeText = (e: number): string => {
  if (!finite(e)) return '–';
  const v = rounded(e, 2);
  return `${v > 0 ? '+' : signOf(v)}${Math.abs(v).toFixed(2)}`;
};

/**
 * A strike or price level from its number, never from an exchange's label text. A whole number of dollars stays whole
 * ($63,500); a price with cents always shows both of them ($141.60, not $141.6, which reads as a typo); and under $10, where
 * ladders step by fractions of a cent, up to four decimals are kept ($0.905).
 */
export function money(n: number): string {
  if (!finite(n)) return '–';
  const small = Math.abs(n) < 10;
  // Rounded first, so 63,500.000001 (a price worked out between two rungs) still counts as whole.
  const shown = rounded(n, small ? 4 : 2);
  const whole = Number.isInteger(shown);
  const text = Math.abs(shown).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : small ? 4 : 2 });
  return `${signOf(shown)}$${text}`;
}

export const trunc = (s: string, head = 6, tail = 4) => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);

/** "Nov 20, 5:13 AM": a moment in the viewer's own time, in the one format the app uses for a date with a time. Empty when it cannot be read. */
export function dateTime(when: string | number | Date | null | undefined): string {
  if (when === null || when === undefined) return '';
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "Closes in 25 min", "Closes in 2 h 10 min", "Closes in 1 d 6 h". A whole unit is not followed by "0 min". Null when there is no time to count to. */
export function timeLeft(expiry: string | null, now = Date.now()): string | null {
  if (!expiry) return null;
  const ms = new Date(expiry).getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return 'Closed';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Closes in under a minute';
  if (m < 60) return `Closes in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Closes in ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `Closes in ${d} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

/** "just now", "5 min ago", "7 h ago", "3 d ago". Empty when the time cannot be read. */
export function ago(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
