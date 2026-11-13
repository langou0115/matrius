import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../config';
import { resolveOfficecli } from '../services/documents/binaries';
import {
  officeCreate,
  officeEdit,
  officeHelp,
  officeInspect,
  officeViewText,
} from '../services/documents/officecli';

test('the OfficeCLI wrapper creates, edits and reads a docx', async (t) => {
  const settings = loadSettings({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
  try {
    resolveOfficecli(settings);
  } catch {
    t.skip('OfficeCLI is not available on this machine');
    return;
  }

  const help = await officeHelp(settings, 'docx', 'paragraph');
  assert.match(help, /paragraph/u);

  const created = await officeCreate(settings, 'docx');
  assert.ok(created.length > 0);
  const baseline = await officeInspect(settings, 'docx', created, '/body');
  assert.ok(baseline.length > 0);

  const edited = await officeEdit(settings, 'docx', created, [{
    command: 'add',
    parent: '/body',
    type: 'paragraph',
    props: { text: 'Hello from TypeScript' },
  }]);
  assert.ok(edited.length > 0);
  const text = await officeViewText(settings, 'document.docx', edited);
  assert.match(text, /Hello from TypeScript/u);
});
