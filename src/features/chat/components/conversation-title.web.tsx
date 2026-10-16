import { useEffect, useRef, useState } from 'react';

type Props = {
  title: string;
  onRename: (title: string) => void;
};

export function ConversationTitle({ title, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    const element = input.current;
    if (!element) return;
    // The title lives in a sticky topbar; a plain focus() makes the browser scroll
    // its flow position into view, which yanks a long conversation back to the top.
    element.focus({ preventScroll: true });
    const end = element.value.length;
    element.setSelectionRange(end, end);
  }, [editing]);

  function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = value.trim();
    if (next && next !== title) onRename(next);
    setEditing(false);
  }

  function cancel() {
    cancelled.current = true;
    setValue(title);
    setEditing(false);
  }

  if (!editing) return <h1 className="conversation-title" onClick={() => { cancelled.current = false; setValue(title); setEditing(true); }}>{title}</h1>;

  return <span className="conversation-title-field">
    <span className="conversation-title-measure" aria-hidden="true">{value || ' '}</span>
    <input ref={input} className="conversation-title-input" value={value} maxLength={120} aria-label="对话标题"
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }} />
  </span>;
}
