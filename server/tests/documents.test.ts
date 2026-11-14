import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { toDbTimestamp, toDbUuid } from '../db/codecs';
import { insertFileRow } from '../db/repositories/files';
import { resolveOfficecli } from '../services/documents/binaries';
import { extractText } from '../services/documents/extract';
import { createFileToolService } from '../services/documents/file-service';
import type { FetchService } from '../services/fetch';
import type { SearchService } from '../services/search';
import { toolRegistry } from '../agent/tools';

const search: SearchService = { searchMany: async () => [] };
const fetch: FetchService = {
  fetch: async () => ({ title: '', url: '', text: '', truncated: false, chars: 0 }),
};

async function withApp(fn: (ctx: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-documents-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const ctx = await buildApp({ settings });
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedTextFile(
  db: Parameters<typeof insertFileRow>[0],
  storage: { put: (key: string, data: Uint8Array) => void },
  content = 'alpha\nbeta\ngamma',
): string {
  const id = randomUUID();
  storage.put(`${id}/note.txt`, new TextEncoder().encode(content));
  insertFileRow(db, {
    id,
    instanceId: 1,
    clientId: null,
    conversationId: null,
    filename: 'note.txt',
    objectKey: `${id}/note.txt`,
    contentType: 'text/plain',
    size: Buffer.byteLength(content),
    sha256: 'a'.repeat(64),
  });
  return id;
}

test('extracts text from plain, xlsx and pptx files', async () => {
  assert.equal(await extractText('note.txt', new TextEncoder().encode('hello')), 'hello');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(['Name', 'Value']);
  sheet.addRow(['Matrius', 1]);
  const xlsx = await workbook.xlsx.writeBuffer();
  const xlsxText = await extractText('data.xlsx', new Uint8Array(xlsx as ArrayBuffer));
  assert.match(xlsxText, /# Sheet1/u);
  assert.match(xlsxText, /Matrius\t1/u);

  const pptx = zipSync({
    'ppt/slides/slide1.xml': strToU8('<p:sld><p:cSld><p:spTree><a:t>Hello slide</a:t></p:spTree></p:cSld></p:sld>'),
  });
  const pptxText = await extractText('slides.pptx', pptx);
  assert.match(pptxText, /# Slide 1/u);
  assert.match(pptxText, /Hello slide/u);
});

test('the file service lists, slices and greps a Library file', async () => {
  await withApp(async ({ app, deps }) => {
    const fileId = seedTextFile(deps.db, deps.storage);
    const service = createFileToolService({
      db: deps.db,
      cache: deps.cache,
      storage: deps.storage,
    });

    const listed = await service.list(1);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, fileId);
    assert.equal(listed[0].filename, 'note.txt');

    const read = await service.read(1, fileId, { start: 2, end: 2, maxChars: 100 });
    assert.equal(read.text, 'beta');
    assert.equal(read.totalLines, 3);
    assert.equal(read.truncated, false);

    const grep = await service.grep(1, fileId, { pattern: 'a', context: 1, maxMatches: 10 });
    assert.ok(grep.matches.length >= 2);
    assert.equal(grep.totalLines, 3);

    const tools = toolRegistry.createTools({
      instanceId: 1,
      features: new Set(['files']),
      services: { search, fetch, files: deps.documents },
    });
    const tool = tools.find((item) => item.name === 'file');
    assert.ok(tool);
    const listResult = await tool.execute('file-list', { operation: 'list' } as never);
    assert.match(JSON.stringify(listResult.details), /note\.txt/u);

    const readResult = await tool.execute('file-read', { operation: 'read', fileId, start: 1, end: 2, maxChars: 100 } as never);
    assert.match(JSON.stringify(readResult.details), /alpha/u);
    assert.equal(app.server.listening, false);
  });
});

test('the document service creates, edits, saves, lists and deletes a docx', async (t) => {
  await withApp(async ({ deps }) => {
    try {
      resolveOfficecli(deps.settings);
    } catch {
      t.skip('OfficeCLI is not available on this machine');
      return;
    }
    const created = await deps.documents.run(1, {
      operation: 'create',
      format: 'docx',
      filename: 'report.docx',
    });
    const draft = created.draft as { id: string };
    assert.ok(draft?.id.startsWith('draft:'));

    const edited = await deps.documents.run(1, {
      operation: 'edit',
      fileId: draft.id,
      commands: [{
        command: 'add',
        parent: '/body',
        type: 'paragraph',
        props: { text: 'TypeScript document body' },
      }],
    });
    const editedDraft = edited.draft as { id: string };
    assert.equal(editedDraft.id, draft.id);

    const saved = await deps.documents.run(1, {
      operation: 'save',
      fileId: draft.id,
      filename: 'report.docx',
    });
    const savedFile = saved.file as { id: string; filename: string };
    assert.equal(savedFile.filename, 'report.docx');

    const listed = await deps.documents.run(1, { operation: 'list' });
    assert.ok((listed.files as Array<{ id: string }>).some((file) => file.id === savedFile.id));

    const read = await deps.documents.run(1, {
      operation: 'read',
      fileId: savedFile.id,
      start: 1,
      maxChars: 50_000,
    });
    assert.match(String(read.text), /TypeScript document body/u);

    const deleted = await deps.documents.run(1, {
      operation: 'delete',
      fileId: savedFile.id,
    });
    assert.equal(deleted.operation, 'delete');

    const tool = toolRegistry.createTools({
      instanceId: 1,
      features: new Set(['files']),
      services: { search, fetch, files: deps.documents },
    }).find((item) => item.name === 'file');
    assert.ok(tool);
    const toolCreated = await tool.execute('tool-create', {
      operation: 'create',
      format: 'docx',
      filename: 'tool.docx',
    } as never);
    const toolDraft = (toolCreated.details as { draft: { id: string } }).draft;
    assert.ok(toolDraft.id.startsWith('draft:'));
    const toolDeleted = await tool.execute('tool-delete', {
      operation: 'delete',
      fileId: toolDraft.id,
    } as never);
    assert.equal((toolDeleted.details as { operation: string }).operation, 'delete');
  });
});

test('text extraction cache avoids re-reading the same object', async () => {
  await withApp(async ({ deps }) => {
    const fileId = seedTextFile(deps.db, deps.storage);
    const service = createFileToolService({ db: deps.db, cache: deps.cache, storage: deps.storage });
    const first = await service.read(1, fileId, { start: 1, maxChars: 100 });
    const second = await service.read(1, fileId, { start: 1, maxChars: 100 });
    assert.deepEqual(second, first);
    assert.ok(deps.cache.get(`matrius:filetext:${toDbUuid(fileId)}:${'a'.repeat(64)}:v3`));
    assert.equal(typeof toDbTimestamp(), 'string');
  });
});
