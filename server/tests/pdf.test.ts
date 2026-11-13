import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { applyPdfChanges, inspectPdf } from '../services/documents/pdf';

async function withApp(fn: (ctx: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-pdf-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const ctx = await buildApp({ settings });
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('pdf changes draw text, add, rotate and remove pages', async () => {
  const settings = loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
  const created = await applyPdfChanges(settings, null, [{
    operation: 'draw_text',
    page: 1,
    text: 'Hello 中文 PDF',
    x: 24,
    y: 24,
    size: 14,
    color: '#2255aa',
  }]);
  assert.ok(created.length > 0);

  const added = await applyPdfChanges(settings, created, [
    {
      operation: 'add_page',
      page: 2,
      width: 400,
      height: 300,
      text: 'Second page',
      x: 20,
      y: 20,
      size: 12,
      color: '#000000',
    },
    { operation: 'rotate_page', page: 1, degrees: 90 },
  ]);
  const inspected = JSON.parse(await inspectPdf(added)) as {
    pageCount: number;
    pages: Array<{ width: number; height: number; rotation: number }>;
  };
  assert.equal(inspected.pageCount, 2);
  assert.equal(inspected.pages[0].rotation, 90);
  assert.equal(inspected.pages[1].width, 400);
  assert.equal(inspected.pages[1].height, 300);

  const removed = await applyPdfChanges(settings, added, [{ operation: 'remove_page', page: 2 }]);
  assert.equal((JSON.parse(await inspectPdf(removed)) as { pageCount: number }).pageCount, 1);
});

test('the document service creates, saves and reads a PDF', async () => {
  await withApp(async ({ deps }) => {
    const created = await deps.documents.run(1, {
      operation: 'create',
      format: 'pdf',
      filename: 'note.pdf',
      pdfChanges: [{
        operation: 'draw_text',
        page: 1,
        text: 'PDF body from TypeScript',
        x: 24,
        y: 24,
        size: 14,
        color: '#000000',
      }],
    });
    const draft = created.draft as { id: string };
    assert.ok(draft.id.startsWith('draft:'));

    const saved = await deps.documents.run(1, {
      operation: 'save',
      fileId: draft.id,
      filename: 'note.pdf',
    });
    const file = saved.file as { id: string; filename: string };
    assert.equal(file.filename, 'note.pdf');

    const inspected = await deps.documents.run(1, {
      operation: 'inspect',
      fileId: file.id,
    });
    assert.match(String(inspected.text), /"pageCount": 1/u);

    const read = await deps.documents.run(1, {
      operation: 'read',
      fileId: file.id,
      start: 1,
      maxChars: 50_000,
    });
    assert.match(String(read.text), /PDF body from TypeScript/u);

    const edited = await deps.documents.run(1, {
      operation: 'edit',
      fileId: file.id,
      pdfChanges: [{
        operation: 'add_page',
        page: 2,
        text: 'Second PDF page',
        x: 20,
        y: 20,
        size: 12,
        color: '#000000',
      }],
    });
    const editedDraft = edited.draft as { id: string };
    assert.ok(editedDraft.id.startsWith('draft:'));

    await deps.documents.run(1, {
      operation: 'delete',
      fileId: editedDraft.id,
    });
  });
});
