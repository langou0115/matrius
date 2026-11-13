import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import test from 'node:test';

import { createConverter } from '@deepseek-ai/libreoffice-kit';

import { loadSettings } from '../config';
import { AppError } from '../errors';
import { fontPath } from '../services/documents/binaries';
import { convertLegacy } from '../services/documents/converter';

test('legacy conversion loads the kit and rejects an invalid OLE document', async (t) => {
  const settings = loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
  let converter: Awaited<ReturnType<typeof createConverter>> | null = null;
  try {
    converter = await createConverter({
      timeoutMs: 120_000,
      fontDirectories: [dirname(fontPath(settings))],
    });
  } catch {
    t.skip('LibreOffice kit is not available on this machine');
    return;
  } finally {
    await converter?.dispose();
  }

  await assert.rejects(
    () => convertLegacy(settings, 'legacy.doc', Buffer.from('not an OLE compound document')),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 422
      && error.code === 'invalid_document',
  );
});
