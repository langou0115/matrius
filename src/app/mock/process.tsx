import { Redirect } from 'expo-router';
import { lazy, Suspense } from 'react';

const Preview = __DEV__ ? lazy(() => import('@/features/mock/process-preview.web')) : null;

export default function ProcessPreviewRoute() {
  return Preview ? <Suspense fallback={null}><Preview /></Suspense> : <Redirect href="/" />;
}
