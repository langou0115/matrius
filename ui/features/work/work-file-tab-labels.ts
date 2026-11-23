import { workFileTabPath, type WorkFileTab } from '@contract/work-projects';

export function fileTabDescriptions(files: readonly WorkFileTab[]): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const file of files) {
    const others = files.filter((other) => other !== file && other.name.toLowerCase() === file.name.toLowerCase());
    if (!others.length) continue;
    const parts = file.path.split(/[\\/]/u).slice(0, -1);
    const otherParts = others.map((other) => other.path.split(/[\\/]/u).slice(0, -1));
    let suffix = '';
    for (let depth = 1; depth <= parts.length; depth++) {
      suffix = parts.slice(-depth).join('/') || '/';
      if (otherParts.every((other) => (other.slice(-depth).join('/') || '/') !== suffix)) break;
    }
    const samePath = others.some((other) => other.path === file.path);
    descriptions.set(workFileTabPath(file), samePath
      ? `${file.localOutsideProject ? '本机' : '项目主机'} · ${suffix}`
      : suffix);
  }
  return descriptions;
}
