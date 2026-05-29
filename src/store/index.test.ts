import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueSummary } from '../analyzer/types.js';

// getDb 첫 호출 전에 인메모리 DB로 지정 (싱글턴이라 import보다 먼저 설정).
process.env.DATABASE_PATH = ':memory:';

const {
  getDb,
  upsertIssue,
  getOpenIssues,
  getAllIssues,
  getIssue,
  markAnalyzed,
  upsertDependency,
  getDependencies,
  getDependents,
  getAllDependencies,
  clearDependencies,
  logAnalysis,
} = await import('./index.js');

/** 테스트용 이슈 객체를 만든다 (필드는 over로 덮어쓴다). */
function makeIssue(number: number, over: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number,
    title: `issue ${number}`,
    body: '',
    state: 'open',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    ...over,
  };
}

// ── Schema ────────────────────────────────────────────────────────────────────

test('schema: issues / dependencies / analysis_log 테이블이 생성된다', () => {
  const names = (
    getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  for (const t of ['issues', 'dependencies', 'analysis_log']) {
    assert.ok(names.includes(t), `${t} 테이블 누락`);
  }
});

// ── Issues ─────────────────────────────────────────────────────────────────────

test('issue: upsert 후 조회되고 labels JSON 라운드트립이 보존된다', () => {
  const repo = 'o/r1';
  upsertIssue(repo, makeIssue(1, { title: 'A', labels: ['bug', 'p1'] }));
  const open = getOpenIssues(repo);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.title, 'A');
  assert.deepEqual(open[0]!.labels, ['bug', 'p1']);
});

test('issue: 동일 number upsert는 중복 삽입이 아니라 갱신이다', () => {
  const repo = 'o/r2';
  upsertIssue(repo, makeIssue(1, { title: 'old' }));
  upsertIssue(repo, makeIssue(1, { title: 'new' }));
  const all = getAllIssues(repo);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.title, 'new');
});

test('issue: getOpenIssues는 closed 제외, getAllIssues는 포함', () => {
  const repo = 'o/r3';
  upsertIssue(repo, makeIssue(1, { state: 'open' }));
  upsertIssue(repo, makeIssue(2, { state: 'closed', closed_at: '2026-02-01T00:00:00Z' }));
  assert.equal(getOpenIssues(repo).length, 1);
  assert.equal(getAllIssues(repo).length, 2);
});

test('issue: getIssue는 단일 조회, 없으면 null', () => {
  const repo = 'o/r4';
  upsertIssue(repo, makeIssue(7, { title: 'seven' }));
  assert.equal(getIssue(repo, 7)?.title, 'seven');
  assert.equal(getIssue(repo, 999), null);
});

test('issue: markAnalyzed가 last_analyzed_at을 채운다', () => {
  const repo = 'o/r5';
  upsertIssue(repo, makeIssue(1));
  assert.equal(getIssue(repo, 1)?.last_analyzed_at, null);
  markAnalyzed(repo, 1);
  const at = getIssue(repo, 1)?.last_analyzed_at;
  assert.ok(at && !Number.isNaN(Date.parse(at)), 'last_analyzed_at은 유효한 ISO 시각이어야 한다');
});

// ── Dependencies ─────────────────────────────────────────────────────────────

test('dep: upsert 후 정방향/역방향/전체 조회가 일치한다', () => {
  const repo = 'o/r6';
  upsertDependency({ repo, issue_number: 3, depends_on_number: 1, confidence: 0.9, reason: 'r1', source: 'llm' });
  upsertDependency({ repo, issue_number: 3, depends_on_number: 2, confidence: 0.8, reason: 'r2', source: 'llm' });
  assert.equal(getDependencies(repo, 3).length, 2); // #3이 의존하는 것
  assert.equal(getDependents(repo, 1).length, 1); // #1에 의존하는 것
  assert.equal(getAllDependencies(repo).length, 2);
});

test('dep: 동일 엣지 upsert는 갱신한다 (UNIQUE 제약)', () => {
  const repo = 'o/r7';
  upsertDependency({ repo, issue_number: 2, depends_on_number: 1, confidence: 0.5, reason: 'a', source: 'llm' });
  upsertDependency({ repo, issue_number: 2, depends_on_number: 1, confidence: 0.95, reason: 'b', source: 'manual' });
  const deps = getAllDependencies(repo);
  assert.equal(deps.length, 1);
  assert.equal(deps[0]!.confidence, 0.95);
});

test('dep: clearDependencies는 해당 이슈의 엣지만 삭제한다', () => {
  const repo = 'o/r8';
  upsertDependency({ repo, issue_number: 2, depends_on_number: 1, confidence: 1, reason: '', source: 'llm' });
  upsertDependency({ repo, issue_number: 3, depends_on_number: 1, confidence: 1, reason: '', source: 'llm' });
  clearDependencies(repo, 2);
  assert.equal(getDependencies(repo, 2).length, 0);
  assert.equal(getDependencies(repo, 3).length, 1);
});

// ── Analysis log ─────────────────────────────────────────────────────────────

test('log: logAnalysis가 기록되고 옵셔널 필드는 null로 저장된다', () => {
  const repo = 'o/r9';
  logAnalysis({ repo, trigger: 'manual', issue_number: 1, status: 'success', deps_found: 2, duration_ms: 5 });
  logAnalysis({ repo, trigger: 'webhook', status: 'error', error: 'boom' });
  const rows = getDb()
    .prepare(`SELECT * FROM analysis_log WHERE repo = ? ORDER BY id`)
    .all(repo) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!['status'], 'success');
  assert.equal(rows[0]!['deps_found'], 2);
  assert.equal(rows[1]!['error'], 'boom');
  assert.equal(rows[1]!['issue_number'], null);
});
