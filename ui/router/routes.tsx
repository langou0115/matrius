import { lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/web/app-shell';
import { useMobile } from '@/components/web/use-mobile';
import { isDesktopTarget } from '@/core/platform/target';
import ChatRoute from '@/features/chat/chat-route';
import AppearanceRedirect from '@/features/settings/appearance-redirect';
import SettingsRootRedirect from '@/features/settings/settings-root-redirect';

/**
 * Every screen is loaded on demand except the chat page, so the first paint only
 * carries the shell and the conversation view. Paths mirror the address bar exactly;
 * `/debug` and `/mock/*` exist only during development.
 */
const LibraryScreen = lazy(() => import('@/features/files/library-screen'));
const TasksScreen = lazy(() => import('@/features/tasks/tasks-screen'));
const StorageScreen = lazy(() => import('@/features/files/storage-screen'));
const ModelSettingsScreen = lazy(() => import('@/features/models/model-settings-screen'));
const WorkGeneralScreen = lazy(() => import('@/features/work/work-general-screen'));
const HostSettingsScreen = lazy(() => import('@/features/hosts/host-settings-screen'));
const PersonalizationScreen = lazy(() => import('@/features/settings/personalization-screen'));
const UsageScreen = lazy(() => import('@/features/usage/usage-screen'));
const DebugScreen = lazy(() => import('@/features/debug/debug-screen'));
const ProcessPreview = lazy(() => import('@/features/mock/process-preview'));
const StoragePreview = lazy(() => import('@/features/mock/storage-preview'));
const IntelligentUiPreview = lazy(() => import('@/features/mock/intelligent-ui-preview'));

const AboutScreen = lazy(() => import('@/features/settings/settings-detail-screen')
  .then((module) => ({ default: module.AboutSettingsScreen })));
const AppearanceScreen = lazy(() => import('@/features/settings/settings-detail-screen')
  .then((module) => ({ default: module.AppearanceSettingsScreen })));

/** Development-only routes; a production build redirects them back to `/`. */
function DevOnly({ children }: { children: ReactNode }) {
  return import.meta.env.DEV ? <>{children}</> : <Navigate to="/" replace />;
}

/** Desktop-only routes stay inaccessible on Web builds and mobile viewports. */
function DesktopOnly({ children }: { children: ReactNode }) {
  const mobile = useMobile();
  return isDesktopTarget() && !mobile ? <>{children}</> : <Navigate to="/settings" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ChatRoute />} />
        <Route path="c/:conversationId" element={<ChatRoute />} />
        <Route path="library" element={<LibraryScreen />} />
        <Route path="tasks" element={<TasksScreen />} />

        <Route path="settings" element={<SettingsRootRedirect />} />
        <Route path="settings/appearance" element={<AppearanceScreen />} />
        <Route path="settings/theme" element={<AppearanceRedirect />} />
        <Route path="settings/display" element={<AppearanceRedirect />} />
        <Route path="settings/models" element={<ModelSettingsScreen />} />
        <Route path="settings/work-general" element={<DesktopOnly><WorkGeneralScreen /></DesktopOnly>} />
        <Route path="settings/hosts" element={<DesktopOnly><HostSettingsScreen /></DesktopOnly>} />
        <Route path="settings/personalization" element={<PersonalizationScreen />} />
        <Route path="settings/storage" element={<StorageScreen />} />
        <Route path="settings/usage" element={<UsageScreen />} />
        <Route path="settings/about" element={<AboutScreen />} />

        <Route path="debug" element={<DevOnly><DebugScreen /></DevOnly>} />
        <Route path="debug/mock" element={<DevOnly><DebugScreen /></DevOnly>} />
        <Route path="debug/mock/intelligent-ui" element={<DevOnly><IntelligentUiPreview /></DevOnly>} />
        <Route path="mock/chat" element={<DevOnly><ChatRoute /></DevOnly>} />
        <Route path="mock/chat/c/:conversationId" element={<DevOnly><ChatRoute /></DevOnly>} />
        <Route path="mock/chat/settings" element={<DevOnly><SettingsRootRedirect /></DevOnly>} />
        <Route path="mock/chat/settings/appearance" element={<DevOnly><AppearanceScreen /></DevOnly>} />
        <Route path="mock/chat/settings/theme" element={<DevOnly><AppearanceRedirect /></DevOnly>} />
        <Route path="mock/chat/settings/display" element={<DevOnly><AppearanceRedirect /></DevOnly>} />
        <Route path="mock/chat/settings/models" element={<DevOnly><ModelSettingsScreen /></DevOnly>} />
        <Route path="mock/chat/settings/work-general" element={<DevOnly><DesktopOnly><WorkGeneralScreen /></DesktopOnly></DevOnly>} />
        <Route path="mock/chat/settings/hosts" element={<DevOnly><DesktopOnly><HostSettingsScreen /></DesktopOnly></DevOnly>} />
        <Route path="mock/chat/settings/personalization" element={<DevOnly><PersonalizationScreen /></DevOnly>} />
        <Route path="mock/chat/settings/about" element={<DevOnly><AboutScreen /></DevOnly>} />
        <Route path="mock/library" element={<DevOnly><LibraryScreen /></DevOnly>} />
        <Route path="mock/tasks" element={<DevOnly><TasksScreen /></DevOnly>} />
        <Route path="mock/process" element={<DevOnly><ProcessPreview /></DevOnly>} />
        <Route path="mock/storage" element={<DevOnly><StoragePreview /></DevOnly>} />
        <Route path="mock/intelligent-ui" element={<DevOnly><IntelligentUiPreview /></DevOnly>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
