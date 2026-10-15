export interface RepoSnapshot {
  repo: string;
  branch: string;
  defaultBranch: string;
  private: boolean;
  sha: string;
  tree: string;
  message: string;
  author: string;
  ownerAvatar: string;
  authorAvatar: string;
  date: string;
}

export interface RepoEntry {
  path: string;
  type: 'tree' | 'blob' | 'commit';
  mode: string;
  sha: string;
  size?: number;
}

export interface RepoTree {
  entries: RepoEntry[];
  truncated: boolean;
}

export interface RepoPaths {
  paths: string[];
  truncated: boolean;
}

export interface RepoBranches {
  names: string[];
  cursor: string | null;
  more: boolean;
  total: number;
}

export interface RepoFile {
  size: number;
  binary: boolean;
  text: string | null;
  tooLarge: boolean;
  lang: string;
}
