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
