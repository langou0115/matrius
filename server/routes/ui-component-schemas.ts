import { z } from 'zod';

import {
  UI_COMPONENT_MAX_HTML_CHARS,
  UI_COMPONENT_MAX_STATE_CHARS,
  jsonSize,
} from '../../contract/ui-component';

export const componentIdSchema = z.uuid();
export const bindingIdSchema = z.uuid();
export const commandIdSchema = z.uuid();

export const listComponentsQuerySchema = z.object({
  q: z.string().max(200).optional(),
});

export const createComponentSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2_000).optional(),
  stateful: z.boolean().default(false),
});

export const patchComponentSchema = z.object({
  baseRevision: z.number().int().min(1),
  name: z.string().max(200).optional(),
  description: z.string().max(2_000).optional(),
});

export const baseRevisionQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1),
});

export const publishComponentSchema = z.object({
  version: z.number().int().min(1).max(100_000),
  baseRevision: z.number().int().min(1),
});

export const versionParamSchema = z.coerce.number().int().min(1).max(100_000);

const stateSchema = z.unknown().refine((value) => jsonSize(value) <= UI_COMPONENT_MAX_STATE_CHARS, {
  message: '组件状态超出体积上限。',
});

export const bindingStateSchema = z.object({
  state: stateSchema,
  baseRevision: z.number().int().min(1),
});

export const commandResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2_000).optional(),
  state: stateSchema.optional(),
  baseRevision: z.number().int().min(1).optional(),
});

/** The HTML guard is repeated here so an oversized body fails before the service. */
export const htmlGuardSchema = z.string().max(UI_COMPONENT_MAX_HTML_CHARS);
