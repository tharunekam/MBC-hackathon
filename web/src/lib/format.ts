export const usd = (n: number, digits = 2) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** Signed dollars for results: +$12.50 / −$10.00 / $0.00 */
export const usdSigned = (n: number) => (n > 0.004 ? `+${usd(n)}` : n < -0.004 ? usd(n) : usd(0));

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

/** A price per $1 of payout, shown in cents: 0.554 -> 55¢ */
export const cents = (x: number) => `${Math.round(x * 100)}¢`;

/** A strike or price level from its number: $62,500 or $2.45. Never from an exchange's label text. */
export const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 4 : 2 })}`;

export const trunc = (s: string, head = 6, tail = 4) => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);

export function timeLeft(expiry: string | null, now = Date.now()): string | null {
  if (!expiry) return null;
  const ms = new Date(expiry).getTime() - now;
  if (ms <= 0) return 'Closed';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Closes in under a minute';
  if (m < 60) return `Closes in ${m} min`;
  const h = Math.floor(m / 60);
  return `Closes in ${h} h ${m % 60} min`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
