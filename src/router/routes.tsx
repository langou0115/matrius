import { lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/web/app-shell';
import ChatRoute from '@/features/chat/chat-route';
import AppearanceRedirect from '@/features/settings/appearance-redirect';
import SettingsRootRedirect from '@/features/settings/settings-root-redirect';

/**
 * Every screen is loaded on demand except the chat page, so the first paint only
 * carries the shell and the conversation view. Paths mirror the address bar exactly;
 * `/mock/*` renders the same screens with local preview data during development.
 */
const AdminScreen = lazy(() => import('@/features/admin/admin-screen'));
const LibraryScreen = lazy(() => import('@/features/files/library-screen'));
const StorageScreen = lazy(() => import('@/features/files/storage-screen'));
const AccountScreen = lazy(() => import('@/features/auth/account-screen'));
const ModelSettingsScreen = lazy(() => import('@/features/models/model-settings-screen'));
const PersonalizationScreen = lazy(() => import('@/features/settings/personalization-screen'));
const UsageScreen = lazy(() => import('@/features/usage/usage-screen'));
const MockIndexScreen = lazy(() => import('@/features/mock/mock-index-screen'));
const ProcessPreview = lazy(() => import('@/features/mock/process-preview'));
const StoragePreview = lazy(() => import('@/features/mock/storage-preview'));

const AboutScreen = lazy(() => import('@/features/settings/settings-detail-screen')
  .then((module) => ({ default: module.AboutSettingsScreen })));
const AppearanceScreen = lazy(() => import('@/features/settings/settings-detail-screen')
  .then((module) => ({ default: module.AppearanceSettingsScreen })));

/** Preview routes exist only in development; a production build drops them entirely. */
function MockOnly({ children }: { children: ReactNode }) {
  return import.meta.env.DEV ? <>{children}</> : <Navigate to="/" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ChatRoute />} />
        <Route path="c/:conversationId" element={<ChatRoute />} />
        <Route path="library" element={<LibraryScreen />} />
        <Route path="admin" element={<AdminScreen />} />

        <Route path="settings" element={<SettingsRootRedirect />} />
        <Route path="settings/appearance" element={<AppearanceScreen />} />
        <Route path="settings/theme" element={<AppearanceRedirect />} />
        <Route path="settings/display" element={<AppearanceRedirect />} />
        <Route path="settings/models" element={<ModelSettingsScreen />} />
        <Route path="settings/personalization" element={<PersonalizationScreen />} />
        <Route path="settings/account" element={<AccountScreen />} />
        <Route path="settings/storage" element={<StorageScreen />} />
        <Route path="settings/usage" element={<UsageScreen />} />
        <Route path="settings/about" element={<AboutScreen />} />

        <Route path="mock" element={<MockOnly><MockIndexScreen /></MockOnly>} />
        <Route path="mock/chat" element={<MockOnly><ChatRoute /></MockOnly>} />
        <Route path="mock/chat/c/:conversationId" element={<MockOnly><ChatRoute /></MockOnly>} />
        <Route path="mock/chat/settings" element={<MockOnly><SettingsRootRedirect /></MockOnly>} />
        <Route path="mock/chat/settings/appearance" element={<MockOnly><AppearanceScreen /></MockOnly>} />
        <Route path="mock/chat/settings/theme" element={<MockOnly><AppearanceRedirect /></MockOnly>} />
        <Route path="mock/chat/settings/display" element={<MockOnly><AppearanceRedirect /></MockOnly>} />
        <Route path="mock/chat/settings/models" element={<MockOnly><ModelSettingsScreen /></MockOnly>} />
        <Route path="mock/chat/settings/personalization" element={<MockOnly><PersonalizationScreen /></MockOnly>} />
        <Route path="mock/chat/settings/about" element={<MockOnly><AboutScreen /></MockOnly>} />
        <Route path="mock/library" element={<MockOnly><LibraryScreen /></MockOnly>} />
        <Route path="mock/process" element={<MockOnly><ProcessPreview /></MockOnly>} />
        <Route path="mock/storage" element={<MockOnly><StoragePreview /></MockOnly>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
