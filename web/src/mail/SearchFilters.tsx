import { useState, type FormEvent } from 'react';
import { useT } from '../lib/i18n';

// Gmail's search options as a form: it writes the search words and operators (from:, to:,
// has:attachment, after:, before:, in:, is:) that the mail service understands, so what
// you pick here can also be typed straight into the search box.

const quote = (v: string) => (/\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/** The fields of a query, read back so the form opens with what's already in the box. */
function parse(q: string) {
  const f = { words: '', from: '', to: '', after: '', before: '', where: '', attachment: false, unread: false, starred: false };
  const rest = q.replace(/(?:^|\s)(from|to|has|before|after|in|is):("[^"]*"|\S+)/gi, (_, op: string, raw: string) => {
    const v = raw.replace(/"/g, '');
    const o = op.toLowerCase();
    if (o === 'from') f.from = v;
    else if (o === 'to') f.to = v;
    else if (o === 'after') f.after = v;
    else if (o === 'before') f.before = v;
    else if (o === 'in') f.where = v.toLowerCase();
    else if (o === 'has') f.attachment = true;
    else if (o === 'is' && v.toLowerCase() === 'unread') f.unread = true;
    else if (o === 'is') f.starred = true;
    return ' ';
  });
  f.words = rest.replace(/\s+/g, ' ').trim();
  return f;
}

export function SearchFilters({ query, onSearch, onClose }: { query: string; onSearch: (q: string) => void; onClose: () => void }) {
  const t = useT();
  const [f, setF] = useState(() => parse(query));
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parts = [f.words.trim()];
    if (f.from.trim()) parts.push(`from:${quote(f.from.trim())}`);
    if (f.to.trim()) parts.push(`to:${quote(f.to.trim())}`);
    if (f.attachment) parts.push('has:attachment');
    if (f.after) parts.push(`after:${f.after}`);
    if (f.before) parts.push(`before:${f.before}`);
    if (f.where) parts.push(`in:${f.where}`);
    if (f.unread) parts.push('is:unread');
    if (f.starred) parts.push('is:starred');
    const q = parts.filter(Boolean).join(' ');
    if (q) onSearch(q);
  };

  return (
    <form className="search-filters" onSubmit={submit} aria-label={t('Search options')}>
      <label>{t('From')}<input value={f.from} onChange={(e) => set('from')(e.target.value)} placeholder={t('Name, number or address')} /></label>
      <label>{t('To')}<input value={f.to} onChange={(e) => set('to')(e.target.value)} placeholder={t('Name, number, address or group')} /></label>
      <label>{t('Has the words')}<input value={f.words} onChange={(e) => set('words')(e.target.value)} /></label>
      <div className="filter-row">
        <label>{t('After')}<input type="date" value={f.after} onChange={(e) => set('after')(e.target.value)} /></label>
        <label>{t('Before')}<input type="date" value={f.before} onChange={(e) => set('before')(e.target.value)} /></label>
      </div>
      <label>{t('Search in')}
        <select value={f.where} onChange={(e) => set('where')(e.target.value)}>
          <option value="">{t('Inbox')}</option>
          <option value="anywhere">{t('All mail, Spam and Trash')}</option>
          <option value="sent">{t('Sent by me')}</option>
          <option value="archived">{t('Archived')}</option>
          <option value="spam">{t('Spam')}</option>
          <option value="trash">{t('Trash')}</option>
        </select>
      </label>
      <div className="filter-checks">
        <label><input type="checkbox" checked={f.attachment} onChange={(e) => set('attachment')(e.target.checked)} />{t('Has attachment')}</label>
        <label><input type="checkbox" checked={f.unread} onChange={(e) => set('unread')(e.target.checked)} />{t('Unread')}</label>
        <label><input type="checkbox" checked={f.starred} onChange={(e) => set('starred')(e.target.checked)} />{t('Starred')}</label>
      </div>
      <div className="filter-actions">
        <button type="button" className="btn-link" onClick={onClose}>{t('Cancel')}</button>
        <button type="submit" className="btn-send">{t('Search')}</button>
      </div>
    </form>
  );
}
