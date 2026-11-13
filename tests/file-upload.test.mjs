import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstanceClient } from '../ui/core/api/instance-client.ts';
import {
  DOCUMENT_EXTENSIONS, MAX_UPLOAD_BYTES, MAX_UPLOADS, bulkDeleteFiles, fileContentUrl,
  fileExtension, getFileUsage, isAllowedAttachment, isDocumentFile, isImageAttachment,
  listFiles, renameFile, toMessageFile, uploadFile,
} from '../ui/features/files/files-api.ts';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('uploads send multipart form data with the client id and optional conversation', async () => {
  let captured;
  const request = async (path, init) => {
    captured = { path, init };
    return { id: 'f1' };
  };
  const file = new File([new Uint8Array([1, 2, 3])], 'report.pdf', { type: 'application/pdf' });
  await uploadFile(request, file, { clientId: 'client-1', conversationId: 'conv-1' });

  assert.equal(captured.path, '/api/files');
  assert.equal(captured.init.method, 'POST');
  assert.ok(captured.init.body instanceof FormData);
  assert.equal(captured.init.headers, undefined, 'the browser must add the multipart boundary');
  assert.equal(captured.init.body.get('file').name, 'report.pdf');
  assert.equal(captured.init.body.get('clientId'), 'client-1');
  assert.equal(captured.init.body.get('conversationId'), 'conv-1');

  const standalone = new File(['x'], 'note.txt', { type: 'text/plain' });
  await uploadFile(request, standalone, { clientId: 'client-2' });
  assert.equal(captured.init.body.get('conversationId'), null);
});

test('a FormData body never receives a JSON Content-Type', async () => {
  let headers;
  const auth = createInstanceClient(async (_url, init) => {
    headers = init.headers;
    return json({ ok: true });
  });
  await auth.request('/api/files', { method: 'POST', body: new FormData() });
  assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('Content-Type'), null);

  await auth.request('/api/files/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [] }) });
  assert.equal(headers.get('Content-Type'), 'application/json');
});

test('library queries are cursor paginated and omit defaults', async () => {
  const paths = [];
  const request = async (path) => {
    paths.push(path);
    return { items: [], nextCursor: null };
  };
  await listFiles(request, { query: '  report ', kind: 'all', sort: 'name', order: 'asc', limit: 10 });
  assert.equal(paths[0], '/api/files?query=report&sort=name&order=asc&limit=10');

  await listFiles(request, { kind: 'document', cursor: 'a/b' });
  assert.equal(paths[1], '/api/files?kind=document&cursor=a%2Fb&limit=50');
});

test('rename, bulk delete, usage and content URLs match the server routes', async () => {
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return {};
  };
  await renameFile(request, 'file id', 'new name.pdf');
  assert.deepEqual(calls[0], {
    path: '/api/files/file%20id', method: 'PATCH', body: { filename: 'new name.pdf' },
  });
  await bulkDeleteFiles(request, ['a', 'b']);
  assert.deepEqual(calls[1], { path: '/api/files/bulk-delete', method: 'POST', body: { ids: ['a', 'b'] } });
  await getFileUsage(request);
  assert.equal(calls[2].path, '/api/files/usage');
  assert.equal(fileContentUrl('file id'), '/api/files/file%20id/content');
});

test('attachment allow-lists match the server and keep image formats inline', () => {
  assert.equal(MAX_UPLOADS, 10);
  assert.equal(MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
  assert.deepEqual([...DOCUMENT_EXTENSIONS], ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt']);
  assert.equal(fileExtension('report.DOCX'), 'docx');
  assert.equal(fileExtension('README'), '');
  assert.equal(isDocumentFile('legacy.doc'), true);
  assert.equal(isAllowedAttachment('notes.md'), true);
  assert.equal(isAllowedAttachment('payload.exe'), false);
  assert.equal(isImageAttachment({ type: 'image/png', name: 'x.bin' }), true);
  assert.equal(isImageAttachment({ type: '', name: 'photo.JPEG' }), true);
  assert.equal(isImageAttachment({ type: 'application/pdf', name: 'x.pdf' }), false);
  assert.deepEqual(toMessageFile({
    id: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 3, revision: 4,
    sha256: 'ignored', createdAt: 1,
  }), { id: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 3, revision: 4 });
});
