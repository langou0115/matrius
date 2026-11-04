import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/core/api/auth-session.ts';

import {
  collectGeneratedFiles,
  createFileTool,
  fileToolsSystemPrompt,
  getFileActivityEnd,
  getFileActivityStart,
  normalizeFile,
  salvageTruncatedArguments,
} from '../src/core/agent/file-tools.ts';

const file = (id, filename = `${id}.pdf`, size = 1024, revision = 1) => ({
  id, filename, contentType: 'application/pdf', size, revision,
});
const draft = (id = 'draft:1', filename = 'draft.pdf') => ({
  id, filename, contentType: 'application/pdf', size: 512,
});

test('document validation failures tell the model which field to repair without echoing inputs', async () => {
  const { tool } = harness([new ApiError(422, 'validation_error', '请求参数不合法。', undefined, {
    error: { details: [{ loc: ['body', 'commands', 0, 'add'], msg: '不支持的文档属性：invalid', input: 'private content' }] },
  })]);
  await assert.rejects(tool.tool.execute('call', { operation: 'create', format: 'pptx' }), (error) => {
    assert.match(error.message, /body.commands.0.add/);
    assert.match(error.message, /不支持的文档属性/);
    assert.ok(!error.message.includes('private content'));
    return true;
  });
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
  assert.deepEqual(collectGeneratedFiles(result), [{ ...file('saved-1', 'final.docx', 4096, 2), operation: 'create' }]);

  const drafts = harness([{ operation: 'create', draft: draft() }]);
  const draftResult = await drafts.tool.tool.execute('call-2', { operation: 'create', format: 'pdf' }, undefined);
  assert.equal(draftResult.details.fileId, 'draft:1');
  assert.equal(draftResult.details.savedFileId, undefined);
  assert.match(draftResult.content[0].text, /Draft fileId: draft:1/);
  assert.match(draftResult.content[0].text, /next edit or save/);
  assert.deepEqual(drafts.tool.getGeneratedFiles(), []);
  assert.ok(drafts.tool.getAvailableFiles().some((item) => item.id === 'draft:1'));
  assert.deepEqual(collectGeneratedFiles(draftResult), []);
});

test('delete removes a file or draft from the available lists and reports its name', async () => {
  const { tool, calls } = harness([
    { operation: 'create', file: file('saved-1', 'old.pdf') },
    { operation: 'delete', fileId: 'saved-1', filename: 'old.pdf' },
  ]);
  await tool.tool.execute('create-1', { operation: 'create', format: 'pdf', save: true }, undefined);
  assert.deepEqual(tool.getGeneratedFiles().map((item) => item.id), ['saved-1']);
  assert.ok(JSON.stringify(tool.tool.parameters.properties.operation).includes('delete'));

  const result = await tool.tool.execute('delete-1', { operation: 'delete', fileId: 'saved-1' }, undefined);
  assert.deepEqual(calls[1].body, { operation: 'delete', fileId: 'saved-1', conversationId: 'conv-1' });
  assert.match(result.content[0].text, /old\.pdf/);
  assert.equal(result.details.operation, 'delete');
  assert.deepEqual(tool.getAvailableFiles(), []);
  assert.deepEqual(tool.getGeneratedFiles(), []);

  const drafts = harness([
    { operation: 'delete', fileId: 'draft:1', filename: 'scratch.pdf', draft: true },
  ], { availableFiles: [draft()] });
  const removed = await drafts.tool.tool.execute('delete-2', { operation: 'delete', fileId: 'draft:1' }, undefined);
  assert.match(removed.content[0].text, /Deleted draft: scratch\.pdf/);
  assert.deepEqual(drafts.tool.getAvailableFiles(), []);
});

test('a reply may make as many file calls, writes and saves as the task needs', async () => {
  const calls = harness([{ operation: 'list', files: [] }]);
  for (let index = 0; index < 30; index += 1) {
    const result = await calls.tool.tool.execute(`list-${index}`, { operation: 'list' }, undefined);
    assert.doesNotMatch(result.content[0].text, /budget|次数已达上限/i);
  }

  const writes = harness([{ operation: 'create', draft: draft() }]);
  for (let index = 0; index < 20; index += 1) {
    await writes.tool.tool.execute(`write-${index}`, { operation: 'create', format: 'pdf' }, undefined);
  }

  const saves = harness([{ operation: 'create', file: file('f') }]);
  for (let index = 0; index < 10; index += 1) {
    await saves.tool.tool.execute(`save-${index}`, { operation: 'create', format: 'pdf', save: true }, undefined);
  }

  assert.doesNotMatch(calls.tool.tool.description, /at most \d+ (calls|writes|saves)/i);
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
  assert.match(prompt, /绝不写出 fileId/);
  assert.match(prompt, /不可信资料/);
  assert.match(prompt, /replace_page/);
});

test('one write call is capped so it can finish inside the model output window', () => {
  const { tool } = harness([{ operation: 'list', files: [] }]);
  const schema = tool.tool.parameters;
  assert.equal(schema.properties.commands.maxItems, 20);
  assert.equal(schema.properties.pdfChanges.maxItems, 20);
  const props = schema.properties.commands.items.anyOf?.[0]?.properties?.props;
  const textLimits = JSON.stringify(props);
  assert.match(textLimits, /"maxLength":6000/);
});

test('document guidance splits large documents into bounded, resumable batches', () => {
  const prompt = fileToolsSystemPrompt();
  assert.match(prompt, /20 条命令/);
  assert.match(prompt, /6000/);
  assert.match(prompt, /5-10 行大纲/);
  assert.match(prompt, /PPT 1-2 页/);
  assert.match(prompt, /list 找回草稿/);
  assert.match(prompt, /"type":"markdown"/);
  assert.match(prompt, /type:"textbox"/);
  assert.match(prompt, /思考要短/);
  assert.match(prompt, /help 可带 format 和 element/);
  assert.match(prompt, /draft: 句柄/);
  assert.match(prompt, /父路径是 "\/"/);
  assert.match(prompt, /不要为了试验在资料库里留下文件/);
});

test('a truncated batch runs its complete prefix and tells the model where to resume', async () => {
  const { tool, calls } = harness([{ operation: 'edit', draft: draft('draft:1') }]);
  const prepared = tool.tool.prepareArguments({
    operation: 'edit',
    fileId: 'draft:1',
    commands: [
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '第一段' } },
      { command: 'add', parent: '/body' },
    ],
  });

  assert.equal(prepared.commands.length, 1);
  const result = await tool.tool.execute('call-1', prepared, undefined);
  assert.equal(calls[0].body.commands.length, 1);
  assert.match(result.content[0].text, /前 1 条/);
  assert.match(result.content[0].text, /第 2 条/);
  assert.match(result.details.warning, /截断/);
});

test('salvage keeps complete batches and unusable batches untouched', () => {
  const complete = { operation: 'edit', fileId: 'draft:1', commands: [
    { command: 'add', parent: '/body', type: 'paragraph', props: { text: 'a' } },
    { command: 'set', path: '/body/p[1]', props: { text: 'b' } },
  ] };
  assert.equal(salvageTruncatedArguments(complete), null);

  const unusable = { operation: 'edit', fileId: 'draft:1', commands: [{ command: 'add' }] };
  assert.equal(salvageTruncatedArguments(unusable), null);

  const pdf = salvageTruncatedArguments({
    operation: 'edit', fileId: 'draft:1', pdfChanges: [
      { operation: 'draw_text', page: 1, text: '标题' },
      { operation: 'draw_text', page: 2 },
    ],
  });
  assert.equal(pdf.kept, 1);
  assert.equal(pdf.dropped, 1);
  assert.equal(pdf.args.pdfChanges.length, 1);
});
