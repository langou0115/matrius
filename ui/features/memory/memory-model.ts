import type { ModelConfig } from '@/core/llm/model-config';
import type { useModels } from '@/features/models/model-state';

type ModelsApi = ReturnType<typeof useModels>;

/** Resolve the model used by the memory assistant. `memoryModelId` is a local, browser-only
    preference like `titleModelId`; when unset it follows the active conversation's model. */
export function pickMemoryModel(models: ModelsApi, conversationModelId?: string): ModelConfig | undefined {
  if (!models.ready) return undefined;
  const explicit = models.memoryModelId
    ? models.models.find((model) => model.id === models.memoryModelId)
    : undefined;
  if (explicit) return explicit;
  if (conversationModelId) {
    const bound = models.models.find((model) => model.id === conversationModelId);
    if (bound) return bound;
  }
  return models.selected;
}
