/**
 * What the price chart says, and what its colours mean.
 *
 * The curve plots one thing, the chance of finishing at or above each price, and the axis title says exactly that. A marker's
 * pill therefore does not repeat it: it names the marker the way the page and the ticket do (First level, Target, Lower level,
 * Higher level) and gives the level. It once carried a percent as well ("At or above $62,500 · 84%"), which on a Range sat
 * beside a headline chance of 47% and read as a second, different answer; the ticket has the chance of winning.
 */

/** The four bets the chart draws, as its markers see them: a rising or falling Stake Back, a Range and a Breakout. */
export type ChartKind = 'up' | 'down' | 'range' | 'breakout';

/** A pill: the marker's name and its level, "Lower level $62,500". */
export const levelLabel = (name: string, price: string): string => `${name} ${price}`;

/** The same for a screen reader, in lower case after the handle's own name: "at or above $63,500, 37 percent chance". */
export const levelSpoken = (price: string, chance: number | null): string =>
  `at or above ${price}${chance === null || !Number.isFinite(chance) ? '' : `, ${Math.round(chance * 100)} percent chance`}`;

/** The vertical axis's title: what the height of the curve is. The short one is for a chart too short to hold the long one. */
export const AXIS_TITLE = 'Chance of finishing at or above';
export const AXIS_TITLE_SHORT = 'Chance at or above';

/** What a stretch of the chart is for the bet: where it wins, where it loses, or neither (a Stake Back's stake-back stretch). */
export type ZoneKind = 'win' | 'lose' | null;

/**
 * The three stretches the two markers cut the chart into, left to right, and what each is. Green is a win and red a loss, the
 * colours the ticket's bar and the payoff table use; amber belongs to the markers and their pills alone, so a stretch is never
 * amber (which is what a person is taught to read as "stake back").
 *
 *   up        wins at or above the target (right), loses between the two, gets the stake back below the first level (left)
 *   down      wins below the target (left), loses between the two, gets the stake back at or above the first level (right)
 *   range     wins between the two, loses outside them
 *   breakout  wins outside the two, loses between them
 */
export function chartZones(kind: ChartKind): { below: ZoneKind; between: ZoneKind; above: ZoneKind } {
  switch (kind) {
    case 'up':
      return { below: null, between: 'lose', above: 'win' };
    case 'down':
      return { below: 'win', between: 'lose', above: null };
    case 'range':
      return { below: 'lose', between: 'win', above: 'lose' };
    default:
      return { below: 'win', between: 'lose', above: 'win' };
  }
}
