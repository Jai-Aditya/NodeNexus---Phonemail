// Client for the PhoneMail api. nginx serves this app and passes /api/ to the api on the same
// address, so the session is an HttpOnly cookie the browser sends by itself: page scripts never
// see it. Every call that changes something carries X-Requested-With, which the api requires
// (another website can't add that header, so it can't act as the signed-in person).
import { brand } from '../brand';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unreachable = () => new ApiError(0, 'offline', `Cannot reach ${brand.name}. Check your connection and try again.`);

async function request<T>(method: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...init,
      headers: { 'X-Requested-With': 'fetch', ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw unreachable();
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('phonemail:signed-out'));
    const message = err?.message || `Request failed (${res.status})`;
    throw new ApiError(res.status, err?.code || 'error', err?.request_id ? `${message} (ref ${err.request_id.slice(0, 8)})` : message);
  }
  return data as T;
}

/** A JSON call to the api: api('GET', '/api/me'), api('POST', '/api/mail/messages', {...}). */
export function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A raw body (a profile photo). */
export function apiRaw<T = unknown>(method: string, path: string, body: Blob, contentType: string): Promise<T> {
  return request<T>(method, path, { headers: { 'Content-Type': contentType }, body });
}

// ---- types (as the api sends them) ----

export type User = {
  id: number;
  phone: string;
  address: string;
  display_name: string;
  language: string;
  avatar_url: string;
  has_push: boolean;
  has_password: boolean;
  created_via: string;
  aliases: string[];
  auth_mode: 'otp' | 'password';
  signature: string; // added under new emails
  undo_send_seconds: number; // how long "Undo" is offered after Send (0 = off)
};

export type Person = { user_id: number; address: string; display_name: string; avatar_url?: string };

export type Chat = {
  conversation_id: number;
  kind: 'direct' | 'group';
  name?: string;
  peer?: Person;
  member_count?: number;
  last_message_at: string;
  last_message_id?: number;
  snippet: string;
  unread_count: number;
  has_attachments: boolean;
  favourite_count: number;
  archived?: boolean;
  muted?: boolean;
  snoozed_until?: string;
};

export type RecipientView = { kind: 'to' | 'cc' | 'bcc'; person?: Person; group_id?: number; group_name?: string };
export type Attachment = { id: number; filename: string; content_type: string; size_bytes: number };

export type Message = {
  id: number;
  conversation_id: number;
  sender: Person;
  subject: string;
  body_text: string;
  body_html?: string;
  snippet: string;
  truncated?: boolean; // a list shows only the start: open it (getMessage) for the whole email
  parent_id?: number;
  root_id: number;
  depth: number;
  forwarded_from_id?: number;
  has_attachments: boolean;
  sent_at: string;
  folder: 'inbox' | 'spam' | 'trash';
  is_read: boolean;
  is_favourite: boolean;
  is_replied: boolean;
  is_mine: boolean;
  recipients?: RecipientView[];
  attachments?: Attachment[];
  reactions?: Reaction[];
};

export type Reaction = { emoji: string; count: number; mine?: boolean; names: string[] };
/** The reactions on offer (the mail service accepts only these). */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export type ChatEvent = { id: number; kind: string; actor?: Person; target?: Person; text: string; at: string };

export type Recipient = { address?: string; group_id?: number; group?: string };
export type Recipients = { to?: Recipient | Recipient[]; cc?: Recipient[]; bcc?: Recipient[]; group_name?: string };

export type Draft = {
  id: number;
  conversation_id?: number;
  parent_id?: number;
  recipients: Recipients;
  subject: string;
  body_text: string;
  body_html: string;
  updated_at: string;
  attachments?: Attachment[];
  forwarded_from_id?: number;
  send_at?: string; // waiting to be sent then (scheduled, or inside the Undo window)
  send_error?: string; // a scheduled send failed: why
};

export type DraftContent = {
  recipients: Recipients; subject: string; body_text: string; body_html?: string;
  conversation_id?: number; parent_id?: number; forwarded_from_id?: number;
};
export type ChatAction = 'archive' | 'unarchive' | 'trash' | 'read' | 'unread' | 'mute' | 'unmute' | 'snooze' | 'unsnooze';
export type Blocked = Person & { blocked_at: string };

export type Group = {
  conversation_id: number;
  name: string;
  created_at: string;
  members: (Person & { role: 'admin' | 'member'; joined_at: string })[];
};

export type Page<T> = { items: T[]; next?: { before: string; before_id: number } };
export type ChatPage = Page<Message> & { events: ChatEvent[] };
export type Suggestion = Person & { conversation_id?: number; known: boolean };
export type Suggestions = { people: Suggestion[]; groups: Group[] };
export type SearchResult = { messages: Message[]; people: (Person & { conversation_id?: number })[]; groups: Group[] };
export type AuthConfig = { mode: 'otp' | 'password'; password_reset: boolean; domain: string; default_country_code: string; signup_number?: string };
export type SendResult = { message_id: number; conversation_ids: number[] };

// ---- mail calls (the api passes /api/mail/* to the mail service) ----

const qs = (p: Record<string, string | number | undefined>) =>
  Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const mail = {
  home: (filter = 'all', next?: Page<Chat>['next']) =>
    api<Page<Chat>>('GET', `/api/mail/conversations?${qs({ filter, limit: 50, before: next?.before, before_id: next?.before_id })}`),
  chatInfo: (id: number) => api<Chat>('GET', `/api/mail/conversations/${id}`),
  /** Something done to whole conversations, one or many (bulk). */
  chatAction: (ids: number[], action: ChatAction, until?: string) =>
    api<{ changed: number }>('POST', '/api/mail/conversations/actions', { conversation_ids: ids, action, until }),
  react: (id: number, emoji: string) => api('PUT', `/api/mail/messages/${id}/reaction`, { emoji }),
  unreact: (id: number) => api('DELETE', `/api/mail/messages/${id}/reaction`),
  blocks: () => api<{ items: Blocked[] }>('GET', '/api/mail/blocks').then((r) => r.items),
  block: (address: string) => api<Blocked>('POST', '/api/mail/blocks', { address }),
  unblock: (userId: number) => api('DELETE', `/api/mail/blocks/${userId}`),
  chat: (id: number, next?: Page<Message>['next']) =>
    api<ChatPage>('GET', `/api/mail/conversations/${id}/messages?${qs({ limit: 50, before: next?.before, before_id: next?.before_id })}`),
  thread: (rootId: number, conversationId: number) =>
    api<{ items: Message[] }>('GET', `/api/mail/threads/${rootId}?conversation_id=${conversationId}`),
  message: (id: number, conversationId?: number) =>
    api<Message>('GET', `/api/mail/messages/${id}${conversationId ? `?conversation_id=${conversationId}` : ''}`),
  send: (body: Recipients & { conversation_id?: number; subject?: string; body_text: string; draft_id?: number }) =>
    api<SendResult>('POST', '/api/mail/messages', body),
  reply: (id: number, body: { conversation_id: number; body_text: string; draft_id?: number }) =>
    api<SendResult>('POST', `/api/mail/messages/${id}/reply`, body),
  flag: (id: number, conversationId: number, change: { is_read?: boolean; is_favourite?: boolean; folder?: 'inbox' | 'spam' | 'trash' }) =>
    api('PATCH', `/api/mail/mailbox/${id}`, { conversation_id: conversationId, ...change }),
  folder: (name: 'spam' | 'trash') => api<Page<Message>>('GET', `/api/mail/folders/${name}?limit=100`),
  emptyTrash: () => api('DELETE', '/api/mail/trash'),
  search: (q: string) => api<SearchResult>('GET', `/api/mail/search?q=${encodeURIComponent(q)}`),
  suggest: (q: string) => api<Suggestions>('GET', `/api/mail/suggest?q=${encodeURIComponent(q)}`),
  drafts: () => api<Draft[] | { items: Draft[] }>('GET', '/api/mail/drafts').then((d) => (Array.isArray(d) ? d : d.items || [])),
  saveDraft: (id: number | null, d: DraftContent) =>
    id ? api<Draft>('PUT', `/api/mail/drafts/${id}`, d) : api<Draft>('POST', '/api/mail/drafts', d),
  deleteDraft: (id: number) => api('DELETE', `/api/mail/drafts/${id}`),
  sendDraft: (id: number) => api<SendResult>('POST', `/api/mail/drafts/${id}/send`, {}),
  /** Send later: at a time (scheduled send) or in a few seconds (undo send). */
  scheduleDraft: (id: number, when: { send_at?: string; delay_seconds?: number }) => api<Draft>('POST', `/api/mail/drafts/${id}/send`, when),
  /** Take back a draft waiting to be sent (Undo, or cancel a scheduled send). */
  unschedule: (id: number) => api<Draft>('POST', `/api/mail/drafts/${id}/unschedule`, {}),
  removeAttachment: (draftId: number, id: number) => api('DELETE', `/api/mail/drafts/${draftId}/attachments/${id}`),
  groups: () => api<Group[] | { items: Group[] }>('GET', '/api/mail/groups').then((g) => (Array.isArray(g) ? g : g.items || [])),
  group: (id: number) => api<Group>('GET', `/api/mail/groups/${id}`),
  addMembers: (id: number, members: string[]) => api<Group>('POST', `/api/mail/groups/${id}/members`, { members: members.map((address) => ({ address })) }),
  removeMember: (id: number, userId: number) => api('DELETE', `/api/mail/groups/${id}/members/${userId}`),
  setRole: (id: number, userId: number, role: 'admin' | 'member') => api('PATCH', `/api/mail/groups/${id}/members/${userId}`, { role }),
  leave: (id: number) => api('POST', `/api/mail/groups/${id}/leave`, {}),
};

// Upload one file onto a draft, reporting progress (0..1).
export function uploadAttachment(draftId: number, file: File, onProgress: (p: number) => void): { promise: Promise<Attachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open('POST', `/api/mail/drafts/${draftId}/attachments`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: { message?: string } } & Partial<Attachment> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else reject(new ApiError(xhr.status, 'upload', data.error?.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(unreachable());
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export const attachmentUrl = (id: number) => `/api/mail/attachments/${id}`;

export async function fetchAttachment(id: number): Promise<Blob> {
  const res = await fetch(attachmentUrl(id), { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'download', `Download failed (${res.status})`);
  return res.blob();
}

// ---- small helpers ----

export const displayName = (p?: Person, fallback = '') => p?.display_name || p?.address || fallback;

export const chatTitle = (c: Chat) =>
  c.kind === 'group' ? c.name || 'Group' : c.peer ? displayName(c.peer) : c.name || 'Deleted account';

/** "98765 43210, asha@x, Goa crew" -> ["98765 43210", "asha@x", "Goa crew"]. Commas and semicolons separate. */
export const splitRecipients = (s: string) => s.split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
