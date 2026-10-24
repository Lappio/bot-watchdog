export interface CheckResult { ok: boolean; detail: string }
export interface DeliverableConfig {
  url?: string; expect_status?: number; expect_contains?: string;
  type?: 'commit' | 'pr' | 'issue' | 'file' | 'url';
  owner?: string; repo?: string; sha?: string; ref?: string; path?: string; number?: number;
}
