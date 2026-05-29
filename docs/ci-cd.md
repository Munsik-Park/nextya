# CI/CD (Jenkins)

nextya 는 connev.io 의 Jenkins(`jk.connev.io`)를 사용한다. PR 마다 CI 가 돌고, **main 머지 시 자동 배포**된다.
기존 `ontology-platform` 의 Jenkins(CasC + docker-outside-of-docker)를 그대로 활용한다.

## 파이프라인 (`Jenkinsfile`)

| 단계 | 내용 | 조건 |
|------|------|------|
| Pending status | GitHub commit status `pending` | PR 빌드 |
| CI | `docker build --target test` → `npm ci` + build + typecheck + test(51) | 모든 브랜치/PR |
| Deploy | `docker compose up -d --build` + `/health` 체크 | main 빌드만 |
| (post) | commit status `success`/`failure` | PR 빌드 |

- **왜 `docker build --target test` 인가**: Jenkins 컨테이너에 Node 가 없고 docker-outside-of-docker 라
  workspace 볼륨 마운트가 경로 문제를 일으킨다. Dockerfile `test` 스테이지를 빌드하면 빌드 컨텍스트가
  전송되므로 경로 문제 없이 검증된다.
- **commit status 자체 구현 이유**: 공유 라이브러리 `ontology-pipeline` 은 GitHub owner 가
  `connev-ontology` 로 하드코딩돼 있어 `Munsik-Park/nextya` 에 쓸 수 없다.

---

## 서버 측 설정 (1회)

`jk.connev.io` Jenkins(CasC: `/home/connev/ontology-platform/jenkins/casc.yml`)에 nextya 를 등록한다.

### 1. GitHub PAT 권한

Jenkins 가 쓰는 PAT(`github-token` 또는 nextya 전용)에 **`Munsik-Park/nextya` 접근 권한**을 부여한다.
필요 scope: `repo`(또는 최소 `repo:status` + 코드 read). 조직 외부 레포면 PAT 소유자가 협업자여야 한다.

### 2. Jenkins credentials (3개)

`Jenkinsfile` 이 참조하는 string credential. CasC `credentials.system.domainCredentials.credentials` 에 추가:

```yaml
- string: { id: "nextya-github-token",  secret: "${NEXTYA_GITHUB_TOKEN}",  scope: GLOBAL }
- string: { id: "nextya-webhook-secret", secret: "${NEXTYA_WEBHOOK_SECRET}", scope: GLOBAL }
- string: { id: "nextya-anthropic-key",  secret: "${NEXTYA_ANTHROPIC_KEY}",  scope: GLOBAL }
```

(시크릿 값은 Jenkins 컨테이너 환경변수 `NEXTYA_*` 로 주입)

### 3. Multibranch job (CasC `jobs`)

```yaml
- script: >
    multibranchPipelineJob('nextya') {
      branchSources {
        branchSource {
          source {
            github {
              id('nextya-src')
              repoOwner('Munsik-Park')
              repository('nextya')
              repositoryUrl('https://github.com/Munsik-Park/nextya')
              configuredByUrl(true)
              credentialsId('github-token')
              traits {
                gitHubBranchDiscovery { strategyId(1) }
                gitHubPullRequestDiscovery { strategyId(1) }
              }
            }
          }
        }
      }
      orphanedItemStrategy { discardOldItems { numToKeep(5) } }
    }
```

### 4. GitHub webhook

기존 Jenkins `gitHubPluginConfig.manageHooks=true` 면 job 등록 시 자동 생성된다.
수동이면 `Munsik-Park/nextya` → Settings → Webhooks 에 `https://jk.connev.io/github-webhook/`
(content type `application/json`, events: Pushes + Pull requests) 추가.

### 5. 호스트 준비

- 외부 네트워크 `ontology-platform_ontology_prod` 존재 (DEPLOY.md 참조)
- DNS `nextya.connev.io` → 서버 IP (완료)

---

## 동작 확인

1. 아무 브랜치로 PR → Jenkins 빌드 시작, PR Checks 에 `jenkins/ci` status 표시
2. CI 통과(typecheck+build+test) 후 PR 머지
3. main 빌드가 자동 배포 → `curl https://nextya.connev.io/health` → `{"status":"ok"}`
