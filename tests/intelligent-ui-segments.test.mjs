import assert from 'node:assert/strict';
import test from 'node:test';

import { splitReplyUiSegments, stripUiBlockMarkers } from '../contract/intelligent-ui.ts';

const weatherBlock = {
  id: 'weather-1',
  kind: 'weather',
  data: {
    location: '北京',
    condition: 'sunny',
    conditionLabel: '晴',
    temperatureC: 18,
    highC: 21,
    lowC: 9,
  },
};

const askBlock = {
  id: 'ask-1',
  kind: 'ask_question',
  data: {
    id: 'ask-1',
    questions: [{ id: 'q1', prompt: '偏好方式', type: 'single', options: [{ id: 'a', label: 'A' }] }],
  },
};

test('splitReplyUiSegments places UI blocks at start, middle, or end based on markers', () => {
  const startSegments = splitReplyUiSegments('[[ui:weather-1]]\n\n记得带防晒。', [weatherBlock]);
  assert.deepEqual(startSegments.map((item) => item.kind), ['block', 'text']);

  const middleSegments = splitReplyUiSegments(
    '先看看今天天气：\n\n[[ui:weather-1]]\n\n接下来请确认行程：\n\n[[ui:ask-1]]',
    [weatherBlock, askBlock],
  );
  assert.deepEqual(
    middleSegments.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['先看看今天天气：', 'weather-1', '接下来请确认行程：', 'ask-1'],
  );

  const endSegments = splitReplyUiSegments('以下是分析总结。\n\n[[ui:ask-1]]', [askBlock]);
  assert.deepEqual(
    endSegments.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['以下是分析总结。', 'ask-1'],
  );
});

test('splitReplyUiSegments waits for inline markers while streaming and appends unplaced blocks on finish', () => {
  const beforeMarker = splitReplyUiSegments('正在整理天气：\n\n', [weatherBlock], { streaming: true });
  assert.deepEqual(
    beforeMarker.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['正在整理天气：'],
  );

  for (const partial of ['[[', '[[u', '[[ui', '[[ui:', '[[ui:weather-', '[[ui:weather-1]']) {
    const streamingPartial = splitReplyUiSegments(`正在整理天气：\n\n${partial}`, [weatherBlock], { streaming: true });
    assert.deepEqual(
      streamingPartial.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
      ['正在整理天气：'],
    );
  }

  const markerArrived = splitReplyUiSegments('正在整理天气：\n\n[[ui:weather-1]]', [weatherBlock], { streaming: true });
  assert.deepEqual(
    markerArrived.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['正在整理天气：', 'weather-1'],
  );

  const trailingText = splitReplyUiSegments('正在整理天气：\n\n[[ui:weather-1]]\n\n出门记得带伞。', [weatherBlock], { streaming: true });
  assert.deepEqual(
    trailingText.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['正在整理天气：', 'weather-1', '出门记得带伞。'],
  );

  const omittedFinished = splitReplyUiSegments('正在整理天气。', [weatherBlock], { streaming: false });
  assert.deepEqual(
    omittedFinished.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['正在整理天气。', 'weather-1'],
  );

  const nonLatest = splitReplyUiSegments('前文\n\n[[ui:ask-1]]\n\n后文', [askBlock], { isLatest: false });
  assert.deepEqual(
    nonLatest.map((item) => (item.kind === 'block' ? item.block.id : item.text)),
    ['前文\n\n后文'],
  );
});

test('stripUiBlockMarkers removes markers cleanly for copy and previews', () => {
  assert.equal(
    stripUiBlockMarkers('前文\n\n[[ui:weather-1]]\n\n后文\n\n[[ui:ask-1]]'),
    '前文\n\n后文',
  );
});
