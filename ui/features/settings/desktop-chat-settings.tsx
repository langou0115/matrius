import { AlertCircle } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import type { DesktopChatSettings } from '@contract/desktop-chat-settings';
import { ApiError } from '@/core/api/instance-client';
import { useInstance } from '@/features/instance/instance-state';

const path = '/api/desktop/chat-settings';
const BYTES_PER_MB = 1024 * 1024;
const AUTO_SAVE_DELAY_MS = 400;
const MAX_LIMIT_MB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MB);

function formatBytesAsMb(bytes: number): string {
  const mb = bytes / BYTES_PER_MB;
  if (Number.isInteger(mb)) return String(mb);
  const rounded = Math.round(mb * 1000) / 1000;
  return String(rounded > 0 ? rounded : Number(mb.toPrecision(4)));
}

function parseMbToBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  const bytes = Math.round(mb * BYTES_PER_MB);
  if (!Number.isSafeInteger(bytes) || bytes < 1) return null;
  return bytes;
}

function isValidProxyUrl(raw: string): boolean {
  if (!raw) return true;
  const parsed = URL.parse(raw);
  return Boolean(parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname);
}

export function DesktopChatSettingsForm() {
  const { request } = useInstance();
  const storageInputId = useId();
  const proxyInputId = useId();
  const [saved, setSaved] = useState<DesktopChatSettings>();
  const [storageLimit, setStorageLimit] = useState('');
  const [proxy, setProxy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [reload, setReload] = useState(0);

  const savedRef = useRef<DesktopChatSettings | undefined>(undefined);
  const staleRef = useRef(false);
  const initialStorageRef = useRef<{ text: string; bytes: number } | null>(null);
  const draftRef = useRef({ storageLimit: '', proxy: '' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const mountedRef = useRef(true);

  const applySaved = useCallback((value: DesktopChatSettings, syncDraft = true) => {
    const formattedLimit = formatBytesAsMb(value.storageLimitBytes);
    savedRef.current = value;
    initialStorageRef.current = { text: formattedLimit, bytes: value.storageLimitBytes };
    if (syncDraft) {
      draftRef.current = { storageLimit: formattedLimit, proxy: value.webtoolProxyUrl };
    }
    if (!mountedRef.current) return;
    setSaved(value);
    if (syncDraft) {
      setStorageLimit(formattedLimit);
      setProxy(value.webtoolProxyUrl);
    }
  }, []);

  const enqueueSave = useCallback((reportInvalid: boolean) => {
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      const currentSaved = savedRef.current;
      if (!currentSaved || staleRef.current) return;
      const draft = draftRef.current;
      const initialStorage = initialStorageRef.current;
      const trimmedLimit = draft.storageLimit.trim();
      const storageLimitBytes = initialStorage && trimmedLimit === initialStorage.text
        ? initialStorage.bytes
        : parseMbToBytes(draft.storageLimit);
      if (storageLimitBytes === null) {
        if (!trimmedLimit) {
          if (reportInvalid) {
            const reverted = formatBytesAsMb(currentSaved.storageLimitBytes);
            draftRef.current = { ...draftRef.current, storageLimit: reverted };
            if (mountedRef.current) {
              setStorageLimit(reverted);
              setError('');
            }
          }
          return;
        }
        if (reportInvalid && mountedRef.current) {
          setError('请输入大于 0 MB 且不超过上限的有效数值。');
        }
        return;
      }

      const webtoolProxyUrl = draft.proxy.trim();
      if (!isValidProxyUrl(webtoolProxyUrl)) {
        if (reportInvalid && mountedRef.current) {
          setError('请输入有效的 HTTP 或 HTTPS 代理地址。');
        }
        return;
      }

      if (
        storageLimitBytes === currentSaved.storageLimitBytes
        && webtoolProxyUrl === currentSaved.webtoolProxyUrl
      ) {
        if (reportInvalid && mountedRef.current && draft.proxy !== webtoolProxyUrl) {
          draftRef.current = { ...draftRef.current, proxy: webtoolProxyUrl };
          setProxy(webtoolProxyUrl);
        }
        return;
      }

      const sentDraft = { ...draft };
      try {
        const updated = await request<DesktopChatSettings>(path, {
          method: 'PUT',
          body: JSON.stringify({
            storageLimitBytes,
            webtoolProxyUrl,
            baseRevision: currentSaved.revision,
          }),
        });
        const draftUnchanged = draftRef.current.storageLimit === sentDraft.storageLimit
          && draftRef.current.proxy === sentDraft.proxy;
        applySaved(updated, draftUnchanged);
        if (mountedRef.current) setError('');
      } catch (cause) {
        if (!mountedRef.current) return;
        const isConflict = cause instanceof ApiError && cause.status === 409;
        staleRef.current = isConflict;
        setStale(isConflict);
        setError(cause instanceof Error ? cause.message : '保存设置失败。');
      }
    });
  }, [applySaved, request]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        enqueueSave(false);
      }
    };
  }, [enqueueSave]);

  useEffect(() => {
    const controller = new AbortController();
    void request<DesktopChatSettings>(path, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) applySaved(value); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && mountedRef.current) {
          setError(cause instanceof Error ? cause.message : '读取设置失败。');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && mountedRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [applySaved, request, reload]);

  function scheduleSave() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      enqueueSave(false);
    }, AUTO_SAVE_DELAY_MS);
  }

  function flushSave(reportInvalid = true) {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    enqueueSave(reportInvalid);
  }

  return (
    <form
      className="personalization-fields"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        flushSave(true);
      }}
      aria-busy={loading}
    >
      <label className="personalization-field" htmlFor={storageInputId}>
        <span>上传文件总量上限（MB）</span>
        <input
          id={storageInputId}
          className="text-field"
          type="number"
          inputMode="decimal"
          min={0.001}
          max={MAX_LIMIT_MB}
          step="any"
          disabled={loading || !saved || stale}
          value={storageLimit}
          onChange={(event) => {
            const next = event.target.value;
            draftRef.current = { ...draftRef.current, storageLimit: next };
            setStorageLimit(next);
            setError('');
            scheduleSave();
          }}
          onBlur={() => flushSave(true)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Escape' && saved) {
              if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
              }
              const reverted = formatBytesAsMb(saved.storageLimitBytes);
              draftRef.current = { ...draftRef.current, storageLimit: reverted };
              setStorageLimit(reverted);
              setError('');
            }
          }}
        />
      </label>
      <label className="personalization-field" htmlFor={proxyInputId}>
        <span>网页工具代理</span>
        <input
          id={proxyInputId}
          className="text-field"
          type="url"
          maxLength={2048}
          autoComplete="off"
          placeholder="http://127.0.0.1:7890"
          disabled={loading || !saved || stale}
          value={proxy}
          onChange={(event) => {
            const next = event.target.value;
            draftRef.current = { ...draftRef.current, proxy: next };
            setProxy(next);
            setError('');
            scheduleSave();
          }}
          onBlur={() => flushSave(true)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Escape' && saved) {
              if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
              }
              draftRef.current = { ...draftRef.current, proxy: saved.webtoolProxyUrl };
              setProxy(saved.webtoolProxyUrl);
              setError('');
            }
          }}
        />
        <small>留空时，网页搜索和网页读取直接连接。</small>
      </label>
      {error && (
        <div className="settings-message is-error" role="alert">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="settings-message-text">{error}</span>
          {(!saved || stale) && (
            <button
              className="secondary-button settings-message-reload"
              type="button"
              onClick={() => {
                if (timerRef.current !== null) {
                  clearTimeout(timerRef.current);
                  timerRef.current = null;
                }
                savedRef.current = undefined;
                staleRef.current = false;
                setSaved(undefined);
                setStale(false);
                setError('');
                setLoading(true);
                setReload((value) => value + 1);
              }}
            >
              重新加载
            </button>
          )}
        </div>
      )}
    </form>
  );
}
