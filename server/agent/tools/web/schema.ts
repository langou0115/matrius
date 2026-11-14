import { Type } from 'typebox';

const MAX_SEARCH_QUERIES_PER_CALL = 4;
const MAX_FETCH_PAGES_PER_CALL = 10;

export const webSearchParameters = Type.Object({
  query: Type.Optional(Type.String({
    description: 'A single concise search query. Use this or queries, not both.',
    minLength: 1,
    maxLength: 500,
  })),
  queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    description: 'One to four related queries to search together in one call. Prefer this over repeated web_search calls for different angles, languages or facets. Use this or query, not both.',
    minItems: 1,
    maxItems: MAX_SEARCH_QUERIES_PER_CALL,
  })),
});

export const webFetchParameters = Type.Object({
  url: Type.Optional(Type.String({
    description: 'A single http or https page to read. Use this or urls, not both.',
    minLength: 1,
    maxLength: 2000,
  })),
  urls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
    description: 'One to ten different pages to fetch concurrently in one batch. Prefer this over separate single-page calls whenever the URLs are already known. Use this or url, not both.',
    minItems: 1,
    maxItems: MAX_FETCH_PAGES_PER_CALL,
  })),
  mode: Type.Optional(Type.Union([Type.Literal('fast'), Type.Literal('full')], {
    description: 'fast extracts the main article text; full favors recall and keeps the surrounding page text when the article body is sparse.',
  })),
});
