import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectReplySources, extractCitations, prepareCitations, webActivitiesOf,
} from '../ui/features/chat/citations.ts';

test('footnote references become numbered citation links and definitions leave the body', () => {
  const content = '第一段[^b]。\n\n第二段[^1]，再次引用[^b]。\n\n[^b]: [B 来源](https://b.example/page#part)\n[^1]: 来源：A 文档';
  const prepared = prepareCitations(content);
  assert.equal(prepared.byLabel.get('b').number, 1, 'numbers follow first reference, not the label');
  assert.equal(prepared.byLabel.get('1').number, 2);
  assert.equal(prepared.byLabel.get('b').url, 'https://b.example/page#part');
  assert.equal(prepared.byLabel.get('1').title, 'A 文档');
  assert.equal(prepared.byLabel.get('1').resolved, true);
  assert.match(prepared.markdown, /第一段\[1\]\(#citation-b\)。/, 'the marker is a link the renderer can intercept');
  assert.match(prepared.markdown, /第二段\[2\]\(#citation-1\)，再次引用\[1\]\(#citation-b\)。/);
  assert.ok(!prepared.markdown.includes('[^b]'));
  assert.ok(!prepared.markdown.includes('[^1]:'));
  assert.ok(!prepared.markdown.includes('B 来源'), 'the definition list is removed from the answer body');
});

test('citation parsing leaves inline code and fenced code untouched', () => {
  const content = '行内 `[^x]` 与正文[^x]。\n\n```\n[^x]: [代码里的定义](https://code.example)\n```\n\n[^x]: [真实来源](https://real.example)';
  const prepared = prepareCitations(content);
  assert.match(prepared.markdown, /行内 `\[\^x\]` 与正文\[1\]\(#citation-x\)。/);
  assert.ok(prepared.markdown.includes('[^x]: [代码里的定义](https://code.example)'), 'a fence stays verbatim');
  assert.equal(prepared.byLabel.get('x').url, 'https://real.example', 'the definition inside the fence is ignored');
  assert.ok(!prepared.markdown.includes('真实来源'));
});

test('an unresolved reference still renders a marker but is not listed as a source', () => {
  const citations = extractCitations('回答内容[^missing]');
  assert.equal(citations.length, 1);
  assert.equal(citations[0].number, 1);
  assert.equal(citations[0].resolved, false);
  assert.equal(collectReplySources('回答内容[^missing]').total, 0);
  assert.equal(collectReplySources('回答内容[^missing]').citations.length, 0);
});

test('search snippets enrich a citation that only names a URL or document', () => {
  const activities = [{
    id: 'search', kind: 'search', status: 'complete', query: 'q',
    results: [{ rank: 1, title: 'OpenAI Docs', url: 'https://openai.com/docs', domain: 'openai.com', snippet: '官方文档摘要', engine: 'duckduckgo' }],
  }];
  const urlOnly = extractCitations('见[^1]\n\n[^1]: https://openai.com/docs', activities)[0];
  assert.equal(urlOnly.title, 'OpenAI Docs', 'the search result title is better than the bare hostname');
  assert.equal(urlOnly.snippet, '官方文档摘要');
  assert.equal(urlOnly.domain, 'openai.com');
  const unknown = extractCitations('见[^3]\n\n[^3]: https://unknown.example/page')[0];
  assert.equal(unknown.title, 'unknown.example', 'without a matching result the hostname is the title');

  const named = extractCitations('见[^2]\n\n[^2]: 来源：OpenAI 官方文档', activities)[0];
  assert.equal(named.title, 'OpenAI 官方文档');
  assert.equal(named.resolved, true);
  assert.equal(named.url, undefined);

  const unsafe = extractCitations('见[^4]\n\n[^4]: [不要点击](javascript:alert(1))')[0];
  assert.equal(unsafe.url, undefined, 'only http(s) definitions can become clickable markers');
  assert.equal(unsafe.title, '不要点击');

  const credential = extractCitations('见[^5]\n\n[^5]: [凭据](https://user:secret@example.com/page)')[0];
  assert.equal(credential.url, undefined, 'URLs with embedded credentials stay non-clickable');
});

test('URLs keep balanced parentheses and lose sentence punctuation', () => {
  const wiki = extractCitations('见[^1]\n\n[^1]: [Foo](https://en.wikipedia.org/wiki/Foo_(bar))')[0];
  assert.equal(wiki.url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  const bare = extractCitations('见[^2]\n\n[^2]: 见 https://example.com/page).')[0];
  assert.equal(bare.url, 'https://example.com/page');
  const titled = extractCitations('见[^3]\n\n[^3]: [Title](https://example.com/page "page title")')[0];
  assert.equal(titled.url, 'https://example.com/page');
  assert.equal(titled.title, 'Title');
});

test('the source list contains only the sources the answer cites', () => {
  const activities = [
    {
      id: 'search', kind: 'search', status: 'complete', query: 'q', results: [
        { rank: 1, title: 'Cited', url: 'https://cited.example/page', domain: 'cited.example', snippet: 'cited snippet', engine: 'x' },
        { rank: 2, title: 'Read too', url: 'https://read.example/page', domain: 'read.example', snippet: 'read snippet', engine: 'x' },
        { rank: 3, title: 'Search only', url: 'https://search.example/page', domain: 'search.example', snippet: 'search snippet', engine: 'x' },
      ],
    },
    { id: 'fetch', kind: 'fetch', status: 'complete', url: 'https://read.example/page', urls: ['https://read.example/page'], title: 'Read page' },
  ];
  const sources = collectReplySources('结论[^1]\n\n[^1]: [Cited page](https://cited.example/page)', activities);
  assert.equal(sources.total, 1);
  assert.deepEqual(sources.citations.map((item) => item.url), ['https://cited.example/page']);
  assert.equal(sources.citations[0].snippet, 'cited snippet');
});

test('web activities merge process entries over the synced activity list without duplicates', () => {
  const search = { id: 's1', kind: 'search', status: 'complete', query: 'first', results: [] };
  const fetch = { id: 'f1', kind: 'fetch', status: 'complete', url: 'https://a.example', urls: ['https://a.example'] };
  const merged = webActivitiesOf({
    activities: [search, fetch],
    process: [
      { id: 't1', kind: 'thinking', content: 'thinking', status: 'complete' },
      { id: 's1', kind: 'search', status: 'running', query: 'second', results: [] },
    ],
  });
  assert.deepEqual(merged.map((activity) => `${activity.id}:${activity.status}`), ['s1:running', 'f1:complete']);
});
