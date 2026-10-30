import { Redirect } from 'expo-router';
import { lazy, Suspense } from 'react';

const Preview = __DEV__ ? lazy(() => import('@/features/mock/storage-preview.web')) : null;

export default function StoragePreviewRoute() {
  return Preview ? <Suspense fallback={null}><Preview /></Suspense> : <Redirect href="/" />;
}
