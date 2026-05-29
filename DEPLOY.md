# 배포 가이드 (connev.io)

nextya 를 connev.io 서버에 배포하는 절차. 기존 **ontology-platform 의 Traefik(`ontology-traefik`)** 을
그대로 재사용해 `https://nextya.connev.io` 로 노출한다.

## 아키텍처

```
Internet (443)
   │
   ▼
ontology-traefik  ──TLS 종료(letsencrypt)──▶  nextya:3000
   │                                              │
   └─ providers.docker.network =                  └─ nextya_data 볼륨 (SQLite 영속)
        ontology-platform_ontology_prod
```

- nextya 컨테이너는 외부 네트워크 `ontology-platform_ontology_prod` 에 join 한다.
  Traefik 이 `--providers.docker.network` 로 이 네트워크에 고정돼 있어, 같은 네트워크여야 백엔드로 인식한다.
- 라우팅은 컨테이너 label(`docker-compose.yml`)로 선언 → Traefik 이 자동 등록.
- `entrypoints=websecure`(443), `certresolver=letsencrypt`(HTTP-01) — 기존 서비스와 동일.

## 사전 요구사항

| 항목 | 상태 / 확인 방법 |
|------|------------------|
| DNS `nextya.connev.io` → 서버 IP (A 레코드) | ✅ 설정 완료 |
| 외부 네트워크 존재 | `docker network ls \| grep ontology-platform_ontology_prod` |
| Traefik 구동 중 | `docker ps \| grep ontology-traefik` |
| `.env` 작성 | 아래 참조 |

## 1. 소스 배치

```bash
ssh jenkins                       # connev@ubuntu
git clone https://github.com/Munsik-Park/nextya
cd nextya
```

## 2. `.env` 작성

`.env.example` 를 복사하고 시크릿을 채운다. 시크릿은 `docker-compose.yml` 에 적지 않고 `.env` 로만 주입한다.

```bash
cp .env.example .env
vi .env
```

필수:

```
GITHUB_TOKEN=ghp_...                 # repo 읽기 권한 PAT
GITHUB_WEBHOOK_SECRET=...            # 3번에서 GitHub Webhook 에 넣을 값과 동일
ANTHROPIC_API_KEY=sk-ant-...
DEFAULT_REPO=connev-llm/claude-autoflow   # webhook 대상 레포
```

> `PORT`, `NODE_ENV`, `DATABASE_PATH` 는 `docker-compose.yml` 의 `environment:` 가 덮어쓰므로
> `.env` 값과 무관하게 컨테이너에서 각각 `3000` / `production` / `/app/data/nextya.db` 로 고정된다.

## 3. 기동

```bash
docker compose up -d --build
docker compose logs -f nextya        # "🚀 port 3000" 확인
```

- 첫 빌드 시 `better-sqlite3` 네이티브 컴파일이 일어난다(builder/deps 스테이지). 최종 이미지에는 빌드 도구가 없다.
- 컨테이너는 non-root(`node`) 로 실행되며 `/app/data` 만 쓰기 한다.
- 인증서는 Traefik 이 첫 HTTPS 요청 시 letsencrypt(HTTP-01)로 자동 발급한다(수 초 소요).

## 4. GitHub Webhook 설정

대상 레포(예: `connev-llm/claude-autoflow`) → **Settings → Webhooks → Add webhook**

| 항목 | 값 |
|------|----|
| Payload URL | `https://nextya.connev.io/webhook` |
| Content type | `application/json` |
| Secret | `.env` 의 `GITHUB_WEBHOOK_SECRET` 와 동일 |
| Events | **Issues** (필요 시 Pull requests) |

저장하면 GitHub 가 `ping` 이벤트를 보낸다. **Recent Deliveries** 에서 `200` 응답 확인.

## 5. Acceptance criteria 검증

| # | 검증 | 명령 / 확인 |
|---|------|------------|
| 1 | 컨테이너 기동 | `docker compose ps` → `Up (healthy)` |
| 2 | health | `curl https://nextya.connev.io/health` → `{"status":"ok",...}` |
| 3 | webhook | GitHub ping → Recent Deliveries `200` |
| 4 | MCP 연결 | Claude Desktop/.ai 원격 MCP → `https://nextya.connev.io/mcp` (POST). **GET 은 405 가 정상** |
| 5 | 볼륨 영속 | `docker volume inspect nextya_nextya_data`, 컨테이너 내 `/app/data/nextya.db` 존재 |
| 6 | 재시작 후 유지 | `docker compose restart nextya` 후 데이터 보존 확인 |

> MCP `/mcp` 는 stateless POST 전용이다. 헬스체크/라우팅 점검을 `/mcp` GET 으로 하지 말 것(405). 항상 `/health` 사용.

## 운영

```bash
docker compose logs -f nextya        # 로그
docker compose restart nextya        # 재시작 (데이터 유지)
git pull && docker compose up -d --build   # 업데이트 재배포
```

## 보안: `/mcp` 인증 (후속)

현재 `/mcp` 는 무인증으로 공개된다. `trigger_analysis` 툴이 GitHub API + Anthropic LLM 호출 비용을
유발하므로, 공개 운영 전 인증이 필요하다.

- 기존 `ontology-mcp-server` 와 동일하게 **Keycloak OAuth**(`auth.connev.io`) 연동이 정석 — 별도 후속 이슈로 진행.
- 그 전까지 임시 보호가 필요하면 Traefik label 로 IP allowlist 미들웨어를 걸 수 있다:

  ```yaml
  - "traefik.http.routers.nextya-mcp.rule=Host(`nextya.connev.io`) && PathPrefix(`/mcp`)"
  - "traefik.http.routers.nextya-mcp.middlewares=nextya-mcp-allow"
  - "traefik.http.middlewares.nextya-mcp-allow.ipallowlist.sourcerange=<신뢰 CIDR>"
  ```

  (`/webhook` 은 HMAC-SHA256 으로 이미 보호되고, `/health` 는 공개해도 무방하다.)
