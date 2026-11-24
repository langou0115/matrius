import { register } from 'node:module';
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';
register('./typescript-loader.mjs', import.meta.url);
