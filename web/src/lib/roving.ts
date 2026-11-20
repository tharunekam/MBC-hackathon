import type { KeyboardEvent } from 'react';

/**
 * Arrow-key handling for a row of buttons that act as one control: a radio group (the arrows move to the next option and
 * choose it) or a set of tabs (the arrows only move focus; Enter or Space chooses, as for any button).
 *
 * Put it on the container's onKeyDown, give the chosen option tabIndex 0 and every other one -1 (see `rovingTab`), so the
 * whole group is one Tab stop. Options are found by role, so a disabled one is skipped.
 */
export function rovingKeys(e: KeyboardEvent<HTMLElement>, opts: { choose?: boolean } = {}): void {
  const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"],[role="tab"]')].filter((el) => !el.hasAttribute('disabled'));
  const at = items.findIndex((el) => el === document.activeElement);
  if (items.length === 0 || at < 0) return;
  e.preventDefault();
  const last = items.length - 1;
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at === 0 ? last : at - 1) : at === last ? 0 : at + 1;
  const target = items[to]!;
  target.focus();
  if (opts.choose) target.click();
}

/**
 * The tabIndex of option `i` in a group whose chosen option is `chosen` (-1 when none is): the chosen one, or the first when
 * nothing is chosen, is the one Tab stop of the group.
 */
export const rovingTab = (i: number, chosen: number): 0 | -1 => (i === chosen || (chosen < 0 && i === 0) ? 0 : -1);
