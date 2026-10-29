/** A same-account API caller: JSON in, JSON out, with the session's auth already applied. */
export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
