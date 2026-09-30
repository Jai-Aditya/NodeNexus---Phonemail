import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// A small history-API router: the app has a handful of routes and needs nothing more.
export function navigate(to: string, replace = false) {
  if (to === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('phonemail:navigate'));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const update = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', update);
    window.addEventListener('phonemail:navigate', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('phonemail:navigate', update);
    };
  }, []);
  return loc;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
