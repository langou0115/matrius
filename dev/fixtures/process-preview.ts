import type { WebActivity } from '../../agent/src/core/types';

const url = 'https://docs.python.org/3/library/asyncio-task.html';
export const processReasoning = '先确认 TaskGroup 的行为，再查阅官方文档核实异常处理和任务取消的边界。\n\n重点是区分正常等待任务完成与某个任务失败后的处理，避免把这两种情况混在一起。';
export const processAnswer = '使用 `asyncio.TaskGroup` 可以把相关任务放在同一个上下文中管理。退出上下文前，会等待这些任务结束。\n\n具体行为可查看 [Python 官方文档](https://docs.python.org/3/library/asyncio-task.html)。';
export const processActivities: WebActivity[] = [
  { id: 'search', kind: 'search', status: 'complete', query: 'Python asyncio TaskGroup documentation', tookMs: 620,
    results: [{ title: 'Coroutines and Tasks — Python documentation', url, domain: 'docs.python.org',
      snippet: 'Task groups combine a task creation API with a reliable way to wait for tasks.', engine: 'duckduckgo', rank: 1 }] },
  { id: 'fetch', kind: 'fetch', status: 'complete', url, urls: [url], title: 'Coroutines and Tasks', tookMs: 430 },
];
