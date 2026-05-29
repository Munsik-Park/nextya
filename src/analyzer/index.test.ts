import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueSummary } from './types.js';
import { analyzeIssueDependencies, resultToEdges, type CreateMessage } from './index.js';

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

const ISSUES = [
  makeIssue(1, { title: 'schema' }),
  makeIssue(2, { title: 'api' }),
  makeIssue(3, { title: 'ui' }),
];
const TARGET = makeIssue(3, { title: 'ui', body: 'depends on #1 and #2' });

/** 고정 텍스트를 반환하는 mock createMessage를 만든다. */
function constMessage(text: string): CreateMessage {
  return async () => text;
}

// ── AC #1: zod 파싱 + CONFIDENCE_THRESHOLD 필터 ───────────────────────────────

test('analyzeIssueDependencies: confidence < threshold 의존성을 제거한다', async () => {
  process.env.CONFIDENCE_THRESHOLD = '0.6';
  const json = JSON.stringify({
    depends_on: [
      { number: 1, reason: 'strong', confidence: 0.9 },
      { number: 2, reason: 'weak', confidence: 0.3 },
    ],
    blocks: [{ number: 9, reason: 'b', confidence: 0.4 }],
    ready_to_start: false,
    notes: 'n',
  });
  const result = await analyzeIssueDependencies('o/r', TARGET, ISSUES, {
    createMessage: constMessage(json),
  });
  assert.ok(result);
  assert.equal(result.depends_on.length, 1);
  assert.equal(result.depends_on[0]!.number, 1);
  assert.equal(result.blocks.length, 0, 'blocks도 threshold로 필터되어야 함');
  assert.equal(result.ready_to_start, false);
  assert.equal(result.analyzed_issue_number, 3);
});

test('analyzeIssueDependencies: ```json 코드펜스로 감싼 응답을 파싱한다', async () => {
  process.env.CONFIDENCE_THRESHOLD = '0.6';
  const fenced =
    '```json\n' +
    JSON.stringify({
      depends_on: [{ number: 1, reason: 'r', confidence: 0.8 }],
      blocks: [],
      ready_to_start: false,
      notes: '',
    }) +
    '\n```';
  const result = await analyzeIssueDependencies('o/r', TARGET, ISSUES, {
    createMessage: constMessage(fenced),
  });
  assert.ok(result);
  assert.equal(result.depends_on.length, 1);
});

test('analyzeIssueDependencies: 빈 객체 응답이면 기본값(빈 배열)을 반환한다', async () => {
  const result = await analyzeIssueDependencies('o/r', TARGET, ISSUES, {
    createMessage: constMessage('{}'),
  });
  assert.ok(result);
  assert.deepEqual(result.depends_on, []);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.ready_to_start, true);
  assert.equal(result.notes, '');
});

// ── AC #2: 파싱 실패 시 1회 재시도, 그 후 null ────────────────────────────────

test('analyzeIssueDependencies: 1차 실패 후 2차 성공하면 결과 반환 (재시도 1회)', async () => {
  process.env.CONFIDENCE_THRESHOLD = '0.6';
  let calls = 0;
  const createMessage: CreateMessage = async () => {
    calls++;
    if (calls === 1) return 'not json at all';
    return JSON.stringify({
      depends_on: [{ number: 1, reason: 'r', confidence: 0.9 }],
      blocks: [],
      ready_to_start: false,
      notes: '',
    });
  };
  const result = await analyzeIssueDependencies('o/r', TARGET, ISSUES, { createMessage });
  assert.equal(calls, 2, '정확히 2번 시도(원시도 + 재시도 1회)');
  assert.ok(result);
  assert.equal(result.depends_on.length, 1);
});

test('analyzeIssueDependencies: 2회 모두 파싱 실패하면 null을 반환한다', async () => {
  let calls = 0;
  const createMessage: CreateMessage = async () => {
    calls++;
    return 'garbage';
  };
  const result = await analyzeIssueDependencies('o/r', TARGET, ISSUES, { createMessage });
  assert.equal(calls, 2);
  assert.equal(result, null);
});

test('analyzeIssueDependencies: createMessage가 매번 throw하면 2회 시도 후 null', async () => {
  let calls = 0;
  const createMessage: CreateMessage = async () => {
    calls++;
    throw new Error('api down');
  };
  const result = await analyzeIssueDependencies('o/r', TARGET, ISSUES, { createMessage });
  assert.equal(calls, 2);
  assert.equal(result, null);
});

// ── resultToEdges ─────────────────────────────────────────────────────────────

test('resultToEdges: depends_on을 DependencyEdge로 매핑한다', () => {
  const edges = resultToEdges({
    repo: 'o/r',
    analyzed_issue_number: 3,
    depends_on: [
      { number: 1, reason: 'r1', confidence: 0.9 },
      { number: 2, reason: 'r2', confidence: 0.7 },
    ],
    blocks: [],
    ready_to_start: false,
    notes: '',
    model_used: 'm',
    analyzed_at: 't',
  });
  assert.equal(edges.length, 2);
  assert.deepEqual(edges[0], {
    issue_number: 3,
    depends_on_number: 1,
    confidence: 0.9,
    reason: 'r1',
  });
});
