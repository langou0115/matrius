import type { AgentTool } from '@mariozechner/pi-agent-core';

import type { FeatureId, ToolActivityAdapter, ToolContext, ToolModule } from './types';

/**
 * Ordered tool registry.
 *
 * Registration order is the order tools are offered to the model, so put the
 * most useful tool first. Feature-gated modules are filtered per run; an empty
 * feature set is the text-only mode. Keep this class free of concrete tool
 * imports: `server/tools/index.ts` owns the built-in list.
 */
export class ToolRegistry {
  private readonly modules = new Map<string, ToolModule>();

  constructor(modules: readonly ToolModule[] = []) {
    for (const module of modules) this.register(module);
  }

  register(module: ToolModule): this {
    if (!module.id.trim()) throw new Error('A tool module needs a non-empty id.');
    if (this.modules.has(module.id)) throw new Error(`Duplicate tool module: ${module.id}`);
    this.modules.set(module.id, module);
    return this;
  }

  get(id: string): ToolModule | undefined {
    return this.modules.get(id);
  }

  list(): ToolModule[] {
    return [...this.modules.values()];
  }

  enabled(features: ReadonlySet<FeatureId>): ToolModule[] {
    return this.list().filter((module) => !module.feature || features.has(module.feature));
  }

  createTools(context: ToolContext): AgentTool[] {
    return this.enabled(context.features).map((module) => module.create(context));
  }

  prompts(features: ReadonlySet<FeatureId>): string[] {
    return this.enabled(features)
      .map((module) => module.prompt?.trim())
      .filter((prompt): prompt is string => Boolean(prompt));
  }

  activityFor(toolName: string): ToolActivityAdapter | undefined {
    return this.modules.get(toolName)?.activity;
  }

  get size(): number {
    return this.modules.size;
  }
}
