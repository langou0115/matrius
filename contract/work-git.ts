export type WorkGitChange = {
  path: string;
  index: string;
  workingTree: string;
};

export type WorkGitStatus = {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  localBranches: string[];
  remoteBranches: string[];
  changes: WorkGitChange[];
};

export type WorkGitCommit = {
  message: string;
  paths?: string[];
  staged?: boolean;
};

export type WorkGitPathsRequest = {
  paths: string[];
};

export type WorkGitCheckoutRequest = {
  branch: string;
};

export type WorkGitDiffScope = 'index' | 'worktree';
export type WorkGitDiffRequest = { path: string; scope: WorkGitDiffScope };
export type WorkGitDiff = { patch: string; truncated: boolean };

export type WorkGitCommitFile = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

export type WorkGitCommitNode = {
  oid: string;
  parents: string[];
  refs: string[];
  subject: string;
  body?: string;
  author: string;
  email?: string;
  date: string;
};
