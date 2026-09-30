import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { brand } from '../brand';
import { api, type AuthConfig, type User } from './api';

// What the live stream (/api/events) announces. "message" = new mail in a chat;
// group_* and group_event = a group changed (members, admins, activity lines); "chats" = you
// archived, snoozed, muted... on another device, or a snooze ended; "reaction" = someone
// reacted to an email you have; "draft_failed" = a scheduled email of yours couldn't be sent.
export type LiveEvent = { type: string; conversation_id?: number; message_id?: number; sender_id?: number; subject?: string };

type Session = {
  ready: boolean;
  user: User | null;
  signedIn: (user: User) => void;
  signOut: (everywhere?: boolean) => Promise<void>;
  refreshUser: () => Promise<void>;
  /** Subscribe to live events; returns the unsubscribe function. */
  onLive: (fn: (e: LiveEvent) => void) => () => void;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());

  // The session is an HttpOnly cookie: asking for /api/me is how we learn whether it's valid.
  useEffect(() => {
    // The mail domain comes from the server, so addresses shown always match the server's.
    const config = api<AuthConfig>('GET', '/api/auth/config').then((c) => { brand.domain = c.domain; }, () => {});
    const me = api<User>('GET', '/api/me').then(setUser, () => setUser(null));
    Promise.all([config, me]).finally(() => setReady(true));
    const out = () => setUser(null);
    window.addEventListener('phonemail:signed-out', out);
    return () => window.removeEventListener('phonemail:signed-out', out);
  }, []);

  // Live updates over Server-Sent Events. The browser reconnects by itself if the
  // connection drops; the api ends the stream when the session is logged out.
  useEffect(() => {
    if (!user) return;
    const es = new EventSource('/api/events', { withCredentials: true });
    const relay = (ev: MessageEvent) => {
      let data: LiveEvent;
      try {
        data = { type: ev.type, ...JSON.parse(ev.data) };
      } catch {
        return;
      }
      listeners.current.forEach((fn) => fn(data));
    };
    for (const type of ['message', 'group_created', 'group_members_added', 'group_member_left', 'group_event', 'chats', 'reaction', 'draft_failed']) {
      es.addEventListener(type, relay);
    }
    return () => es.close();
  }, [user?.id]);

  const signedIn = useCallback((u: User) => setUser(u), []);
  const signOut = useCallback(async (everywhere = false) => {
    await api('POST', '/api/auth/logout', { everywhere }).catch(() => {});
    setUser(null);
  }, []);
  const refreshUser = useCallback(async () => setUser(await api<User>('GET', '/api/me')), []);
  const onLive = useCallback((fn: (e: LiveEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo(() => ({ ready, user, signedIn, signOut, refreshUser, onLive }), [ready, user, signedIn, signOut, refreshUser, onLive]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
