import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Icon } from '../components/Icon';
import { useT } from '../lib/i18n';

export type EditorValue = { html: string; text: string };
export type EditorHandle = { focus: () => void; setHtml: (html: string) => void };

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text as editor HTML: kept line by line. */
export const textToHtml = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');

/** The signature block added under a new email. */
export const signatureHtml = (sig: string) => (sig.trim() ? `<div><br></div><div><br></div><div>-- <br>${textToHtml(sig.trim())}</div>` : '');

// A small rich-text editor for emails: bold, italic, underline, lists and links (Gmail's
// basics). The browser's editing commands do the work; the mail service cleans the HTML
// again when it's stored, so whatever is pasted in can't carry scripts or tracking.
// Ctrl+Enter sends.
export function RichEditor({ id, label, placeholder, initialHtml = '', onChange, onSubmit, rows = 6, autoFocus, editorRef }: {
  id: string; label: string; placeholder?: string; initialHtml?: string; rows?: number; autoFocus?: boolean;
  onChange: (v: EditorValue) => void; onSubmit?: () => void; editorRef?: Ref<EditorHandle>;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(!initialHtml);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const saved = useRef<Range | null>(null);

  const emit = () => {
    const el = box.current;
    if (!el) return;
    const text = el.innerText.replace(/ /g, ' ').replace(/\n$/, '');
    setEmpty(!text.trim() && !el.querySelector('img'));
    onChange({ html: text.trim() ? el.innerHTML : '', text });
  };

  useEffect(() => {
    if (box.current) box.current.innerHTML = initialHtml;
    if (autoFocus) box.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(editorRef, () => ({
    focus: () => box.current?.focus(),
    setHtml: (html: string) => {
      if (box.current) box.current.innerHTML = html;
      emit();
    },
  }));

  const run = (cmd: string, arg?: string) => {
    box.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  const startLink = () => {
    const sel = window.getSelection();
    saved.current = sel && sel.rangeCount && box.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setUrl('');
    setLinking(true);
  };
  const addLink = () => {
    let href = url.trim();
    setLinking(false);
    if (!href) return;
    if (!/^(https?:|mailto:)/i.test(href)) href = href.includes('@') && !href.includes('/') ? `mailto:${href}` : `https://${href}`;
    box.current?.focus();
    const sel = window.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
    if (!sel || sel.isCollapsed) run('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(url.trim())}</a>`);
    else run('createLink', href);
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  const tool = (icon: string, name: string, act: () => void) => (
    <button type="button" className="icon-btn tool" aria-label={name} title={name} onMouseDown={(e) => e.preventDefault()} onClick={act}>
      <Icon name={icon} size={17} />
    </button>
  );

  return (
    <div className="editor">
      <div className="editor-tools" role="toolbar" aria-label={t('Formatting')}>
        {tool('bold', t('Bold'), () => run('bold'))}
        {tool('italic', t('Italic'), () => run('italic'))}
        {tool('underline', t('Underline'), () => run('underline'))}
        {tool('bullets', t('Bulleted list'), () => run('insertUnorderedList'))}
        {tool('numbers', t('Numbered list'), () => run('insertOrderedList'))}
        {tool('link', t('Insert link'), startLink)}
        {tool('clear', t('Remove formatting'), () => { run('removeFormat'); run('unlink'); })}
        {linking ? (
          <span className="link-box">
            <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('Paste or type a link')} aria-label={t('Link address')}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } if (e.key === 'Escape') setLinking(false); }} />
            <button type="button" className="btn-link small" onClick={addLink}>{t('Add')}</button>
          </span>
        ) : null}
      </div>
      <div ref={box} id={id} className={empty ? 'editor-area is-empty' : 'editor-area'} contentEditable suppressContentEditableWarning
        role="textbox" aria-multiline="true" aria-label={label} data-placeholder={placeholder}
        style={{ minHeight: `${rows * 1.5}em` }} onInput={emit} onKeyDown={onKey} />
    </div>
  );
}
