import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { Icon } from '../components/Icon';

const TRIGGER = 70; // px to the right that counts as "reply"

// Swipe right to reply (the brief's phone gesture, as on WhatsApp): drag an email to the right
// and let go past the mark. A mostly vertical drag is a scroll and is left alone.
export function SwipeToReply({ enabled, onReply, children }: { enabled: boolean; onReply: () => void; children: ReactNode }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; horizontal?: boolean } | null>(null);

  if (!enabled) return <>{children}</>;

  const down = (e: TouchEvent) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
  };
  const move = (e: TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    const x = t.clientX - s.x;
    const y = t.clientY - s.y;
    if (s.horizontal === undefined && (Math.abs(x) > 8 || Math.abs(y) > 8)) s.horizontal = Math.abs(x) > Math.abs(y) * 1.5;
    if (s.horizontal) setDx(Math.max(0, Math.min(x, TRIGGER + 30)));
  };
  const up = () => {
    if (dx >= TRIGGER) onReply();
    start.current = null;
    setDx(0);
  };

  return (
    <div className="swipe" onTouchStart={down} onTouchMove={move} onTouchEnd={up} onTouchCancel={up}>
      <span className={dx >= TRIGGER ? 'swipe-hint ready' : 'swipe-hint'} style={{ opacity: Math.min(1, dx / TRIGGER) }} aria-hidden="true">
        <Icon name="reply" size={20} />
      </span>
      <div className="swipe-body" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform .2s' }}>
        {children}
      </div>
    </div>
  );
}
