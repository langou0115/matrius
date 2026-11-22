import type { WorkGitCommit, WorkGitCommitNode, WorkGitDiff, WorkGitDiffRequest, WorkGitStatus } from '../../contract/work-git';
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

  return {
    async status(projectId: string) {
      return readStatus(await repository(projectId));
    },
    async graph(projectId: string): Promise<WorkGitCommitNode[]> {
      const repo = await repository(projectId);
      const output = await repo.run([
        'log', '--exclude=refs/stash', '--all', '--single-worktree', '--topo-order', '--max-count=100',
        '--no-color', '--no-show-signature', '-z', '--format=%H%x00%P%x00%D%x00%s%x00%an%x00%aI',
        '--decorate=short',
      ]);
      const fields = output.split('\0');
      const commits: WorkGitCommitNode[] = [];
      for (let i = 0; i + 5 < fields.length; i += 6) {
        const [oid, parents, refs, subject, author, date] = fields.slice(i, i + 6);
        commits.push({ oid, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ') : [], subject, author, date });
      }
      return commits;
    },
    async commitDiff(projectId: string, oid: string): Promise<WorkGitDiff> {
      const repo = await repository(projectId);
      return formatPatch(await repo.diff([
        '--no-optional-locks', 'show', '--format=', '--diff-merges=first-parent', '--root',
        '--no-color', '--no-ext-diff', '--no-textconv', oid, '--',
      ]));
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
      const repo = await repository(projectId);
      if (pending.has(repo.key)) throw conflict('此仓库有 Git 操作正在进行，请稍后再试。');
      pending.add(repo.key);
      try {
        await repo.run(['fetch', '--all', '--prune', '--no-recurse-submodules']);
        return await readStatus(repo);
      } finally {
        pending.delete(repo.key);
      }
    },
    async commit(projectId: string, input: WorkGitCommit) {
      const repo = await repository(projectId);
      if (pending.has(repo.key)) throw conflict('此仓库正在提交，请稍后再试。');
      pending.add(repo.key);
      try {
        const { changes } = await readStatus(repo);
        const requested = new Set(input.paths);
        const selected = changes.filter((change) => requested.has(change.path));
        if (selected.length !== requested.size) throw conflict('文件变更已更新，请刷新后重新选择。');
        if (changes.some(({ index, workingTree }) => index === 'U' || workingTree === 'U'
          || (index === 'A' && workingTree === 'A') || (index === 'D' && workingTree === 'D'))) {
          throw conflict('仓库有未解决的冲突，请先在终端解决。');
        }
        const untracked = selected.filter(({ workingTree }) => workingTree === '?').map(({ path }) => path);
        if (untracked.length) await repo.run(['add', '--intent-to-add', '--', ...untracked]);
        await repo.run(['commit', '--only', '-m', input.message, '--', ...selected.map(({ path }) => path)]);
        const oid = (await repo.run(['rev-parse', '--short', 'HEAD'])).trim();
        return { oid };
      } finally {
        pending.delete(repo.key);
      }
    },
  };
}
