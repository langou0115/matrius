import { ApiError } from '@/core/api/auth-session';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Field = { value: string; revision: number };
const PATH = '/api/profile/fields/network-tools';
export const DEFAULT_NETWORK_TOOLS_ENABLED = true;

async function read(request: Request): Promise<Field | null> {
  try { return await request<Field>(PATH); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function loadNetworkToolsEnabled(request: Request): Promise<boolean> {
  const field = await read(request);
  if (!field) return DEFAULT_NETWORK_TOOLS_ENABLED;
  return field.value !== 'false';
}

export async function saveNetworkToolsEnabled(request: Request, enabled: boolean): Promise<void> {
  const field = await read(request);
  await request(PATH, { method: 'PUT', body: JSON.stringify({
    baseRevision: field?.revision ?? null, value: String(enabled), source: 'manual',
  }) });
}
