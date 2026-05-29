import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initSchema } from './schema.js';
import type { IssueSummary, DependencyEdge } from '../analyzer/types.js';

let _db: BetterSqlite3.Database | null = null;

/** SQLite 인스턴스를 초기화하고 반환한다 (싱글턴). */
export function getDb(): BetterSqlite3.Database {
  if (_db) return _db;
  const dbPath = process.env.DATABASE_PATH ?? './data/nextya.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new BetterSqlite3(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

// ── Issues ──────────────────────────────────────────────────────────────────

/** 이슈를 upsert한다 (없으면 삽입, 있으면 갱신). */
export function upsertIssue(repo: string, issue: IssueSummary): void {
  getDb().prepare(`
    INSERT INTO issues (repo, number, title, body, state, labels, created_at, updated_at, closed_at)
    VALUES (@repo, @number, @title, @body, @state, @labels, @created_at, @updated_at, @closed_at)
    ON CONFLICT(repo, number) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      state = excluded.state,
      labels = excluded.labels,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at
  `).run({ repo, ...issue, labels: JSON.stringify(issue.labels) });
}

/** 특정 레포의 오픈 이슈 전체를 반환한다. */
export function getOpenIssues(repo: string): IssueSummary[] {
  const rows = getDb()
    .prepare(`SELECT * FROM issues WHERE repo = ? AND state = 'open' ORDER BY number`)
    .all(repo) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    number: r['number'] as number,
    title: r['title'] as string,
    body: r['body'] as string,
    state: r['state'] as 'open' | 'closed',
    labels: JSON.parse(r['labels'] as string) as string[],
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string,
    closed_at: r['closed_at'] as string | null,
  }));
}

/** last_analyzed_at을 현재 시각으로 갱신한다. */
export function markAnalyzed(repo: string, issueNumber: number): void {
  getDb()
    .prepare(`UPDATE issues SET last_analyzed_at = ? WHERE repo = ? AND number = ?`)
    .run(new Date().toISOString(), repo, issueNumber);
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/** 의존성 엣지를 upsert한다. */
export function upsertDependency(
  dep: DependencyEdge & { repo: string }
): void {
  getDb().prepare(`
    INSERT INTO dependencies (repo, issue_number, depends_on_number, confidence, reason, source)
    VALUES (@repo, @issue_number, @depends_on_number, @confidence, @reason, @source)
    ON CONFLICT(repo, issue_number, depends_on_number) DO UPDATE SET
      confidence = excluded.confidence,
      reason = excluded.reason,
      source = excluded.source
  `).run(dep);
}

/** 특정 이슈의 의존성 엣지 목록을 반환한다. */
export function getDependencies(repo: string, issueNumber: number): DependencyEdge[] {
  return getDb()
    .prepare(`SELECT * FROM dependencies WHERE repo = ? AND issue_number = ?`)
    .all(repo, issueNumber) as DependencyEdge[];
}

/** 특정 이슈에 의존하는 이슈 목록을 반환한다 (역방향). */
export function getDependents(repo: string, issueNumber: number): DependencyEdge[] {
  return getDb()
    .prepare(`SELECT * FROM dependencies WHERE repo = ? AND depends_on_number = ?`)
    .all(repo, issueNumber) as DependencyEdge[];
}

/** 레포 전체 의존성 엣지를 반환한다. */
export function getAllDependencies(repo: string): DependencyEdge[] {
  return getDb()
    .prepare(`SELECT * FROM dependencies WHERE repo = ?`)
    .all(repo) as DependencyEdge[];
}

/** 특정 이슈의 의존성을 모두 삭제한다 (재분석 시 초기화). */
export function clearDependencies(repo: string, issueNumber: number): void {
  getDb()
    .prepare(`DELETE FROM dependencies WHERE repo = ? AND issue_number = ?`)
    .run(repo, issueNumber);
}

// ── Analysis Log ─────────────────────────────────────────────────────────────

/** 분석 결과를 로그에 기록한다. */
export function logAnalysis(entry: {
  repo: string;
  trigger: string;
  issue_number?: number;
  status: 'success' | 'error' | 'skipped';
  deps_found?: number;
  error?: string;
  duration_ms?: number;
}): void {
  getDb().prepare(`
    INSERT INTO analysis_log (repo, trigger, issue_number, status, deps_found, error, duration_ms)
    VALUES (@repo, @trigger, @issue_number, @status, @deps_found, @error, @duration_ms)
  `).run({
    repo: entry.repo,
    trigger: entry.trigger,
    issue_number: entry.issue_number ?? null,
    status: entry.status,
    deps_found: entry.deps_found ?? 0,
    error: entry.error ?? null,
    duration_ms: entry.duration_ms ?? null,
  });
}
