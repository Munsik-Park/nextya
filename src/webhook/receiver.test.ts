import { test } from 'node:test';
import assert from 'node:assert/strict';

// receiver는 pipeline → analyzer/index(new Anthropic())를 전이 import하므로,
// import 평가 전에 더미 키를 채워 생성자 throw를 방지한다 (실제 호출은 하지 않음).
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-dummy';
process.env.GITHUB_TOKEN ||= 'ghp_test_dummy';

const { parseIssueEvent } = await import('./receiver.js');

const REPO = 'octo/hello';
function payload(action: string): unknown {
  return { action, issue: { number: 42 }, repository: { full_name: REPO } };
}

test('parse: issues.opened를 WebhookEvent로 변환한다', () => {
  const ev = parseIssueEvent('issues', payload('opened'), '2026-05-29T00:00:00Z');
  if (!ev) {
    assert.fail('WebhookEvent를 반환해야 한다');
    return;
  }
  assert.equal(ev.event_type, 'issues');
  assert.equal(ev.action, 'opened');
  assert.equal(ev.repo, REPO);
  assert.equal(ev.issue_number, 42);
  assert.equal(ev.received_at, '2026-05-29T00:00:00Z');
});

test('parse: 처리 대상 액션 4종을 모두 통과시킨다', () => {
  for (const a of ['opened', 'edited', 'closed', 'reopened']) {
    assert.ok(parseIssueEvent('issues', payload(a), 'ts'), `${a} 누락`);
  }
});

test('parse: 무관한 액션(labeled/assigned 등)은 null', () => {
  assert.equal(parseIssueEvent('issues', payload('labeled'), 'ts'), null);
  assert.equal(parseIssueEvent('issues', payload('assigned'), 'ts'), null);
});

test('parse: issues 외 이벤트(pull_request/ping/undefined)는 null', () => {
  assert.equal(parseIssueEvent('pull_request', payload('opened'), 'ts'), null);
  assert.equal(parseIssueEvent('ping', { zen: 'x' }, 'ts'), null);
  assert.equal(parseIssueEvent(undefined, payload('opened'), 'ts'), null);
});

test('parse: 필수 필드가 빠진 페이로드는 null', () => {
  assert.equal(parseIssueEvent('issues', { action: 'opened' }, 'ts'), null);
  assert.equal(parseIssueEvent('issues', { action: 'opened', issue: {}, repository: {} }, 'ts'), null);
  assert.equal(parseIssueEvent('issues', null, 'ts'), null);
  assert.equal(parseIssueEvent('issues', 'not-an-object', 'ts'), null);
});
