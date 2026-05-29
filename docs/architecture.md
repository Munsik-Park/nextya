# nextya 아키텍처

## 개요

nextya는 세 개의 독립적인 관심사로 구성된다:

1. **Webhook Layer** — GitHub 이벤트 수신 + 검증
2. **Analyzer Layer** — LLM 기반 의존성 추출
3. **MCP Layer** — AI 클라이언트에 결과 제공

## 데이터 흐름

```
[GitHub] --POST /webhook--> [verify.ts] --> [receiver.ts]
                                                 |
                                           [queue/index.ts]
                                                 |
                                       [analyzer/pipeline.ts]
                                        /              \
                           [octokit: 이슈 조회]   [analyzer/index.ts]
                                        \              /
                                       [store/index.ts]
                                                 |
                                         [SQLite database]
                                                 |
                                        [mcp/tools.ts]
                                                 |
                         [AI Client] --GET/POST /mcp--> [mcp/server.ts]
```

## 의존성 신뢰도 (confidence)

| 수준 | 값 | 예시 |
|------|-----|------|
| 명시적 참조 | 1.0 | `#101`, `Closes #99` |
| 직접 언급 | 0.8 | `depends on S3`, `S3 완료 후` |
| 암묵적 의존 | 0.6~0.7 | 동일 스키마 참조 등 |
| 저장 안 함 | < 0.6 | `CONFIDENCE_THRESHOLD` 미만 |

## 큐 설계

p-queue를 사용해 webhook 이벤트를 비동기 처리:
- `concurrency: 2` — 동시 LLM 분석 최대 2개
- `intervalCap: 10, interval: 1000` — 초당 10개 제한
- 실패 시 에러 로그만 기록 (자동 재시도 없음, 수동 `trigger_analysis` 사용)

## MCP Transport

Streamable HTTP transport 사용:
- `POST /mcp` — 클라이언트 요청
- `GET /mcp` — SSE 스트림
- 단일 포트(3000)에서 webhook + MCP 모두 서빙

## 배포 환경 (connev.io)

```
Internet → Traefik → nextya container (3000)
                          |
                    nextya_data volume
                    (SQLite DB 영속)
```

Traefik이 `deps.connev.io`를 nextya 컨테이너로 라우팅.
