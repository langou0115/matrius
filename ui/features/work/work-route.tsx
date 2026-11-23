import { useLayoutEffect, useEffect } from 'react';
import { router } from '@/router';

import { Dialog } from '@/components/web/dialog';
import { APP_TITLE, conversationDocumentTitle } from '@/features/chat/document-title';
import { useLocationPathname } from '@/features/chat/location-pathname';
import { useIsPreview } from '@/features/workspace/preview-context';
import { workHref, workProjectIdIn } from './work-href';
import { selectWorkProjectFromRoute, useWorkState } from './work-state';
import { WorkWorkspace } from './work-workspace';

export function useWorkProjectRouteState(id: string | null, preview: boolean) {
  const { projects, projectsLoaded, projectsError } = useWorkState();
  const ready = preview || projectsLoaded;
  const exists = id === null
    || (!preview && (!projectsLoaded || Boolean(projectsError)))
    || projects.some((project) => project.id === id);

  useLayoutEffect(() => {
    if (!id) return;
    if (exists) {
      selectWorkProjectFromRoute(id);
    }
  }, [id, exists]);

  return { exists, ready };
}

export default function WorkRoute() {
  const pathname = useLocationPathname();
  const preview = useIsPreview();
  const normalizedPathname = pathname.replace(/\/+$/, '') || '/';
  const isBareWork = normalizedPathname === workHref(null, preview);
  const id = workProjectIdIn(pathname, preview);
  const onWorkRoute = isBareWork || id !== null;
  const { exists, ready } = useWorkProjectRouteState(id, preview);
  const { projects, activeProjectId } = useWorkState();
  const activeProject = id
    ? projects.find((project) => project.id === id)
    : undefined;
  const title = conversationDocumentTitle(activeProject?.name);

  useEffect(() => {
    if (onWorkRoute) document.title = title;
  }, [onWorkRoute, title]);
  useEffect(() => () => {
    document.title = APP_TITLE;
  }, []);

  // Replace bare `/work` with `/p/<activeProjectId>` once projects finish loading so
  // the browser URL always identifies the active project without adding a bounce entry.
  // Only match the bare work route itself so leaving `/p/<id>` for `/settings` or `/c/<id>`
  // never triggers a bounce back before this route unmounts.
  useLayoutEffect(() => {
    if (!isBareWork || !ready || !activeProjectId) return;
    router.replace(workHref(activeProjectId, preview));
  }, [isBareWork, ready, activeProjectId, preview]);

  if (!exists) {
    const fallbackProjectId = activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : (projects[0]?.id ?? null);
    const fallbackHref = workHref(fallbackProjectId, preview);
    return (
      <Dialog
        title="项目不存在"
        className="compact-dialog"
        onClose={() => router.replace(fallbackHref)}
      >
        <p className="dialog-description" role="alert">当前工作区中没有这个项目，可能已移除。</p>
        <footer className="dialog-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={() => router.replace(fallbackHref)}
          >
            返回工作区
          </button>
        </footer>
      </Dialog>
    );
  }

  if (!ready) return null;
  return <WorkWorkspace />;
}
