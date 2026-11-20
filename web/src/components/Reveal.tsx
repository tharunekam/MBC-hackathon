import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';

/**
 * Fades its content up once, the first time it scrolls into view. The hidden state only applies when the page marked itself
 * as scripted (the `js` class on <html>), so without script, or with reduced motion, everything is simply visible.
 */
export default function Reveal({ children, delay = 0, as: Tag = 'div', className }: { children: ReactNode; delay?: number; as?: ElementType; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  const style = { '--d': `${delay}ms` } as CSSProperties;
  return (
    <Tag ref={ref} data-reveal="" className={[className, seen ? 'in' : ''].filter(Boolean).join(' ')} style={style}>
      {children}
    </Tag>
  );
}
