import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Static } from 'typebox';

import type { WebSearchResult } from '../../../contract/agent-protocol';
import { AppError } from '../../errors';
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

const MAX_SEARCH_CALLS_PER_RUN = 6;
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
  let searchCalls = 0;

  return {
    name: WEB_SEARCH_TOOL_NAME,
    label: 'Web search',
    description:
      'Search the web for current or externally verifiable information. Prefer searching over answering from memory whenever facts may have changed or the user asks you to look up, verify or find sources; answer directly only for simple tasks that need no outside facts. Respect an explicit request not to browse. Keep the exact subject, entity names, locations and stated dates; do not guess an answer or broaden to unrelated topics, and never repeat near-identical queries. Write software, product, release, science and international-news queries in English and keep official names and versions verbatim; write Chinese local policy, place and China-specific queries in Chinese. If you need several angles, languages or facets, put up to four queries in the queries array in one call instead of repeating web_search. Snippets are leads, not verified facts: read the most relevant pages before citing details, but do not try to verify every claim separately. Empty or failed results mean the evidence is insufficient, not that the subject does not exist. Usually one search is enough; search again only when the results are clearly off-topic or a distinct sub-question is still missing.',
    parameters: webSearchParameters,
    execute: async (_toolCallId, params: Params, signal) => {
      const rawQueries = params.queries ?? (params.query ? [params.query] : []);
      if ((params.query && params.queries) || rawQueries.length === 0 || rawQueries.length > MAX_SEARCH_QUERIES_PER_CALL) {
        throw new Error('请提供 query，或 1–4 个 queries。');
      }
      const queries = [...new Set(rawQueries.map((query) => query.trim()).filter(Boolean))];
      if (!queries.length) throw new Error('搜索关键词不能为空。');
      if (searchCalls >= MAX_SEARCH_CALLS_PER_RUN) {
        throw new Error('本轮搜索次数已达上限。只依据已有证据作答；无法核实的部分请明确说明。');
      }
      searchCalls += 1;

      const startedAt = Date.now();
      let results: WebSearchResult[];
      try {
        results = await services.search.searchMany(queries, DEFAULT_SEARCH_LIMIT, {
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw describeToolError(error);
      }
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
          text: `${searchResultText(queries, results)}\n\nSearch results are leads, not verified facts. If they already answer the question, stop searching and answer; search again only when a distinct part of the question is still missing. When you do need page details, read the most relevant pages in one web_fetch call.`,
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
