# Server services

Services own business logic and external I/O. Routes and tools should be thin
wrappers around them.

| Service | Responsibility | Status |
| --- | --- | --- |
| `storage.ts` | `DATA_DIR/files` object storage, atomic writes, disk usage | implemented |
| `cache.ts` | in-process TTL cache, sliding-window limits, in-flight caps | implemented |
| `file-types.ts` | upload allow-list, safe filenames, content types | implemented |
| `usage-estimate.ts` | historical token estimate | implemented |
| `search.ts` | DuckDuckGo HTML + Bing RSS fallback, dedupe/rank/cache | implemented |
| `fetch/` | SSRF validation, redirects, MIME sniffing, HTML extraction | implemented |
| `documents/extract.ts` | docx/xlsx/pptx/PDF text extraction | implemented |
| `documents/file-service.ts` | file list/read/grep and extraction cache | implemented |
| `documents/officecli.ts` | OfficeCLI process wrapper, create/edit/help/inspect | implemented |
| `documents/drafts.ts` | draft store and save flow | implemented |
| `documents/service.ts` | unified document tool dispatch | implemented |
| `documents/pdf.ts` | PDF inspect and editing with `pdf-lib`/`unpdf` | implemented |
| `documents/converter.ts` | legacy Office conversion via LibreOffice kit | implemented |
| `workspace-import.ts` | idempotent browser workspace merge and tombstones | implemented |

## Rules

- Services must not import `ui/`, React or Fastify request objects.
- Pass explicit inputs (`dataDir`, `instanceId`, `signal`) instead of reading a
  global request context.
- External calls must accept an `AbortSignal` and enforce their own deadline.
- Long CPU work (PDF parsing, Office text extraction) belongs in a worker or a
  child process, not on the Fastify event loop.
- Never log file contents, API keys or full provider URLs.
