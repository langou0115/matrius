// Pinned pi 0.73.1 helpers used by pi-agent-core. Avoid the umbrella entry's
// Node-only imports under Metro; actual requests use runner's explicit streamFn.
export { EventStream } from '../../../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js';
export { parseStreamingJson } from '../../../node_modules/@mariozechner/pi-ai/dist/utils/json-parse.js';
export { validateToolArguments } from '../../../node_modules/@mariozechner/pi-ai/dist/utils/validation.js';

export function streamSimple(): never {
  throw new Error('Matrius requires an explicit provider stream function.');
}
