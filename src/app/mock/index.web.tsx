import { Redirect } from 'expo-router';
import { lazy, Suspense } from 'react';

const MockIndexScreen = __DEV__
  ? lazy(() => import('@/features/mock/mock-index-screen.web'))
  : null;

export default function MockIndexRoute() {
  if (!MockIndexScreen) return <Redirect href="/" />;
  return <Suspense fallback={null}><MockIndexScreen /></Suspense>;
}
