/**
 * A revealed call as a picture someone can post: 1200 by 630, the size link previews use.
 *
 * `shareCardSvg` is plain text in, an SVG document out, so it can be tested without a browser. `savePng` draws that
 * SVG on a canvas and hands the person a PNG. A picture cannot load the app's fonts, so it names the system sans-serif
 * stack; the name is set the way the header sets it (wide, spaced, capitals) so the two read as one brand.
 */

export interface ShareCard {
  /** The pseudonymous handle. Never an account. */
  handle: string;
  won: boolean;
  /** The proof page's own sentence: "Given BTC at $62,500 or above, will it reach $63,500?" */
  question: string;
  /** Already formatted, as the proof page shows them: "41¢", "44¢", "+0.59". */
  fair: string;
  paid: string;
  edge: string;
  edgeGood: boolean;
  /** "Nov 18, 2026" */
  when: string;
  /** True when both records of the call are on Solana. Only then may the picture say so. */
  onSolana: boolean;
  /** Where to check it, without the scheme: "given.example.com/verify/5P8xNp…". Printed whole: a cut address opens nothing. */
  link: string;
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/**
 * The app's own colours as literals, because a picture has no stylesheet. They are the dark theme's values in
 * styles/tokens.css: change one there and change it here.
 */
export const CARD_COLORS = {
  page: '#0a0a0b',
  card: '#121213',
  ink: '#fafafa',
  muted: '#8b8b8d',
  line: '#2a2a2b',
  accent: '#ffd166',
  good: '#4ade97',
  bad: '#ff7a6b',
} as const;

const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

/** Breaks text into lines of at most `max` characters at spaces. A single word longer than that is kept whole. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Splits an address with no spaces into lines of at most `max` characters, so that all of it is printed. It is cut where
 * the address allows (after a slash) when that is near the end of the line, and anywhere otherwise: a signature is one
 * long word.
 */
export function splitLink(link: string, max = 74): string[] {
  const lines: string[] = [];
  let rest = link;
  while (rest.length > max) {
    const slash = rest.lastIndexOf('/', max);
    const at = slash > max - 12 ? slash + 1 : max;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) lines.push(rest);
  return lines;
}

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const FIGURES = 'font-variant-numeric: tabular-nums';

export function shareCardSvg(c: ShareCard): string {
  const k = CARD_COLORS;
  const verdictColor = c.won ? k.good : k.bad;
  // Two lines at most, which every real market's question fits. A longer one ends in an ellipsis rather than pushing
  // the numbers into the footer.
  let lines = wrap(c.question, 46);
  if (lines.length > 2) lines = [lines[0]!, `${lines[1]!.slice(0, 43)}…`];
  // The question is centred in the band between the result and the numbers, whatever its length; the numbers sit at a
  // fixed height, so two cards of different questions line up.
  const qTop = lines.length === 1 ? 342 : 318;
  const numsTop = 420;
  const cell = (x: number, label: string, value: string, color: string = k.ink) =>
    `<text x="${x}" y="${numsTop}" font-family="${SANS}" font-size="20" fill="${k.muted}">${esc(label)}</text>` +
    `<text x="${x}" y="${numsTop + 44}" font-family="${SANS}" font-size="40" font-weight="500" style="${FIGURES}" fill="${color}">${esc(value)}</text>`;
  const linkLines = splitLink(c.link);
  // Only what the proof page checks: the call was sealed before it was revealed. The result is the exchange's, not Solana's.
  // A call that is not on Solana has no record to check, so the picture claims no seal and does not tell anyone to check.
  const checkLine = c.onSolana ? 'Sealed on Solana before it was revealed. Check it yourself:' : 'Recorded by Stakeback, not on Solana:';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${k.page}"/>`,
    `<rect x="40.5" y="40.5" width="1119" height="549" rx="12" fill="${k.card}" stroke="${k.line}"/>`,
    // The name, set as the header sets it: wide, spaced, capitals.
    `<text x="88" y="106" font-family="${SANS}" font-size="22" font-weight="500" letter-spacing="5.3" fill="${k.ink}">STAKEBACK</text>`,
    `<text x="1112" y="106" text-anchor="end" font-family="${SANS}" font-size="20" fill="${k.muted}">${c.onSolana ? 'Recorded on Solana · ' : ''}${esc(c.when)}</text>`,
    // who and what happened
    `<text x="88" y="170" font-family="${SANS}" font-size="20" font-weight="500" letter-spacing="1.6" fill="${k.muted}">${esc(c.handle.toUpperCase())}</text>`,
    `<text x="86" y="250" font-family="${SANS}" font-size="72" font-weight="500" letter-spacing="-1.4" fill="${verdictColor}">${c.won ? 'Won' : 'Lost'}</text>`,
    ...lines.map((l, i) => `<text x="88" y="${qTop + i * 48}" font-family="${SANS}" font-size="38" fill="${k.ink}">${esc(l)}</text>`),
    cell(88, 'Fair price per $1', c.fair),
    cell(488, 'You paid per $1', c.paid),
    cell(888, 'Edge per $1', c.edge, c.edgeGood ? k.good : k.bad),
    // how to check it
    `<line x1="88" y1="478.5" x2="1112" y2="478.5" stroke="${k.line}"/>`,
    `<text x="88" y="512" font-family="${SANS}" font-size="22" fill="${k.muted}">${checkLine}</text>`,
    ...linkLines.map((l, i) => `<text x="88" y="${542 + i * 26}" font-family="${MONO}" font-size="20" fill="${k.accent}">${esc(l)}</text>`),
    `</svg>`,
  ].join('');
}

/** Draws the card and saves it as a PNG, at twice the size so it stays sharp. Browser only. */
export async function savePng(svg: string, filename: string): Promise<void> {
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((ok, bad) => {
      image.onload = () => ok();
      image.onerror = () => bad(new Error('The picture could not be drawn.'));
      image.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH * 2;
    canvas.height = CARD_HEIGHT * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The picture could not be drawn.');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error('The picture could not be saved.'))), 'image/png'));
    const href = URL.createObjectURL(png);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } finally {
    URL.revokeObjectURL(source);
  }
}
