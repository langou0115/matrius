import { start } from './app';

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
