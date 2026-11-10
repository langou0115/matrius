import { z } from 'zod';

export const uiSchemas = {
  comparisonTable: z.object({ title: z.string().max(300), columns: z.array(z.string().max(300)).min(1).max(8), rows: z.array(z.array(z.string().max(2000)).max(8)).max(50), note: z.string().max(2000).optional() }),
  keyValueCard: z.object({ title: z.string().max(300), items: z.array(z.object({ label: z.string().max(300), value: z.string().max(2000) })).min(1).max(12), note: z.string().max(2000).optional() }),
  stepsList: z.object({ title: z.string().max(300), steps: z.array(z.object({ title: z.string().max(300), detail: z.string().max(2000).optional() })).min(1).max(12) }),
  generateSandboxedUi: z.object({ initialHeight: z.number().int().min(160).max(1200), placeholderMessages: z.array(z.string().max(300)).max(5), css: z.string().max(50000), html: z.string().max(100000), jsFunctions: z.string().max(50000), jsExpressions: z.string().max(50000) }),
};
export type UiName = keyof typeof uiSchemas;
export type UiArtifact = { [K in UiName]: { id: string; name: K; props: z.infer<(typeof uiSchemas)[K]>; textOffset?: number; streaming?: boolean } }[UiName];

export function readUiArtifacts(value: unknown): UiArtifact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: UiArtifact[] = [];
  for (const item of value.slice(0, 12)) {
    if (!item || typeof item.id !== 'string' || item.id.length > 128 || !Object.hasOwn(uiSchemas, item.name)) continue;
    const parsed = uiSchemas[item.name as UiName].safeParse(item.props);
    if (parsed.success) result.push({ id: item.id, name: item.name, props: parsed.data,
      ...(Number.isInteger(item.textOffset) && item.textOffset >= 0 && item.textOffset <= 1000000 ? { textOffset: item.textOffset } : {}),
      ...(item.streaming === true ? { streaming: true } : {}),
    } as UiArtifact);
  }
  return result.length ? result : undefined;
}
