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
                         [AI Client] --POST /mcp--> [mcp/server.ts]
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

Stateless Streamable HTTP transport 사용:
- `POST /mcp` — 요청마다 독립 server+transport 생성 (세션 추적 없음, `enableJsonResponse=true` 로 SSE 대신 JSON-RPC 응답)
- `GET`·`DELETE /mcp` — 405 Method Not Allowed (stateless 라 SSE 스트림/세션 종료 개념이 없음)
- 단일 포트(3000)에서 webhook + MCP 모두 서빙

> ⚠️ 배포 시 Traefik/헬스체크를 `/mcp` GET 으로 걸지 말 것 — 405 가 반환된다. `/health` 를 사용한다.

## 배포 환경 (connev.io)

```
Internet → connev-traefik → nextya container (3000)
                          |
                    nextya_data volume
                    (SQLite DB 영속)
```

공용 edge 스택의 Traefik(`connev-traefik`)을 재사용한다. nextya 컨테이너를
외부 네트워크 `connev_proxy` 에 join 시키고 Docker label 로 라우팅 규칙을
선언하면, Traefik 이 `nextya.connev.io` → nextya:3000 으로 프록시한다.
TLS 인증서는 letsencrypt(HTTP-01)로 자동 발급된다. 상세 배포 절차는 루트의 `DEPLOY.md` 참조.
