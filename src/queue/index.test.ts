import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './index.js';

/** 실제 지연 없이 즉시 resolve하면서 대기 ms를 기록하는 fake sleep. */
function fakeSleep(record: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    record.push(ms);
  };
}

test('withRetry: 첫 시도 성공 시 재시도 없이 결과를 반환한다', async () => {
  let calls = 0;
  const delays: number[] = [];
  const r = await withRetry(
    async () => {
      calls++;
      return 'ok';
    },
    { sleep: fakeSleep(delays) }
  );
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
  assert.equal(delays.length, 0, '성공 시 대기 없음');
});

test('withRetry: 실패 후 재시도하여 성공하면 결과를 반환한다 (지수 백오프)', async () => {
  let calls = 0;
  const delays: number[] = [];
  const r = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('temp');
      return 'done';
    },
    { retries: 3, baseDelayMs: 100, sleep: fakeSleep(delays) }
  );
  assert.equal(r, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200], '100 → 200ms 지수 증가');
});

test('withRetry: 모든 시도 실패 시 마지막 에러를 throw한다 (swallow 금지)', async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      },
      { retries: 3, baseDelayMs: 10, sleep: fakeSleep(delays) }
    ),
    /fail-3/
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('withRetry: onRetry 콜백이 재시도 직전마다 호출된다', async () => {
  const attempts: number[] = [];
  await withRetry(
    async () => {
      throw new Error('x');
    },
    {
      retries: 3,
      baseDelayMs: 1,
      sleep: async () => {},
      onRetry: (_err, attempt) => attempts.push(attempt),
    }
  ).catch(() => undefined);
  assert.deepEqual(attempts, [1, 2], '마지막 시도 후에는 onRetry를 호출하지 않음');
});
