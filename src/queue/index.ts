import PQueue from 'p-queue';

let _queue: PQueue | null = null;

/**
 * 이벤트 처리 큐 싱글턴을 반환한다.
 * concurrency=2: 동시 LLM 분석 최대 2개 (rate limit 고려)
 */
export function getQueue(): PQueue {
  if (!_queue) {
    _queue = new PQueue({
      concurrency: 2,
      intervalCap: 10,
      interval: 1000,
    });
    _queue.on('error', (err) => console.error('[queue] task error:', err));
    _queue.on('idle', () => console.debug('[queue] idle'));
  }
  return _queue;
}

/** withRetry 동작 옵션. */
export interface RetryOptions {
  /** 총 시도 횟수 (기본 3). */
  retries?: number;
  /** 첫 재시도 전 대기 ms (기본 500). 시도마다 2배로 증가한다. */
  baseDelayMs?: number;
  /** 재시도 사이 대기 함수 (테스트에서 주입해 실제 지연을 우회). */
  sleep?: (ms: number) => Promise<void>;
  /** 재시도 직전 호출되는 콜백 (로깅용). */
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * 비동기 작업을 실패 시 지수 백오프로 재시도한다.
 * CLAUDE.md 핵심 흐름의 "재시도 보장"을 충족하기 위한 헬퍼로,
 * 모든 시도가 실패하면 마지막 에러를 다시 throw한다 (절대 swallow하지 않음).
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        opts.onRetry?.(err, attempt);
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}
