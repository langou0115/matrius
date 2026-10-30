/**
 * The workspace save-failure toast. Extracted so the dev preview renders the real markup and
 * styles; the text stays selectable for copying.
 */
export function StorageErrorToast({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="storage-error" role="alert">
    <span>{message}</span>
    <button type="button" onClick={onRetry}>重试保存</button>
  </div>;
}
