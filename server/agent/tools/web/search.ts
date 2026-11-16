import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Static } from 'typebox';

import type { WebSearchResult } from '../../../../contract/agent-protocol';
import { AppError } from '../../../errors';
import { canonicalResultKey } from '../../../services/search';
import type { ToolModule } from '../types';
import {
  getWebActivityEnd,
  getWebActivityStart,
  WEB_SEARCH_TOOL_NAME,
} from './activity';
import { webToolsSystemPrompt } from './prompt';
import { webSearchParameters } from './schema';

type Params = Static<typeof webSearchParameters>;
type Details = {
  kind: 'search';
  query: string;
  queries: string[];
  results: WebSearchResult[];
  tookMs: number;
};

const DEFAULT_SEARCH_LIMIT = 30;
const MAX_SEARCH_QUERIES_PER_CALL = 4;

function describeToolError(reason: unknown): Error {
  if (reason instanceof AppError) return new Error(reason.message);
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return new Error('请求已取消。');
    const message = reason.message.replace(/\s+/gu, ' ').trim().slice(0, 500);
    if (message) return new Error(message);
  }
  return new Error('联网工具暂时不可用，请稍后重试。');
}

function searchResultText(queries: string[], results: WebSearchResult[]): string {
  const query = queries.join(' / ');
  if (!results.length) {
    return `No web results found for: ${query}. This does not prove the subject does not exist; say the evidence is insufficient instead of inventing an answer.`;
  }
  const blocks = results.map((result, index) => [
    `[${index + 1}] ${result.title}`,
    `URL: ${result.url}`,
    result.domain ? `Source: ${result.domain}${result.engine ? ` (${result.engine})` : ''}` : '',
    result.snippet ? `Snippet: ${result.snippet}` : '',
  ].filter(Boolean).join('\n'));
  return [`Web search results for: ${query}`, ...blocks].join('\n\n');
}

function createWebSearchTool(context: Parameters<ToolModule['create']>[0]): AgentTool<typeof webSearchParameters, Details> {
  const services = context.services;
  if (!services) throw new Error('联网工具不可用。');
  const previousUrls = new Set<string>();

  return {
    name: WEB_SEARCH_TOOL_NAME,
    label: 'Web search',
    description:
      'Search the web for current or externally verifiable information. Put the first pass’s 1–4 specific queries in one call: entity plus version, event, or release/changelog/news terms; avoid generic words and near-identical paraphrases. For official updates, the result set may include the product’s own news or changelog pages marked (official). After searching, read the 1–3 most relevant URLs in one web_fetch batch; do not alternate search and fetch for angles you can already foresee. Empty or failed results mean the evidence is insufficient, not that the subject does not exist.',
    parameters: webSearchParameters,
    execute: async (_toolCallId, params: Params, signal) => {
      const rawQueries = params.queries ?? (params.query ? [params.query] : []);
      if ((params.query && params.queries) || rawQueries.length === 0 || rawQueries.length > MAX_SEARCH_QUERIES_PER_CALL) {
        throw new Error('请提供 query，或 1–4 个 queries。');
      }
      const queries = [...new Set(rawQueries.map((query) => query.trim()).filter(Boolean))];
      if (!queries.length) throw new Error('搜索关键词不能为空。');

      const startedAt = Date.now();
      let results: WebSearchResult[];
      try {
        results = await services.search.searchMany(queries, DEFAULT_SEARCH_LIMIT, {
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw describeToolError(error);
      }
      const resultKeys = results.map((result) => {
        try {
          return canonicalResultKey(result.url);
        } catch {
          return result.url;
        }
      });
      const repeated = previousUrls.size > 0
        && resultKeys.length > 0
        && resultKeys.filter((key) => previousUrls.has(key)).length / resultKeys.length >= 0.8;
      for (const key of resultKeys) previousUrls.add(key);
      const hasOfficial = results.some((result) => result.engine.split(',').includes('official'));
      const nextStep = repeated
        ? 'These results are nearly identical to your previous search. Do not search again; fetch one of these URLs or answer with the evidence you already have.'
        : 'These are candidate URLs. Pick the 1–3 most relevant and read them together in one web_fetch call. Search again only if none of these results is relevant or the pages failed to load.';
      const officialNote = hasOfficial
        ? ' Pages marked (official) are the product’s own news or changelog; prefer them for official-update questions.'
        : '';
      const details: Details = {
        kind: 'search',
        query: queries[0],
        queries,
        results,
        tookMs: Math.max(0, Date.now() - startedAt),
      };
      return {
        content: [{
          type: 'text',
          text: `${searchResultText(queries, results)}\n\n${nextStep}${officialNote}`,
        }],
        details,
      };
    },
  };
}

export const webSearchTool: ToolModule = {
  id: WEB_SEARCH_TOOL_NAME,
  prompt: webToolsSystemPrompt(),
  activity: {
    start: (toolCallId, args) => getWebActivityStart(WEB_SEARCH_TOOL_NAME, toolCallId, args),
    end: (toolCallId, result, isError, previous) => getWebActivityEnd(
      WEB_SEARCH_TOOL_NAME,
      toolCallId,
      result,
      isError,
      previous,
    ),
  },
  create: (context) => createWebSearchTool(context),
};
