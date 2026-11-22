import { LOCAL_WORK_HOST_ID } from '@contract/work-projects';
import { useCallback, useEffect } from 'react';

import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { saveWorkFile } from './work-api';
import { getWorkState, isFileDraftDirty, setWorkFileDraft, useWorkState } from './work-state';

export function useWorkFileSave() {
  const { request } = useInstance();
  const preview = useIsPreview();
  const { editorAutoSave, fileTabsByProject } = useWorkState();

  const save = useCallback(async (projectId: string, path: string) => {
    const { projects, fileTabsByProject } = getWorkState();
    const draft = fileTabsByProject[projectId]?.drafts.get(path);
    if (projects.find((project) => project.id === projectId)?.hostId !== LOCAL_WORK_HOST_ID
      || !draft || draft.saving || draft.composing || !isFileDraftDirty(draft)) return;

    const pending = { ...draft, saving: true, error: undefined };
    setWorkFileDraft(projectId, path, pending, draft);
    const currentPending = () => {
      const current = getWorkState().fileTabsByProject[projectId]?.drafts.get(path);
      return current?.saving && current.base === draft.base ? current : undefined;
    };

    try {
      const lineEnding = draft.base.text.includes('\r\n') && !/(?<!\r)\n/u.test(draft.base.text)
        ? '\r\n'
        : '\n';
      const text = draft.text.replace(/\n/gu, lineEnding);
      const base = preview ? { text, revision: 'demo' } : await saveWorkFile(
        request, projectId, { path, text, baseRevision: draft.base.revision },
      );
      const current = currentPending();
      if (current) setWorkFileDraft(projectId, path, { ...current, base, saving: false }, current);
    } catch (reason) {
      const current = currentPending();
      if (current) {
        const error = reason instanceof Error ? reason.message : '保存文件失败。';
        setWorkFileDraft(projectId, path, { ...current, saving: false, error }, current);
      }
    }
  }, [preview, request]);

  useEffect(() => {
    if (!editorAutoSave) return;
    const files = Object.entries(fileTabsByProject).flatMap(([projectId, tabs]) =>
      [...tabs.drafts].flatMap(([path, draft]) =>
        !draft.saving && !draft.composing && !draft.error && isFileDraftDirty(draft) ? [{ projectId, path }] : [],
      ),
    );
    if (!files.length) return;
    const timer = window.setTimeout(() => {
      for (const { projectId, path } of files) void save(projectId, path);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [editorAutoSave, fileTabsByProject, save]);

  return save;
}
