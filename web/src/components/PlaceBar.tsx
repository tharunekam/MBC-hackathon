import { useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

/** The width at and below which the app is a phone: the tab bar is drawn along the bottom and the ticket's button rides above it. */
const PHONE = '(max-width: 720px)';

/** Whether the window is phone width, kept up to date as it is resized or turned. */
export function usePhone(): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches;
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** A layout effect where there is a layout to measure; a plain one where the component is only rendered to text (the unit tests). */
const useMeasure = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The phone's tab bar is fixed to the bottom of the window, so the bar rides just above it. Zero where there is none. */
function useTabbarHeight(): number {
  const [h, setH] = useState(0);
  useMeasure(() => {
    const el = document.querySelector<HTMLElement>('.tabbar');
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return h;
}

interface Props {
  /** The chance of winning as the ticket prints it ("37%"), or null while there is none. */
  chance: string | null;
  /** The Place bet button itself: the one button of the page, moved here from the ticket while this bar is drawn. */
  children: ReactNode;
}

/**
 * On a phone the ticket sits a long way below the chart, so the Place bet button rides along the bottom of the window above
 * the tab bar, with the chance of winning beside it, the way the Basket's does. It follows the ticket in the page, so at the
 * end of the page it is simply the last thing and nothing is under it (builder.css reserves room for it while it floats).
 *
 * The page hands over its one button: the button state and every refusal still come from lib/betState.ts, drawn once.
 */
export default function PlaceBar({ chance, children }: Props) {
  const tabbar = useTabbarHeight();
  return (
    <div className="bet-bar" style={{ bottom: tabbar + 8 }}>
      <div className="bet-bar-sum">
        <span>Chance of winning</span>
        <b>{chance ?? '–'}</b>
      </div>
      {children}
    </div>
  );
}

/**
 * When a press disables the very button that was pressed (a refusal, a bet that may or may not have gone through), the browser
 * drops keyboard focus to the top of the page and a person who uses the keyboard starts again from the header. This moves
 * focus to the note that says what happened, whenever `show` turns on and focus has been lost. A field the person is typing in
 * is never taken from them.
 */
export function useRescueFocus(note: RefObject<HTMLElement | null>, show: boolean): void {
  useEffect(() => {
    if (!show) return;
    const at = document.activeElement;
    const lost = !at || at === document.body || at === document.documentElement || (at instanceof HTMLButtonElement && at.disabled);
    if (lost) note.current?.focus();
  }, [note, show]);
}
