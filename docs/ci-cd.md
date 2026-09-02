# CI/CD (GitHub Actions)

nextya 는 GitHub Actions 로 CI/CD 를 수행한다. 서버 인프라 중 **Traefik 프록시만** connev.io 와
공유하고(같은 서버 사용), 파이프라인은 nextya 레포 안에서 완결된다.

## 워크플로

| 파일 | 트리거 | 내용 |
|------|--------|------|
| `.github/workflows/ci.yml` | PR + main push | typecheck + build + test (Node 20, npm 캐시) |
| `.github/workflows/deploy.yml` | main push | SSH → 서버 `docker compose up -d --build` + `/health` |

- commit status(PR Checks)는 Actions 내장 `GITHUB_TOKEN` 이 자동 처리 — 별도 PAT 불필요.
- nextya 는 public 레포라 GitHub-hosted runner **무료**. `concurrency` 로 중복 실행을 취소해 사용량을 줄인다.

## 시크릿 (레포 → Settings → Secrets and variables → Actions)

| 이름 | 용도 | 발급 / self 가능 여부 |
|------|------|----------------------|
| `APP_GITHUB_TOKEN` | 앱이 분석 대상(`connev-llm/claude-autoflow`) 이슈 read | connev-llm org 권한자. scope `repo`(private) 또는 `public_repo` |
| `WEBHOOK_SECRET` | webhook HMAC. 대상 레포 webhook Secret 과 동일 | `openssl rand -hex 32` (누구나) |
| `ANTHROPIC_API_KEY` | LLM 의존성 분석 | Anthropic Console (콘솔 권한자) |
| `DEPLOY_SSH_HOST` | 배포 서버 주소 | 서버 host |
| `DEPLOY_SSH_USER` | 배포 SSH 사용자 | 예: `connev` |
| `DEPLOY_SSH_KEY` | 배포 SSH 개인키 | `ssh-keygen` 후 공개키를 서버 `~/.ssh/authorized_keys` 에 등록 (서버 접근자) |

> `deploy.yml` 은 `environment: production` 을 쓴다. 레포에 **Environment `production`** 을 만들어
> 시크릿을 묶고 배포 승인/보호 규칙을 걸 수 있다.

## 서버 1회 준비

- 외부 네트워크 `connev_proxy` 존재 + DNS `nextya.connev.io` (→ `DEPLOY.md`)
- 배포 사용자가 docker 권한 보유. `/home/connev/nextya` 는 첫 배포 시 자동 clone 된다.

## 배포 흐름

```
main 머지 → deploy.yml → SSH → 서버
  git reset --hard origin/main
  .env 생성(Secrets 주입)
  COMPOSE_PROJECT_NAME=nextya docker compose up -d --build
  /health 확인 → .env 삭제
```

## 동작 확인

1. PR 생성 → Actions 에서 CI 실행, PR Checks 에 결과 표시
2. CI 통과 후 머지 → Deploy 워크플로 자동 실행
3. `curl https://nextya.connev.io/health` → `{"status":"ok"}`
