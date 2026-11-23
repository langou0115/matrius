import type { WorkGitCommit, WorkGitCommitFile, WorkGitCommitNode, WorkGitDiff, WorkGitDiffRequest, WorkGitStatus } from '../../contract/work-git';
import type { AppDatabase } from '../db/client';
import { requireWorkProjectRow } from '../db/repositories/projects';
import { AppError, conflict, invalid } from '../errors';
import type { HostFsService } from './host-fs';

const MAX_DIFF_BYTES = 256 * 1024;

function formatPatch(output: Buffer): WorkGitDiff {
  const truncated = output.length > MAX_DIFF_BYTES;
  const patch = new TextDecoder().decode(output.subarray(0, MAX_DIFF_BYTES), { stream: truncated });
  return { patch, truncated };
}

function parseStatus(output: string): Pick<WorkGitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'changes'> {
  const result: ReturnType<typeof parseStatus> = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [] };
  const changes = new Map<string, WorkGitStatus['changes'][number]>();
  for (const record of output.split('\0')) {
    if (record.startsWith('# branch.head ')) {
      const name = record.slice(14);
      result.branch = name === '(detached)' ? null : name;
    } else if (record.startsWith('# branch.upstream ')) {
      result.upstream = record.slice(18);
    } else if (record.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (counts) [result.ahead, result.behind] = [Number(counts[1]), Number(counts[2])];
    } else if (record.startsWith('? ')) {
      const path = record.slice(2);
      changes.set(path, { path, index: changes.get(path)?.index ?? '?', workingTree: '?' });
    } else if (record.startsWith('1 ') || record.startsWith('u ')) {
      const fields = record.split(' ', record[0] === '1' ? 8 : 10);
      const path = record.slice(fields.join(' ').length + 1);
      const [index, workingTree] = fields[1];
      changes.set(path, { path, index, workingTree: changes.get(path)?.workingTree ?? workingTree });
    }
  }
  return { ...result, changes: [...changes.values()] };
}

function hasMergeConflicts(changes: WorkGitStatus['changes']): boolean {
  return changes.some(({ index, workingTree }) => (
    index === 'U' || workingTree === 'U' || (index === 'A' && workingTree === 'A') || (index === 'D' && workingTree === 'D')
  ));
}

function validateRepoPaths(paths: readonly string[]): string[] {
  const normalized = [...new Set(paths)];
  if (!normalized.length) throw invalid('请选择至少一个文件。');
  for (const path of normalized) {
    if (!path || path === '.' || path === '..' || path.startsWith('/') || path.includes('\0')) {
      throw invalid('文件路径不合法。');
    }
  }
  return normalized;
}

export function createWorkGitService(db: AppDatabase, hostFs: HostFsService) {
  const pending = new Set<string>();

  async function repository(projectId: string) {
    const project = requireWorkProjectRow(db, 1, projectId);
    async function run(directory: string, args: string[], diff = false) {
      const result = await hostFs.runProjectGit(project.host_id, directory, args);
      if (result.errorCode === 'ENOENT' || result.code === 127) {
        throw new AppError(422, 'git_unavailable', '此项目主机上未找到 Git。');
      }
      if (diff && result.errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return result.stdout;
      if (result.timedOut) throw new AppError(504, 'git_timeout', 'Git 命令执行超时。');
      if (result.code !== 0 && !(diff && args.includes('--no-index') && result.code === 1)) {
        const message = result.stderr.toString('utf8').replace(/(https?:\/\/)[^\s/@]+@/giu, '$1').trim().slice(0, 600);
        if (message.includes('not a git repository')) {
          throw new AppError(422, 'git_not_repository', '项目目录不在 Git 仓库中。');
        }
        throw invalid(message || 'Git 命令执行失败。');
      }
      return result.stdout;
    }

    const root = (await run(project.directory, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\r?\n$/u, '');
    return {
      key: JSON.stringify([project.host_id, root]),
      root,
      run: async (args: string[]) => (await run(root, args)).toString('utf8'),
      diff: (args: string[]) => run(root, args, true),
    };
  }

  async function readStatus(repo: Awaited<ReturnType<typeof repository>>): Promise<WorkGitStatus> {
    const [status, refs] = await Promise.all([
      repo.run(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--ahead-behind', '--no-renames', '--untracked-files=all']),
      repo.run(['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/heads', 'refs/remotes']),
    ]);
    const localBranches: string[] = [];
    const remoteBranches: string[] = [];
    for (const line of refs.split(/\r?\n/u)) {
      const [ref, symbolic] = line.split('\t');
      if (symbolic) continue;
      if (ref.startsWith('refs/heads/')) localBranches.push(ref.slice(11));
      if (ref.startsWith('refs/remotes/')) remoteBranches.push(ref.slice(13));
    }
    return { root: repo.root, ...parseStatus(status), localBranches, remoteBranches };
  }

  async function withRepoLock<T>(projectId: string, busyMessage: string, task: (repo: Awaited<ReturnType<typeof repository>>) => Promise<T>): Promise<T> {
    const repo = await repository(projectId);
    if (pending.has(repo.key)) throw conflict(busyMessage);
    pending.add(repo.key);
    try {
      return await task(repo);
    } finally {
      pending.delete(repo.key);
    }
  }

  return {
    async status(projectId: string) {
      return readStatus(await repository(projectId));
    },
    async graph(projectId: string): Promise<WorkGitCommitNode[]> {
      const repo = await repository(projectId);
      const output = await repo.run([
        'log', '--exclude=refs/stash', '--all', '--single-worktree', '--topo-order', '--max-count=100',
        '--no-color', '--no-show-signature', '-z', '--format=%H%x00%P%x00%D%x00%s%x00%b%x00%an%x00%ae%x00%aI',
        '--decorate=short',
      ]);
      const fields = output.split('\0');
      const commits: WorkGitCommitNode[] = [];
      for (let i = 0; i + 7 < fields.length; i += 8) {
        const [oid, parents, refs, subject, body, author, email, date] = fields.slice(i, i + 8);
        const trimmedBody = body.trim();
        commits.push({
          oid,
          parents: parents ? parents.split(' ') : [],
          refs: refs ? refs.split(', ') : [],
          subject,
          ...(trimmedBody ? { body: trimmedBody } : {}),
          author,
          ...(email ? { email } : {}),
          date,
        });
      }
      return commits;
    },
    async commitFiles(projectId: string, oid: string): Promise<WorkGitCommitFile[]> {
      const repo = await repository(projectId);
      const output = await repo.run([
        '--no-optional-locks', 'show', '--format=', '--diff-merges=first-parent', '--root',
        '--raw', '--numstat', '--no-renames', '-z', oid, '--',
      ]);
      const fields = output.split('\0');
      const statusByPath = new Map<string, string>();
      const files: WorkGitCommitFile[] = [];

      for (let i = 0; i < fields.length; i += 1) {
        const token = fields[i].replace(/^\n+/u, '');
        if (!token) continue;
        const rawMatch = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/u.exec(token);
        if (rawMatch && i + 1 < fields.length) {
          statusByPath.set(fields[i + 1], rawMatch[1]);
          i += 1;
          continue;
        }
        const statMatch = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(token);
        if (statMatch) {
          const [, addRaw, delRaw, path] = statMatch;
          files.push({
            path,
            status: statusByPath.get(path) ?? 'M',
            additions: addRaw === '-' ? null : Number(addRaw),
            deletions: delRaw === '-' ? null : Number(delRaw),
          });
        }
      }
      return files;
    },
    async commitDiff(projectId: string, oid: string, path?: string): Promise<WorkGitDiff> {
      const repo = await repository(projectId);
      const args = [
        '--no-optional-locks', 'show', '--format=', '--diff-merges=first-parent', '--root',
        '--no-color', '--no-ext-diff', '--no-textconv', oid, '--',
      ];
      if (path !== undefined) {
        const [safePath] = validateRepoPaths([path]);
        args.push(safePath);
      }
      return formatPatch(await repo.diff(args));
    },
    async diff(projectId: string, { path, scope }: WorkGitDiffRequest): Promise<WorkGitDiff> {
      const repo = await repository(projectId);
      const status = await repo.run([
        '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--no-renames', '--untracked-files=all', '--', path,
      ]);
      const change = parseStatus(status).changes.find((entry) => entry.path === path);
      if (!change || (scope === 'index' ? ['.', '?'].includes(change.index) : change.workingTree === '.')) {
        return { patch: '', truncated: false };
      }
      const args = ['--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
      if (scope === 'index') args.push('--cached');
      if (scope === 'worktree' && change.workingTree === '?') {
        if (path.endsWith('/')) throw invalid('此路径是一个独立的仓库目录。');
        args.push('--no-index', '--', '/dev/null', './' + path);
      } else {
        args.push('--', path);
      }
      const output = await repo.diff(args);
      return formatPatch(output);
    },
    async fetch(projectId: string) {
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        await repo.run(['fetch', '--all', '--prune', '--no-recurse-submodules']);
        return readStatus(repo);
      });
    },
    async pull(projectId: string) {
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        await repo.run(['pull', '--no-edit']);
        return readStatus(repo);
      });
    },
    async push(projectId: string) {
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        await repo.run(['push']);
        return readStatus(repo);
      });
    },
    async stage(projectId: string, paths: string[]) {
      const safePaths = validateRepoPaths(paths);
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        await repo.run(['add', '-A', '--', ...safePaths]);
        return readStatus(repo);
      });
    },
    async unstage(projectId: string, paths: string[]) {
      const safePaths = validateRepoPaths(paths);
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        const hasHead = await repo.run(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
        if (hasHead) {
          await repo.run(['reset', '-q', 'HEAD', '--', ...safePaths]);
        } else {
          await repo.run(['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...safePaths]);
        }
        return readStatus(repo);
      });
    },
    async discard(projectId: string, paths: string[]) {
      const safePaths = validateRepoPaths(paths);
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        const { changes } = await readStatus(repo);
        const byPath = new Map(changes.map((entry) => [entry.path, entry]));
        const tracked: string[] = [];
        const untracked: string[] = [];
        for (const path of safePaths) {
          const entry = byPath.get(path);
          if (!entry || entry.workingTree === '.') throw conflict('文件变更已更新，请刷新后重试。');
          if (entry.workingTree === '?') {
            if (path.endsWith('/')) throw invalid('此路径是一个独立的仓库目录，不能直接放弃。');
            untracked.push(path);
          } else {
            tracked.push(path);
          }
        }
        if (tracked.length) await repo.run(['checkout', '--', ...tracked]);
        if (untracked.length) await repo.run(['clean', '-f', '-d', '--', ...untracked]);
        return readStatus(repo);
      });
    },
    async checkout(projectId: string, branch: string) {
      if (!branch || branch.startsWith('-')) throw invalid('分支名称不合法。');
      return withRepoLock(projectId, '此仓库有 Git 操作正在进行，请稍后再试。', async (repo) => {
        const current = await readStatus(repo);
        if (current.localBranches.includes(branch)) {
          await repo.run(['checkout', branch]);
        } else if (current.remoteBranches.includes(branch)) {
          await repo.run(['checkout', '--track', branch]);
        } else {
          throw invalid('未找到指定分支。');
        }
        return readStatus(repo);
      });
    },
    async commit(projectId: string, input: WorkGitCommit) {
      return withRepoLock(projectId, '此仓库正在提交，请稍后再试。', async (repo) => {
        const { changes } = await readStatus(repo);
        if (hasMergeConflicts(changes)) {
          throw conflict('仓库有未解决的冲突，请先在终端解决。');
        }
        if (input.staged && (!input.paths || input.paths.length === 0)) {
          const hasStaged = changes.some(({ index }) => index !== '.' && index !== '?');
          if (!hasStaged) throw conflict('暂存区没有可提交的变更。');
          await repo.run(['commit', '-m', input.message]);
        } else {
          const requested = new Set(input.paths ?? []);
          if (!requested.size) throw invalid('请选择至少一个要提交的文件。');
          const selected = changes.filter((change) => requested.has(change.path));
          if (selected.length !== requested.size) throw conflict('文件变更已更新，请刷新后重新选择。');
          const untracked = selected.filter(({ workingTree }) => workingTree === '?').map(({ path }) => path);
          if (untracked.length) await repo.run(['add', '--intent-to-add', '--', ...untracked]);
          await repo.run(['commit', '--only', '-m', input.message, '--', ...selected.map(({ path }) => path)]);
        }
        const oid = (await repo.run(['rev-parse', '--short', 'HEAD'])).trim();
        return { oid };
      });
    },
  };
}
