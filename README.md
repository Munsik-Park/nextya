# nextya

> "야, 다음은 뭐야?"

GitHub 이슈가 AI에 의해 자동 생성되는 시대. 이슈는 쌓이고, 의존성은 복잡하고, 개발자는 매번 묻습니다 — **"다음엔 뭐 해요?"**

`nextya`는 GitHub 이슈 이벤트를 수신해 LLM으로 의존성을 자동 분석하고, MCP 서버를 통해 AI 클라이언트에게 "지금 시작 가능한 이슈"와 "실행 순서"를 제공합니다.

## 핵심 기능

- **GitHub Webhook 수신** — 이슈 생성/변경/닫힘 이벤트 실시간 처리
- **LLM 의존성 분석** — 이슈 본문 산문에서 의존 관계 자동 추출
- **MCP 서버** — AI 클라이언트(Claude, Cursor 등)가 실행 순서를 바로 조회

## MCP Tools

| 툴 | 설명 |
|----|------|
| `get_ready_issues` | 지금 시작 가능한 이슈 |
| `get_execution_order` | 전체 실행 순서 (위상 정렬) |
| `get_issue_context` | 이슈 + 의존성 통합 조회 |
| `get_blocked_issues` | 블로킹된 이슈 + 해제 조건 |
| `trigger_analysis` | 수동 재분석 |

## 빠른 시작

```bash
git clone https://github.com/Munsik-Park/nextya
cd nextya
npm install
cp .env.example .env
# .env 편집 후:
npm run dev
```

## 배포

기존 connev.io 서버의 Traefik 을 재사용해 `https://nextya.connev.io` 로 노출한다.
서버에서:

```bash
docker compose up -d --build
```

전체 배포 절차(네트워크 join, DNS, GitHub Webhook 등록, 영속성 확인)는 [`DEPLOY.md`](DEPLOY.md) 참조.

## 설정

`.env.example` 참조. 최소 필요 항목:
- `GITHUB_TOKEN` — GitHub PAT
- `GITHUB_WEBHOOK_SECRET` — Webhook 시크릿
- `ANTHROPIC_API_KEY` — Claude API 키

## 개발 가이드

`CLAUDE.md` 참조.

## License

MIT
