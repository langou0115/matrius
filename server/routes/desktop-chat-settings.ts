import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { DesktopChatSettings } from '../../contract/desktop-chat-settings';
import type { Settings } from '../config';
import type { AppDatabase } from '../db/client';
import { conflict, invalid } from '../errors';
import { hasFeature } from '../features/registry';

const updateSchema = z.object({
  storageLimitBytes: z.number().int().positive(),
  webtoolProxyUrl: z.string().trim().max(2048),
  baseRevision: z.number().int().nonnegative(),
});

export function registerDesktopChatSettings(app: FastifyInstance, db: AppDatabase, settings: Settings): void {
  if (!settings.MATRIUS_DESKTOP_DEV || !hasFeature('desktop-chat-settings')) return;

  const select = db.prepare(`SELECT storage_limit_bytes AS storageLimitBytes,
    webtool_proxy_url AS webtoolProxyUrl, revision FROM desktop_chat_settings WHERE instance_id = 1`);
  const save = db.prepare(`INSERT INTO desktop_chat_settings
    (instance_id, storage_limit_bytes, webtool_proxy_url, revision) VALUES (1, ?, ?, 1)
    ON CONFLICT(instance_id) DO UPDATE SET
      storage_limit_bytes = excluded.storage_limit_bytes,
      webtool_proxy_url = excluded.webtool_proxy_url,
      revision = desktop_chat_settings.revision + 1
    WHERE desktop_chat_settings.revision = ?`);
  const read = (): DesktopChatSettings => (select.get() as DesktopChatSettings | undefined) ?? {
    storageLimitBytes: settings.STORAGE_LIMIT_BYTES,
    webtoolProxyUrl: settings.WEBTOOL_PROXY_URL,
    revision: 0,
  };
  const apply = (value: DesktopChatSettings) => {
    settings.STORAGE_LIMIT_BYTES = value.storageLimitBytes;
    settings.WEBTOOL_PROXY_URL = value.webtoolProxyUrl;
  };

  apply(read());
  app.get('/api/desktop/chat-settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return read();
  });
  app.put('/api/desktop/chat-settings', async (request) => {
    const { storageLimitBytes, webtoolProxyUrl, baseRevision } = updateSchema.parse(request.body);
    if (webtoolProxyUrl) {
      const proxy = URL.parse(webtoolProxyUrl);
      if (!proxy || !['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) {
        throw invalid('请输入有效的 HTTP 或 HTTPS 代理地址。');
      }
    }
    if (read().revision !== baseRevision ||
      save.run(storageLimitBytes, webtoolProxyUrl, baseRevision).changes === 0) {
      throw conflict('设置已更新，请刷新后重试。');
    }
    const updated = read();
    apply(updated);
    return updated;
  });
}
