# Server routes

Each area exports `register<Area>Routes(app, deps)`. `server/app.ts` is the only
place that assembles them.

```ts
export function registerConversationRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get('/api/conversations', async (request, reply) => { ... });
}
```

## Rules

- Validate request bodies with a zod schema; throw `validationError(details)` or
  let the app error handler map `ZodError` to the stable 422 envelope.
- Use `notFound`, `conflict` and `invalid` from `server/errors.ts`; do not build
  ad-hoc `{ error: ... }` objects in routes.
- Keep SQL in `server/db/repositories/`; routes call repositories/services.
- Apply the shared rate limits (`cache.enforceRateLimit`) and, for expensive
  work, the in-flight cap (`cache.withConcurrency`).
- Return API timestamps as epoch milliseconds; database codecs own the storage
  format.
- Add a `server/tests/<area>.test.ts` using `app.inject()`; do not bind a port
  unless the test specifically exercises streaming.
