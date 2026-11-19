/**
 * A revealed call as a picture someone can post: 1200 by 630, the size link previews use.
 *
 * `shareCardSvg` is plain text in, an SVG document out, so it can be tested without a browser. `savePng` draws that
 * SVG on a canvas and hands the person a PNG. Fonts are the device's own (a picture cannot load ours), which is why the
 * card names generic families.
 */

export interface ShareCard {
  /** The pseudonymous handle. Never an account. */
  handle: string;
  won: boolean;
  /** "Given BTC at $62,500 or above, will it reach $63,500?" */
  question: string;
  /** Already formatted, as the proof page shows them: "41¢", "44¢", "+0.59". */
  fair: string;
  paid: string;
  edge: string;
  edgeGood: boolean;
  /** "Nov 18, 2026" */
  when: string;
  /** "Solana devnet" or "Test chain": the card says what it is. */
  network: string;
  /** Where to check it, without the scheme: "given.example.com/verify/5P8xNp…" */
  link: string;
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

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

/** Shortens the middle of a long link so it fits on one line: the host and the start of the signature stay readable. */
export function fitLink(link: string, max = 56): string {
  return link.length <= max ? link : `${link.slice(0, max - 1)}…`;
}

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, Consolas, monospace";

export function shareCardSvg(c: ShareCard): string {
  const verdictColor = c.won ? '#1e6c43' : '#a83a25';
  // Two lines at most, which every real ladder's question fits. A longer one ends in an ellipsis rather than pushing
  // the numbers into the footer.
  let lines = wrap(c.question, 44);
  if (lines.length > 2) lines = [lines[0]!, `${lines[1]!.slice(0, 41)}…`];
  const qTop = 318;
  const numsTop = qTop + (lines.length - 1) * 56 + 86;
  const cell = (x: number, label: string, value: string, color = '#17150f') =>
    `<text x="${x}" y="${numsTop}" font-family="${SANS}" font-size="20" fill="#6b6558">${esc(label)}</text>` +
    `<text x="${x}" y="${numsTop + 44}" font-family="${MONO}" font-size="38" font-weight="600" fill="${color}">${esc(value)}</text>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#f5f1e8"/>`,
    `<rect x="40" y="40" width="1120" height="550" rx="28" fill="#fffdf7" stroke="#17150f" stroke-opacity="0.12"/>`,
    // brand
    `<rect x="88" y="84" width="34" height="34" rx="9" fill="#17150f"/>`,
    `<path d="M97 108 a8 8 0 0 1 16 0" fill="none" stroke="#f0ac2b" stroke-width="3.5" stroke-linecap="round"/>`,
    `<text x="136" y="111" font-family="${SERIF}" font-size="30" fill="#17150f">Given</text>`,
    `<text x="1112" y="109" text-anchor="end" font-family="${SANS}" font-size="20" fill="#6b6558">${esc(c.network)} · ${esc(c.when)}</text>`,
    // who and what happened
    `<text x="88" y="178" font-family="${SANS}" font-size="20" font-weight="600" letter-spacing="2.4" fill="#6b6558">${esc(c.handle.toUpperCase())}</text>`,
    `<text x="86" y="258" font-family="${SERIF}" font-size="78" fill="${verdictColor}">${c.won ? 'Called it' : 'Missed'}</text>`,
    ...lines.map((l, i) => `<text x="88" y="${qTop + i * 56}" font-family="${SERIF}" font-size="44" fill="#17150f">${esc(l)}</text>`),
    cell(88, 'Fair price at the time', c.fair),
    cell(368, 'Paid', c.paid),
    cell(568, 'Result', c.won ? 'Target reached' : 'Fell short', verdictColor),
    cell(988, 'Edge', c.edge, c.edgeGood ? '#1e6c43' : '#a83a25'),
    // how to check it
    `<line x1="88" y1="528" x2="1112" y2="528" stroke="#17150f" stroke-opacity="0.12"/>`,
    // The date sits at the top with the network: down here a long link would run into it.
    `<text x="88" y="562" font-family="${SANS}" font-size="19" fill="#6b6558">Committed on Solana before the result. Check it: ${esc(fitLink(c.link))}</text>`,
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
