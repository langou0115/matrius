import { fetch as expoFetch } from 'expo/fetch';

/** React Native's global fetch buffers the response. Provider SDKs stream through
    `response.body.getReader()`, which `expo/fetch` implements. Import for this side effect
    before any provider module is evaluated. */
const target = globalThis as typeof globalThis & { fetch: typeof fetch };
if (target.fetch !== expoFetch) target.fetch = expoFetch as typeof fetch;
