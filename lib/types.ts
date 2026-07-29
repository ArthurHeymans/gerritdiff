export type ChangeData = {
  host: string;
  sourceUrl: string;
  changeNumber: number;
  subject: string;
  project: string;
  branch: string;
  status: string;
  owner: { name: string; email?: string; avatarUrl?: string };
  revision: string;
  revisionNumber: number;
  updated: string;
  insertions: number;
  deletions: number;
  patch: string;
};
