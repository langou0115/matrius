import type { WorkGitChange, WorkGitCommitNode } from '@contract/work-git';

export const GIT_GRAPH_PALETTE = [
  '#3b82f6', // blue
  '#a855f7', // purple
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#6366f1', // indigo
] as const;

export const GIT_GRAPH_ROW_HEIGHT = 30;
export const GIT_GRAPH_LANE_WIDTH = 14;
export const GIT_GRAPH_PAD_LEFT = 14;

export type GraphPathSegment = {
  d: string;
  color: string;
};

export type GraphLayoutRow = {
  node: WorkGitCommitNode;
  lane: number;
  color: string;
  isHead: boolean;
  isMerge: boolean;
  segments: GraphPathSegment[];
};

export type GitGraphLayout = {
  rows: GraphLayoutRow[];
  maxLanes: number;
  width: number;
  height: number;
  hasTrailingEdges: boolean;
};

type LaneSlot = { oid: string; color: number };

export function gitLaneX(lane: number, laneWidth = GIT_GRAPH_LANE_WIDTH, padLeft = GIT_GRAPH_PAD_LEFT): number {
  return padLeft + lane * laneWidth;
}

function cubicPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

export function layoutGitGraph(
  nodes: readonly WorkGitCommitNode[],
  rowHeight = GIT_GRAPH_ROW_HEIGHT,
  laneWidth = GIT_GRAPH_LANE_WIDTH,
  padLeft = GIT_GRAPH_PAD_LEFT,
): GitGraphLayout {
  let active: (LaneSlot | null)[] = [];
  let nextColorSeed = 0;
  let maxLanes = 1;

  function pickColor(avoid: Set<number>): number {
    for (let attempt = 0; attempt < GIT_GRAPH_PALETTE.length; attempt += 1) {
      const candidate = (nextColorSeed + attempt) % GIT_GRAPH_PALETTE.length;
      if (!avoid.has(candidate)) {
        nextColorSeed = (candidate + 1) % GIT_GRAPH_PALETTE.length;
        return candidate;
      }
    }
    const fallback = nextColorSeed % GIT_GRAPH_PALETTE.length;
    nextColorSeed = (nextColorSeed + 1) % GIT_GRAPH_PALETTE.length;
    return fallback;
  }

  const rows: GraphLayoutRow[] = nodes.map((node, rowIndex) => {
    const yTop = rowIndex * rowHeight;
    const yMid = yTop + rowHeight / 2;
    const yBot = yTop + rowHeight;

    const matchingIndices: number[] = [];
    for (let i = 0; i < active.length; i += 1) {
      if (active[i]?.oid === node.oid) matchingIndices.push(i);
    }

    let lane: number;
    let commitColor: number;
    if (matchingIndices.length > 0) {
      lane = matchingIndices[0];
      commitColor = active[lane]!.color;
    } else {
      const freeIdx = active.indexOf(null);
      lane = freeIdx >= 0 ? freeIdx : active.length;
      const avoid = new Set<number>();
      if (lane > 0 && active[lane - 1]) avoid.add(active[lane - 1]!.color);
      if (lane + 1 < active.length && active[lane + 1]) avoid.add(active[lane + 1]!.color);
      commitColor = pickColor(avoid);
    }

    const segments: GraphPathSegment[] = [];

    // Top-half incoming edges into the commit node
    for (const idx of matchingIndices) {
      const slot = active[idx]!;
      segments.push({
        d: cubicPath(gitLaneX(idx, laneWidth, padLeft), yTop, gitLaneX(lane, laneWidth, padLeft), yMid),
        color: GIT_GRAPH_PALETTE[slot.color],
      });
    }

    type NextEntry = {
      slot: LaneSlot;
      originKind: 'passthrough' | 'commit';
      originLane: number;
      edgeColor: number;
    };

    const maxLen = Math.max(active.length, lane + 1);
    const stagedNext: (NextEntry | null)[] = Array.from({ length: maxLen }, () => null);

    // Carry over pass-through lanes first
    for (let i = 0; i < active.length; i += 1) {
      const slot = active[i];
      if (!slot || slot.oid === node.oid) continue;
      segments.push({
        d: `M ${gitLaneX(i, laneWidth, padLeft)} ${yTop} L ${gitLaneX(i, laneWidth, padLeft)} ${yMid}`,
        color: GIT_GRAPH_PALETTE[slot.color],
      });
      stagedNext[i] = {
        slot,
        originKind: 'passthrough',
        originLane: i,
        edgeColor: slot.color,
      };
    }

    const parentEdges: Array<{ fromLane: number; toEntry: NextEntry; color: number }> = [];

    for (let pIdx = 0; pIdx < node.parents.length; pIdx += 1) {
      const parentOid = node.parents[pIdx];
      const existingIdx = stagedNext.findIndex((entry) => entry?.slot.oid === parentOid);
      if (pIdx === 0) {
        if (existingIdx !== -1 && existingIdx < lane) {
          parentEdges.push({
            fromLane: lane,
            toEntry: stagedNext[existingIdx]!,
            color: commitColor,
          });
        } else {
          const entry: NextEntry = {
            slot: { oid: parentOid, color: commitColor },
            originKind: 'commit',
            originLane: lane,
            edgeColor: commitColor,
          };
          stagedNext[lane] = entry;
          parentEdges.push({ fromLane: lane, toEntry: entry, color: commitColor });
        }
      } else if (existingIdx !== -1) {
        parentEdges.push({
          fromLane: lane,
          toEntry: stagedNext[existingIdx]!,
          color: stagedNext[existingIdx]!.slot.color,
        });
      } else {
        const avoid = new Set<number>([commitColor]);
        for (const item of stagedNext) {
          if (item) avoid.add(item.slot.color);
        }
        const branchColor = pickColor(avoid);
        let targetIdx = -1;
        for (let k = lane + 1; k < stagedNext.length; k += 1) {
          if (stagedNext[k] === null) {
            targetIdx = k;
            break;
          }
        }
        if (targetIdx === -1) {
          targetIdx = stagedNext.length;
        }
        const entry: NextEntry = {
          slot: { oid: parentOid, color: branchColor },
          originKind: 'commit',
          originLane: lane,
          edgeColor: branchColor,
        };
        stagedNext[targetIdx] = entry;
        parentEdges.push({ fromLane: lane, toEntry: entry, color: branchColor });
      }
    }

    // Compact empty null slots to prevent unbounded horizontal lane drift
    const compacted: NextEntry[] = stagedNext.filter((entry): entry is NextEntry => entry !== null);
    const targetLaneOf = new Map<NextEntry, number>();
    compacted.forEach((entry, idx) => targetLaneOf.set(entry, idx));

    // Bottom-half edges for pass-through lanes
    for (const entry of compacted) {
      if (entry.originKind !== 'passthrough') continue;
      const toLane = targetLaneOf.get(entry)!;
      segments.push({
        d: cubicPath(gitLaneX(entry.originLane, laneWidth, padLeft), yMid, gitLaneX(toLane, laneWidth, padLeft), yBot),
        color: GIT_GRAPH_PALETTE[entry.edgeColor],
      });
    }

    // Bottom-half edges from this commit to its parents
    for (const edge of parentEdges) {
      const toLane = targetLaneOf.get(edge.toEntry)!;
      segments.push({
        d: cubicPath(gitLaneX(edge.fromLane, laneWidth, padLeft), yMid, gitLaneX(toLane, laneWidth, padLeft), yBot),
        color: GIT_GRAPH_PALETTE[edge.color],
      });
    }

    maxLanes = Math.max(maxLanes, active.length, lane + 1, compacted.length);
    active = compacted.map((entry) => entry.slot);

    const isHead = node.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> '));
    const isMerge = node.parents.length > 1;
    return {
      node,
      lane,
      color: GIT_GRAPH_PALETTE[commitColor],
      isHead,
      isMerge,
      segments,
    };
  });

  const width = Math.max(36, padLeft * 2 + (maxLanes - 1) * laneWidth);
  return {
    rows,
    maxLanes,
    width,
    height: nodes.length * rowHeight,
    hasTrailingEdges: active.length > 0,
  };
}

export type ParsedGitRef = {
  kind: 'head' | 'local' | 'remote' | 'tag';
  raw: string;
  label: string;
  branchName?: string;
};

export function parseGitRefs(
  refs: readonly string[],
  remoteBranches?: readonly string[],
): ParsedGitRef[] {
  const remoteSet = remoteBranches ? new Set(remoteBranches) : null;
  return refs.filter(Boolean).map((raw) => {
    if (raw.startsWith('HEAD -> ')) {
      return { kind: 'head', raw, label: raw, branchName: raw.slice(8) };
    }
    if (raw === 'HEAD') {
      return { kind: 'head', raw, label: 'HEAD' };
    }
    if (raw.startsWith('tag: ')) {
      return { kind: 'tag', raw, label: raw.slice(5) };
    }
    const isRemote = remoteSet
      ? remoteSet.has(raw) || raw.endsWith('/HEAD')
      : /^(?:origin|upstream|remote)\//u.test(raw) || raw.endsWith('/HEAD');
    if (isRemote) {
      return { kind: 'remote', raw, label: raw };
    }
    return { kind: 'local', raw, label: raw };
  });
}

export function formatGitDate(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso.slice(0, 10);
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60 && diffSec >= -60) return '刚刚';
  if (diffSec >= 60 && diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec >= 3600 && diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  if (diffSec >= 86400 && diffSec < 86400 * 14) return `${Math.floor(diffSec / 86400)}天前`;
  return iso.slice(0, 10);
}

export function formatGitFullDate(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

const AVATAR_PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#0ea5e9',
  '#14b8a6',
  '#ef4444',
] as const;

export function authorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

export function authorInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 1).toUpperCase();
}

export type GitChangeTreeNode =
  | {
      kind: 'folder';
      key: string;
      name: string;
      paths: string[];
      children: GitChangeTreeNode[];
    }
  | {
      kind: 'file';
      key: string;
      name: string;
      directory: string;
      change: WorkGitChange;
      code: string;
    };

type MutableFolder = {
  name: string;
  key: string;
  folders: Map<string, MutableFolder>;
  files: Array<{ name: string; directory: string; change: WorkGitChange; code: string }>;
};

function compressFolder(folder: MutableFolder): GitChangeTreeNode & { kind: 'folder' } {
  let currentName = folder.name;
  let currentKey = folder.key;
  let target = folder;

  while (target.files.length === 0 && target.folders.size === 1) {
    const onlyChild = Array.from(target.folders.values())[0];
    currentName = currentName ? `${currentName}/${onlyChild.name}` : onlyChild.name;
    currentKey = onlyChild.key;
    target = onlyChild;
  }

  const childFolders = Array.from(target.folders.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map(compressFolder);
  const childFiles: GitChangeTreeNode[] = [...target.files]
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map((file) => ({
      kind: 'file',
      key: `file:${file.change.path}`,
      name: file.name,
      directory: file.directory,
      change: file.change,
      code: file.code,
    }));

  const children = [...childFolders, ...childFiles];
  const paths: string[] = [];
  for (const child of children) {
    if (child.kind === 'folder') paths.push(...child.paths);
    else paths.push(child.change.path);
  }
  return { kind: 'folder', key: currentKey, name: currentName, paths, children };
}

export function buildGitChangeTree(items: Array<{ change: WorkGitChange; code: string }>): GitChangeTreeNode[] {
  const root: MutableFolder = { name: '', key: '', folders: new Map(), files: [] };

  for (const { change, code } of items) {
    const parts = change.path.split('/').filter(Boolean);
    const fileName = parts.pop() ?? change.path;
    const directory = parts.join('/');
    let cursor = root;
    let accum = '';
    for (const segment of parts) {
      accum = accum ? `${accum}/${segment}` : segment;
      let next = cursor.folders.get(segment);
      if (!next) {
        next = { name: segment, key: accum, folders: new Map(), files: [] };
        cursor.folders.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push({ name: fileName, directory, change, code });
  }

  const topFolders = Array.from(root.folders.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map(compressFolder);
  const topFiles: GitChangeTreeNode[] = [...root.files]
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map((file) => ({
      kind: 'file',
      key: `file:${file.change.path}`,
      name: file.name,
      directory: file.directory,
      change: file.change,
      code: file.code,
    }));
  return [...topFolders, ...topFiles];
}

export type DiffLine = {
  type: 'context' | 'delete' | 'add';
  text: string;
  before?: number;
  after?: number;
};

export type DiffHunk = {
  header: string;
  range: string;
  context: string;
  lines: DiffLine[];
};

export type ParsedDiffFile = {
  displayPath: string;
  oldPath: string;
  newPath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

const MAX_DISPLAY_LINES = 2500;

function stripGitPrefix(raw: string): string {
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseDiffPaths(header: string): { oldPath: string; newPath: string } {
  const rest = header.slice('diff --git '.length);
  const quotedMatch = /^"a\/(.+?)" "b\/(.+?)"$/u.exec(rest);
  if (quotedMatch) return { oldPath: quotedMatch[1], newPath: quotedMatch[2] };
  const abMatch = /^a\/(.+?) b\/(.+)$/u.exec(rest);
  if (abMatch) return { oldPath: abMatch[1], newPath: abMatch[2] };
  const half = Math.floor(rest.length / 2);
  const parts = rest.split(' ');
  if (parts.length === 2) return { oldPath: stripGitPrefix(parts[0]), newPath: stripGitPrefix(parts[1]) };
  const fallback = rest.slice(0, half).trim();
  return { oldPath: fallback || rest, newPath: rest };
}

export function parseGitPatch(patch: string, initialTruncated: boolean): {
  files: ParsedDiffFile[];
  truncated: boolean;
} {
  const files: ParsedDiffFile[] = [];
  let currentFile: ParsedDiffFile | undefined;
  let currentHunk: DiffHunk | undefined;
  let before = 0;
  let after = 0;
  let displayLines = 0;
  let truncated = initialTruncated;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const { oldPath, newPath } = parseDiffPaths(raw);
      currentFile = {
        displayPath: newPath || oldPath,
        oldPath,
        newPath,
        status: 'modified',
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = undefined;
      continue;
    }

    if (!currentFile) {
      const hunkHeaderOnly = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)$/u.exec(raw);
      if (hunkHeaderOnly) {
        currentFile = {
          displayPath: 'diff',
          oldPath: 'diff',
          newPath: 'diff',
          status: 'modified',
          isBinary: false,
          additions: 0,
          deletions: 0,
          hunks: [],
        };
        files.push(currentFile);
      } else {
        continue;
      }
    }

    if (!currentHunk) {
      if (raw.startsWith('new file mode ')) {
        currentFile.status = 'added';
        continue;
      }
      if (raw.startsWith('deleted file mode ')) {
        currentFile.status = 'deleted';
        continue;
      }
      if (raw.startsWith('rename from ')) {
        currentFile.status = 'renamed';
        currentFile.oldPath = raw.slice(12);
        continue;
      }
      if (raw.startsWith('rename to ')) {
        currentFile.status = 'renamed';
        currentFile.newPath = raw.slice(10);
        currentFile.displayPath = currentFile.newPath;
        continue;
      }
      if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
        currentFile.isBinary = true;
        continue;
      }
      if (raw.startsWith('--- ')) {
        const candidate = raw.slice(4).trim();
        if (candidate === '/dev/null') currentFile.status = 'added';
        else currentFile.oldPath = stripGitPrefix(candidate);
        continue;
      }
      if (raw.startsWith('+++ ')) {
        const candidate = raw.slice(4).trim();
        if (candidate === '/dev/null') currentFile.status = 'deleted';
        else {
          currentFile.newPath = stripGitPrefix(candidate);
          currentFile.displayPath = currentFile.newPath;
        }
        continue;
      }
    }

    const header = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)$/u.exec(raw);
    if (header) {
      before = Number(header[2]);
      after = Number(header[3]);
      currentHunk = {
        header: raw,
        range: header[1],
        context: header[4].trim(),
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk && (raw.startsWith(' ') || raw.startsWith('-') || raw.startsWith('+'))) {
      if (displayLines++ >= MAX_DISPLAY_LINES) {
        truncated = true;
        break;
      }
      const text = raw.slice(1);
      if (raw[0] === '-') {
        currentHunk.lines.push({ type: 'delete', text, before: before++ });
        currentFile.deletions += 1;
      } else if (raw[0] === '+') {
        currentHunk.lines.push({ type: 'add', text, after: after++ });
        currentFile.additions += 1;
      } else {
        currentHunk.lines.push({ type: 'context', text, before: before++, after: after++ });
      }
    }
  }

  return { files, truncated };
}

export function pairHunkLines(lines: readonly DiffLine[]): [DiffLine | undefined, DiffLine | undefined][] {
  const rows: [DiffLine | undefined, DiffLine | undefined][] = [];
  let deleted: DiffLine[] = [];
  let added: DiffLine[] = [];
  function flush() {
    const count = Math.max(deleted.length, added.length);
    for (let index = 0; index < count; index += 1) {
      rows.push([deleted[index], added[index]]);
    }
    deleted = [];
    added = [];
  }
  for (const line of lines) {
    if (line.type === 'delete') deleted.push(line);
    else if (line.type === 'add') added.push(line);
    else {
      flush();
      rows.push([line, line]);
    }
  }
  flush();
  return rows;
}

export type InlineDiffRange = { start: number; end: number };

export function computeInlineDiffRanges(
  oldText: string,
  newText: string,
): { oldChanged: InlineDiffRange | null; newChanged: InlineDiffRange | null } {
  if (!oldText || !newText || oldText === newText) {
    return { oldChanged: null, newChanged: null };
  }
  if (oldText.length > 500 || newText.length > 500) {
    return { oldChanged: null, newChanged: null };
  }

  let prefix = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefix < minLen && oldText[prefix] === newText[prefix]) {
    prefix += 1;
  }
  // Keep surrogate pairs intact
  if (prefix > 0 && /[\uD800-\uDBFF]/u.test(oldText[prefix - 1])) prefix -= 1;

  let suffix = 0;
  while (
    suffix < minLen - prefix
    && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (suffix > 0 && /[\uDC00-\uDFFF]/u.test(oldText[oldText.length - suffix])) suffix -= 1;

  const oldEnd = oldText.length - suffix;
  const newEnd = newText.length - suffix;

  // If the entire line changed without meaningful shared prefix/suffix, skip noisy full-line inner highlight
  if (prefix === 0 && suffix === 0) {
    return { oldChanged: null, newChanged: null };
  }

  return {
    oldChanged: oldEnd > prefix ? { start: prefix, end: oldEnd } : null,
    newChanged: newEnd > prefix ? { start: prefix, end: newEnd } : null,
  };
}
