export type PersonalizationPreferences = { customInstructions: string; aboutName: string; occupation: string; aboutMore: string };

export const personalizationLimits = { customInstructions: 10000, aboutName: 100, occupation: 100, aboutMore: 4000 } as const;
export const defaultPersonalization: PersonalizationPreferences = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '' };

export function readPersonalization(value: unknown): PersonalizationPreferences {
  if (value === undefined) return { ...defaultPersonalization };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid personalization');
  const data = value as Record<string, unknown>;
  const result = { ...defaultPersonalization };
  for (const key of Object.keys(personalizationLimits) as (keyof PersonalizationPreferences)[]) {
    const field = data[key] ?? '';
    if (typeof field !== 'string' || field.length > personalizationLimits[key]) throw new Error('Invalid personalization field');
    result[key] = field;
  }
  return result;
}
