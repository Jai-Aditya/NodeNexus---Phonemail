import { useEffect, useRef } from 'react';

// Gmail's keyboard shortcuts. They never fire while you're typing (in a field or the email
// editor), with Ctrl/Cmd/Alt held, or when they're turned off in Settings.

const OFF_KEY = 'phonemail.shortcuts-off';

export const shortcutsOn = () => {
  try {
    return localStorage.getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
};
export const setShortcutsOn = (on: boolean) => {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, '1');
  } catch {
    /* private mode: stays on */
  }
};

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return Boolean(e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)));
};

/** Handlers by key ('c', '#', 'j', '/', 'I' for Shift+i...). A handler returning false lets the key through. */
export function useShortcuts(map: Record<string, (() => void | boolean) | undefined>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !shortcutsOn()) return;
      if (document.querySelector('.viewer, .sheet, [role="dialog"][aria-modal="true"]')) return; // something is open on top
      const fn = ref.current[e.key];
      if (fn && fn() !== false) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export const SHORTCUTS: [string, string][] = [
  ['c', 'Compose'],
  ['/', 'Search'],
  ['j / k', 'Next / previous conversation in the list'],
  ['o or Enter', 'Open conversation'],
  ['x', 'Select conversation'],
  ['e', 'Archive'],
  ['#', 'Delete'],
  ['Shift + i', 'Mark as read'],
  ['Shift + u', 'Mark as unread'],
  ['r', 'Reply to the newest email'],
  ['f', 'Forward the newest email'],
  ['u', 'Back to the list'],
  ['Ctrl + Enter', 'Send (while writing)'],
  ['?', 'Show these shortcuts'],
];
