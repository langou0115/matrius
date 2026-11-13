import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROPERTIES_FILE = fileURLToPath(new URL('./office_properties.json', import.meta.url));

const BLOCKED_PROPERTIES = new Set(`
  src path image image.relid data render poster mediatype contenttype olekind relid
  password passwordhash workbook.password workbookpassword protect formprot
  protection.algorithm protection.hash protection.salt protection.spincount
  lock locked lockstructure lockwindows trackchanges trackrevisions
  removepersonalinfo removepersonalinfoonsave removepersonalinformation
  mermaid dsl md source
`.split(/\s+/u).filter(Boolean));

let cached: Set<string> | null = null;

export function propertyNames(): Set<string> {
  if (cached) return cached;
  try {
    const payload = JSON.parse(readFileSync(PROPERTIES_FILE, 'utf8')) as { properties?: unknown };
    const names = Array.isArray(payload.properties) ? payload.properties : [];
    cached = new Set(
      names
        .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
        .map((name) => name.trim().toLowerCase())
        .filter((name) => !BLOCKED_PROPERTIES.has(name)),
    );
  } catch {
    throw new Error('缺少 office_properties.json；请从 OfficeCLI schema 重新生成。');
  }
  return cached;
}

export function isAllowedProperty(name: string): boolean {
  return propertyNames().has(name.trim().toLowerCase());
}
