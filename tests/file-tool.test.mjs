import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectGeneratedFiles,
  createFileTool,
  fileToolsSystemPrompt,
  getFileActivityEnd,
  getFileActivityStart,
  normalizeFile,
} from '../src/core/agent/file-tools.ts';

const file = (id, filename = `${id}.pdf`, size = 1024, revision = 1) => ({
  id, filename, contentType: 'application/pdf', size, revision,
});
const draft = (id = 'draft:1', filename = 'draft.pdf') => ({
  id, filename, contentType: 'application/pdf', size: 512,
});

function harness(results, options = {}) {
  const calls = [];
  const tool = createFileTool({
    request: async (path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
      const next = results.length > 1 ? results.shift() : results[0];
      if (next instanceof Error) throw next;
      return next;
    },
    conversationId: 'conv-1',
    availableFiles: options.availableFiles ?? [],
  });
  return { tool, calls };
}

test('the file tool posts to the single endpoint and injects the conversation id', async () => {
  const { tool, calls } = harness([{ operation: 'list', files: [file('f1', '报告.pdf', 2048)] }]);
  const result = await tool.tool.execute('call-1', { operation: 'list' }, undefined);

  assert.equal(calls[0].path, '/api/tools/file');
  assert.deepEqual(calls[0].body, { operation: 'list', conversationId: 'conv-1' });
  assert.match(result.content[0].text, /报告\.pdf/);
  assert.match(result.content[0].text, /fileId: f1/);
  assert.match(result.content[0].text, /草稿|Available files/);
});

test('saved files enter the generated list and drafts stay available only', async () => {
  const { tool } = harness([
    { operation: 'create', file: file('saved-1', 'final.docx', 4096, 2) },
  ]);
  const result = await tool.tool.execute('call-1', { operation: 'create', format: 'docx' }, undefined);

  assert.equal(result.details.kind, 'file');
  assert.equal(result.details.savedFileId, 'saved-1');
  assert.equal(result.details.operation, 'create');
  assert.deepEqual(tool.getGeneratedFiles().map((item) => item.id), ['saved-1']);
  assert.ok(tool.getAvailableFiles().some((item) => item.id === 'saved-1'));
  assert.deepEqual(collectGeneratedFiles(result), [{ ...file('saved-1', 'final.docx', 4096, 2) }]);

  const drafts = harness([{ operation: 'create', draft: draft() }]);
  const draftResult = await drafts.tool.tool.execute('call-2', { operation: 'create', format: 'pdf' }, undefined);
  assert.equal(draftResult.details.fileId, 'draft:1');
  assert.equal(draftResult.details.savedFileId, undefined);
  assert.deepEqual(drafts.tool.getGeneratedFiles(), []);
  assert.ok(drafts.tool.getAvailableFiles().some((item) => item.id === 'draft:1'));
  assert.deepEqual(collectGeneratedFiles(draftResult), []);
});

test('call, write and save budgets are enforced per reply', async () => {
  const calls = harness([{ operation: 'list', files: [] }]);
  for (let index = 0; index < 12; index += 1) {
    await calls.tool.tool.execute(`list-${index}`, { operation: 'list' }, undefined);
  }
  await assert.rejects(
    calls.tool.tool.execute('list-13', { operation: 'list' }, undefined),
    /次数已达上限/,
  );

  const writes = harness([{ operation: 'create', draft: draft() }]);
  for (let index = 0; index < 8; index += 1) {
    await writes.tool.tool.execute(`write-${index}`, { operation: 'create', format: 'pdf' }, undefined);
  }
  await assert.rejects(
    writes.tool.tool.execute('write-9', { operation: 'create', format: 'pdf' }, undefined),
    /写入次数已达上限/,
  );

  const saves = harness([{ operation: 'create', file: file('f') }]);
  for (let index = 0; index < 3; index += 1) {
    await saves.tool.tool.execute(`save-${index}`, { operation: 'create', format: 'pdf', save: true }, undefined);
  }
  await assert.rejects(
    saves.tool.tool.execute('save-4', { operation: 'create', format: 'pdf', save: true }, undefined),
    /最多保存 3 个文件/,
  );
});

test('tool errors are human-readable and AbortError keeps its meaning', async () => {
  const failed = harness([new Error('file tool exploded')]);
  await assert.rejects(
    failed.tool.tool.execute('call-1', { operation: 'read', fileId: 'f1' }, undefined),
    /file tool exploded/,
  );

  const aborted = harness([new DOMException('cancelled', 'AbortError')]);
  await assert.rejects(
    aborted.tool.tool.execute('call-1', { operation: 'read', fileId: 'f1' }, undefined),
    /请求已取消/,
  );
});

test('long read results are truncated and document payloads are marked untrusted', async () => {
  const long = 'x'.repeat(40_000);
  const { tool } = harness([{
    operation: 'read', fileId: 'f1', filename: 'big.txt', text: long,
    startLine: 1, endLine: 2, totalLines: 2,
  }]);
  const read = await tool.tool.execute('call-1', { operation: 'read', fileId: 'f1' }, undefined);
  assert.match(read.content[0].text, /<file_content fileId="f1"/);
  assert.match(read.content[0].text, /输出已截断/);
  assert.ok(read.content[0].text.length < 30_100);

  const inspected = harness([{
    operation: 'inspect', fileId: 'f1', format: 'pdf', text: '{"pageCount": 1}',
  }]);
  const result = await inspected.tool.tool.execute('call-2', { operation: 'inspect', fileId: 'f1' }, undefined);
  assert.match(result.content[0].text, /<document_data/);
  assert.match(result.content[0].text, /untrusted reference data/);
});

test('list results and available files are capped', async () => {
  const availableFiles = Array.from({ length: 40 }, (_, index) => file(`f${index}`));
  const { tool } = harness([{ operation: 'list', files: [] }], { availableFiles });
  assert.equal(tool.getAvailableFiles().length, 30);
  assert.equal(tool.getAvailableFiles()[0].id, 'f0');
});

test('activities expose file operations and saved links', () => {
  const started = getFileActivityStart('file', 'call-1', { operation: 'read', fileId: 'f1' });
  assert.equal(started.kind, 'file');
  assert.equal(started.status, 'running');
  assert.equal(started.operation, 'read');
  assert.equal(started.fileId, 'f1');
  assert.equal(getFileActivityStart('search', 'call-1', { operation: 'read' }), null);

  const ended = getFileActivityEnd('file', 'call-1', {
    details: { kind: 'file', operation: 'create', fileId: 'saved-1', filename: 'a.pdf', size: 3, savedFileId: 'saved-1', tookMs: 7 },
  }, false, started);
  assert.equal(ended.status, 'complete');
  assert.equal(ended.savedFileId, 'saved-1');
  assert.equal(ended.size, 3);
  assert.equal(ended.tookMs, 7);

  const failed = getFileActivityEnd('file', 'call-2', {
    content: [{ type: 'text', text: '文档引擎不可用' }],
  }, true, started);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, '文档引擎不可用');

  const warning = getFileActivityEnd('file', 'call-3', {
    details: { kind: 'file', operation: 'inspect', warning: '结果已截断。' },
  }, false);
  assert.equal(warning.status, 'complete');
  assert.equal(warning.warning, '结果已截断。');
});

test('file metadata and the system prompt stay conservative', () => {
  assert.deepEqual(normalizeFile({ id: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 1, revision: 2 }), {
    id: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 1, revision: 2,
  });
  assert.equal(normalizeFile({ id: '', filename: 'a.pdf' }), null);
  assert.equal(normalizeFile('nope'), null);

  const prompt = fileToolsSystemPrompt();
  assert.match(prompt, /fileId/);
  assert.match(prompt, /不可信资料/);
  assert.match(prompt, /replace_page/);
});
