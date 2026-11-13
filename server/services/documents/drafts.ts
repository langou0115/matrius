import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Settings } from '../../config';
import { AppError } from '../../errors';

export const DRAFT_PREFIX = 'draft:';

export type Draft = {
  id: string;
  instanceId: number;
  conversationId: string | null;
  filename: string;
  contentType: string;
  path: string;
  size: number;
  baseFileId: string | null;
  baseRevision: number | null;
  convertedFromLegacy: boolean;
  createdAt: number;
  updatedAt: number;
};

export type DraftSummary = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  conversationId: string | null;
  createdAt: number;
};

export class DraftStore {
  private readonly root: string;
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly settings: Settings) {
    this.root = join(settings.dataDir, 'drafts');
  }

  async resetOnStartup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    this.drafts.clear();
  }

  async put(input: {
    instanceId: number;
    conversationId: string | null;
    filename: string;
    contentType: string;
    data: Uint8Array;
    baseFileId?: string | null;
    baseRevision?: number | null;
    convertedFromLegacy?: boolean;
    draftId?: string | null;
  }): Promise<Draft> {
    await this.sweep();
    if (input.data.length > this.settings.MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'file_too_large', '生成的文档不能超过 20 MiB。');
    }
    if (!input.data.length) throw new AppError(422, 'invalid_document_operation', '生成的文档为空。');

    let draftId = input.draftId ?? `${DRAFT_PREFIX}${randomUUID()}`;
    const previous = this.drafts.get(draftId);
    if (input.draftId) {
      if (!previous || previous.instanceId !== input.instanceId) {
        throw new AppError(404, 'draft_not_found', '草稿不存在或已过期。');
      }
    }

    const others = [...this.drafts.values()]
      .filter((draft) => draft.id !== draftId && draft.instanceId === input.instanceId);
    if (others.length >= this.settings.DOCUMENT_DRAFT_MAX_COUNT) {
      throw new AppError(429, 'draft_limit_exceeded', '草稿数量已达上限，请先保存或删除草稿。');
    }
    const used = others.reduce((total, draft) => total + draft.size, 0);
    if (used + input.data.length > this.settings.DOCUMENT_DRAFT_MAX_BYTES) {
      throw new AppError(429, 'draft_limit_exceeded', '草稿占用空间已达上限，请先保存。');
    }

    const target = join(this.root, draftId.slice(DRAFT_PREFIX.length), 'document');
    await mkdir(join(this.root, draftId.slice(DRAFT_PREFIX.length)), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, input.data);
    await rename(temporary, target);

    const now = Date.now();
    const draft: Draft = {
      id: draftId,
      instanceId: input.instanceId,
      conversationId: input.conversationId,
      filename: input.filename,
      contentType: input.contentType,
      path: target,
      size: input.data.length,
      baseFileId: input.baseFileId ?? null,
      baseRevision: input.baseRevision ?? null,
      convertedFromLegacy: input.convertedFromLegacy ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.drafts.set(draftId, draft);
    return draft;
  }

  async get(instanceId: number, draftId: string): Promise<Draft> {
    await this.sweep();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.instanceId !== instanceId) {
      throw new AppError(404, 'draft_not_found', '草稿不存在或已过期。');
    }
    draft.updatedAt = Date.now();
    return draft;
  }

  async read(draft: Draft): Promise<Buffer> {
    try {
      return await readFile(draft.path);
    } catch {
      await this.delete(draft.instanceId, draft.id);
      throw new AppError(404, 'draft_not_found', '草稿不存在或已过期。');
    }
  }

  async delete(instanceId: number, draftId: string): Promise<void> {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.instanceId !== instanceId) return;
    this.drafts.delete(draftId);
    await rm(join(this.root, draftId.slice(DRAFT_PREFIX.length)), { recursive: true, force: true });
  }

  async listForInstance(instanceId: number, conversationId: string | null = null): Promise<Draft[]> {
    await this.sweep();
    return [...this.drafts.values()]
      .filter((draft) => draft.instanceId === instanceId
        && (conversationId === null || draft.conversationId === conversationId))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  summary(draft: Draft): DraftSummary {
    return {
      id: draft.id,
      filename: draft.filename,
      contentType: draft.contentType,
      size: draft.size,
      conversationId: draft.conversationId,
      createdAt: draft.createdAt,
    };
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.settings.DOCUMENT_DRAFT_TTL_SECONDS * 1000;
    for (const draft of [...this.drafts.values()]) {
      if (draft.updatedAt > cutoff) continue;
      this.drafts.delete(draft.id);
      await rm(join(this.root, draft.id.slice(DRAFT_PREFIX.length)), { recursive: true, force: true });
    }
  }
}
