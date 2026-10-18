import { useEffect, useRef, useState, type RefObject } from 'react';
import { Quote } from 'lucide-react';

/** Only one assistant answer's body can be quoted; controls and reasoning stay out. */
export function readSelectionQuote(container: HTMLElement, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selection.anchorNode || !selection.focusNode) return null;
  const anchor = selection.anchorNode.nodeType === 1 ? selection.anchorNode as Element : selection.anchorNode.parentElement;
  const source = anchor?.closest<HTMLElement>('[data-quote-source]');
  if (!source || !container.contains(source) || !source.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  if (Array.from(source.querySelectorAll('.message-code-header, button, [data-quote-disabled]')).some((node) => range.intersectsNode(node))) return null;
  const content = selection.toString().trim();
  if (!content) return null;
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { content, rect };
}

export function SelectionQuote({ containerRef, onQuote }: { containerRef: RefObject<HTMLElement | null>; onQuote: (content: string) => void }) {
  const [action, setAction] = useState<{ content: string; left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let dragging = false;
    let frame = 0;
    let start: ReturnType<typeof snapshot>;
    const snapshot = () => {
      const selection = window.getSelection();
      return selection ? { anchor: selection.anchorNode, focus: selection.focusNode, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset, text: selection.toString() } : null;
    };
    function clear() { setAction(null); }
    function update() {
      if (dragging) return;
      const container = containerRef.current;
      const selected = container && !document.querySelector('dialog[open]') ? readSelectionQuote(container, window.getSelection()) : null;
      if (!selected || !container) { clear(); return; }
      const { content, rect } = selected;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const bounds = container.getBoundingClientRect();
      if (rect.bottom <= Math.max(bounds.top + 52, topEdge) || rect.top >= Math.min(bounds.bottom, topEdge + height)) { clear(); return; }
      setAction({ content,
        left: Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - 96)),
        top: Math.max(topEdge + 8, Math.min(rect.top - 44 < topEdge + 8 ? rect.bottom + 8 : rect.top - 44, topEdge + height - 44)),
      });
    }
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && button.current?.contains(event.target)) return;
      cancelAnimationFrame(frame);
      dragging = true;
      start = snapshot();
      clear();
    }
    function onPointerUp(event: PointerEvent) {
      if (event.target instanceof Node && button.current?.contains(event.target)) return;
      dragging = false;
      const end = snapshot();
      if (start && end && start.anchor === end.anchor && start.focus === end.focus && start.anchorOffset === end.anchorOffset && start.focusOffset === end.focusOffset && start.text === end.text) { clear(); return; }
      update();
    }
    function onSelectionChange() {
      if (dragging) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    }
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') { clear(); window.getSelection()?.removeAllRanges(); } }
    function cancel() { dragging = false; clear(); }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    window.addEventListener('blur', cancel);
    window.visualViewport?.addEventListener('resize', clear);
    window.visualViewport?.addEventListener('scroll', clear);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
      window.removeEventListener('blur', cancel);
      window.visualViewport?.removeEventListener('resize', clear);
      window.visualViewport?.removeEventListener('scroll', clear);
    };
  }, [containerRef]);

  if (!action) return null;
  return <button ref={button} type="button" className="selection-quote-action" style={{ left: action.left, top: action.top }}
    aria-label="引用选中文字" onPointerDown={(event) => event.preventDefault()} onClick={() => {
      onQuote(action.content);
      setAction(null);
      window.getSelection()?.removeAllRanges();
    }}><Quote size={15} strokeWidth={1.75} aria-hidden="true" />引用</button>;
}
