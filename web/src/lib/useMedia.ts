import { useEffect, useState } from 'react';

/** True while the media query matches, e.g. useMedia('(max-width: 719px)'). */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const update = () => setMatch(m.matches);
    update();
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [query]);
  return match;
}

/** Phone-sized screens get the WhatsApp-style layout; wider ones the Gmail-style one. */
export const usePhone = () => useMedia('(max-width: 719px)');
