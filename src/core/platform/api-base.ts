import Constants from 'expo-constants';

const DEFAULT_PORT = '8000';

/** Production builds provide `EXPO_PUBLIC_API_BASE_URL`; in development the Expo dev server
    already knows the host the phone can reach, so reuse it with the backend port. */
export function apiBaseUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split('/')[0]?.split(':')[0];
  if (host) return `http://${host}:${process.env.EXPO_PUBLIC_API_PORT?.trim() || DEFAULT_PORT}`;
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}
