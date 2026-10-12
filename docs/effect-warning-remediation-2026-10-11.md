# 2026-10-11 Effect 경고의 실제 API 전환

이 문서는 앞선 `effect-type-cleanup-2026-10-11.md` 뒤에 진행한 구현을 기록한다. 사용자는 unstable 진단만 끄고 나머지는 고치라고 결정했다. `ignoreEffectWarningsInTscExitCode`와 다른 Effect 진단 억제는 추가하지 않았다. 공식 RPC·Workflow·SQL을 자체 구현으로 교체하지 않았다.

## 구현과 주요 변경 파일

- `packages/memory-agent/src/db/database.ts`, 새 `migration-client.ts`: 공식 `Migrator`가 기존 `DatabaseSync` 연결을 사용한다. `BEGIN IMMEDIATE` 뒤에 `user_version`을 재조회한다. 기존 이력은 재실행하지 않고 최초에만 `effect_sql_migrations`로 채택한다. 기존 metadata의 ID 목록이 `user_version`과 다르면 거부한다. SQL·metadata·version·보존 행·FK 검증을 한 트랜잭션으로 commit/rollback한다. Migrator 내부 트랜잭션은 SAVEPOINT다. 기존 schema 49와 실패 기록·복구 receipt 계약을 유지한다.
- `apps/agent/scripts/dev.ts`, `dev-configuration.ts`, `dev-process.ts`, `server/dev-safety.ts`: 공식 프로세스·HTTP·파일·시계 서비스, 포트와 storage/manifest 설정, 준비 확인, Scope 종료. UI HMR과 고정 backend 빌드를 구분하고 build-ID mutation 차단을 유지한다.
- `src/runtime/archive.ts`, 새 `src/rrsi/command.ts`, `src/files/git-grep.ts`, `src/files/listing.ts`, OAuth Windows proxy, eval/fixture 프로세스: 실제 `ChildProcessSpawner`와 Scope로 실행·출력 제한·실패·시간 제한·취소를 관리한다. 외부 ACP와 셸의 모든 native 실행을 교체했다고 주장하지 않는다.
- `src/kagi`, `src/providers`, `src/oauth/validation-harness.ts`, HTTP 테스트: 공식 HttpClient/HttpServerRequest/Response. OAuth callback 응답을 보낸 뒤 listener를 닫고 Deferred를 완료한다. 취소·late token·중복 callback·keychain 실패 계약을 유지한다.
- `src/memory`, `src/workflow`, `src/imports`, `src/attachments`, `src/config/global-config.ts`: 실제 FileSystem/Path/Crypto·Schema·Fiber·Queue로 전환. native worker는 순차 Queue로 MessagePort 명령 순서를 보존한다. imports는 1MiB byte read, UTF-8, 미완성 tail, 200개 write chunk를 유지한다. 공식 stat의 mtime은 ms이므로 기존 sub-ms cursor는 안전하게 한 번 다시 읽을 수 있다; 기존 dedup 계약은 유지한다.
- 새 `src/runtime/synchronous-crypto.ts`, `synchronous-path.ts`: 자원을 소유하지 않는 공식 NodeCrypto/NodePath 서비스를 동기 SQLite/SDK 경계에 캡처한다. 단발 SHA256/UUID와 순수 경로 연산의 결과를 유지한다. 비동기 crypto 구현을 동기 경계에 제공할 수 있다는 의미가 아니다.
- provider/OAuth builder 17개는 options 객체 API로 정리하고 내부 호출·테스트를 함께 변경했다. 공개 채팅 handle은 FS/Path Context를 생성 시 캡처해 기존 requirement를 유지한다.
- UI UUID·타이머는 공식 Crypto/Fiber/Schedule로 전환했다. React 정리 함수에서 fiber를 중단한다. API mutation의 build-ID 누락을 바로잡았다.
- 삭제: production 사용자가 없던 `src/agent/full-loop-rpc-client.ts`. 해당 검증은 현재 공식 Effect RPC transport 테스트로 옮겼다. 사용하지 않는 dev process completion 구현/fixture도 제거했다. 실제 쓰이는 worker·OAuth runtime helper·프로세스 runner는 유지한다.

## 워커 번들의 의존성

Effect 때문에 워커에서 공식 API를 못 쓰는 제약은 없다. `scripts/build-runtime-artifacts.ts`의 full-loop worker는 JS 의존성을 단일 `.mjs`로 포함한다. `native.mjs`는 owner의 Effect/플랫폼 서비스와 같은 패키지를 사용하도록 Effect, TanStack AI, `@effect/platform-node`를 external로 유지한다. 따라서 `apps/agent/scripts/package.ts`의 runtime dependency 수집에 `@effect/platform-node`와 하위 의존성을 포함했다. `.node` addon, keyring, 모델 파일은 JS 번들로 바뀌지 않는다. Windows `.cmd` 인자 quoting과 파일의 nofollow/FD identity는 별도 플랫폼 계약이다.

설치는 Effect/platform-node/vitest 4.0.2 조합을 유지한다. registry 재조회도 Effect 4.0.2, platform-node/vitest 4.0.3이었다. 공식 사이트는 4.0.3 문서를 표시하지만 해당 platform peer가 요구하는 effect 4.0.3은 registry에 없어 적용하지 않았다. 검사기 latest 0.51.1은 확인했으나 경고를 없애기 위해 기존 0.48.1을 교체하지 않았다. 구현 검토는 설치된 소스가 기준이다. 공식 [ChildProcess](https://effect.website/docs/v4/api/effect/process/ChildProcess), [Migrator](https://effect.website/docs/v4/api/effect/sql/Migrator) API를 사용한다.

## 첫 검증 시점의 잔여 항목과 후속 전환 대상

아래 표는 첫 검증 시점의 기록이다. 이후 전환한 fetch, owner lock, ACP, 설정 읽기, Skills 등은 뒤의 후속 절에 기록하며 현재 잔여 진단은 마지막 27개 표를 기준으로 한다. 예외 승인을 받았다는 의미가 아니다. 경고를 이름 변경·넓은 타입 단언으로 숨기지 않았다.

| 파일                                                                            | 남은 진단과 계약·대안                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/agent/app/entry/shared/backend-restart.ts`                                | native fetch 1개. SDK가 native Response/SSE body와 clone/abort를 소비한다. HttpClientResponse는 fromWeb만 제공하므로 역변환과 소비 종료까지 Scope를 소유하는 adapter 검증이 필요하다. 전환 불가능하다는 주장은 아니다.                                    |
| `apps/agent/scripts/package.ts`                                                 | Crypto 1개: 큰 runtime 파일을 추가 전체 버퍼 없이 incremental SHA256. FS 1개: manifest 자산의 심링크 제외를 위한 lstat. 공식 Crypto는 단발 digest, FS.stat은 링크를 따른다. 확장 드라이버가 필요하다.                                                     |
| `apps/agent/server/dev-safety.ts`                                               | FS 1개: exclusive owner lock과 process exit의 동기 release. fingerprint는 이미 실제 async FS/Crypto로 전환했다. 락 lifecycle API를 바꾸면 추가 전환 가능하다.                                                                                             |
| `apps/agent/server/launch-project.ts`                                           | FS 1개: 동기 CLI 폴더 실경로/stat 검증. async CLI 호출 계약까지 바꾸면 공식 FS로 전환 가능하다.                                                                                                                                                           |
| `apps/agent/server/launch-project.test.ts`                                      | HTTP 1개: native Node server의 루프백 host 동작 검증. 공식 NodeHttpServer도 native factory를 인자로 받는다.                                                                                                                                               |
| `apps/agent/server/main.ts`                                                     | Stream 1개: ACP SDK의 Web Writable/Readable 변환과 flush/backpressure. env 2개: CLI storage 및 SEA runtime 경로를 다른 모듈이 읽기 전에 bootstrap에서 설정한다. 읽기 Config와 프로세스 환경 setter는 역할이 다르다.                                       |
| `apps/agent/server/release-contract.ts`, `.test.ts`                             | 각 Crypto 1개: Ed25519 sign/verify 및 공개키 검증. 설치된 Crypto는 이 서명 API를 제공하지 않는다.                                                                                                                                                         |
| `apps/agent/server/serve.ts`                                                    | HTTP 1개: React Router RequestListener/IncomingMessage/ServerResponse bridge. 정적 stat/stream은 공식 FS/NodeSink로 전환했다.                                                                                                                             |
| `packages/memory-agent/bin/context-agent-acp.ts`                                | Stream 1개: ACP SDK native WebStream 변환. 직접 Queue/WritableStream adapter를 쓰려면 동일 backpressure/close/flush 검증이 필요하다.                                                                                                                      |
| `src/agent/goal-worker-assets.ts`                                               | FS 1개: 동기 immutable asset registry와 SQLite source pin/fence 호출 계약. async snapshot/admission 경계 재설계가 필요하다.                                                                                                                               |
| `src/agent/native-artifact-loader.ts`                                           | FS 1개: O_NOFOLLOW로 연 동일 FD의 fstat/read. 일반 staging과 cleanup은 공식 FS로 전환했다. 경로 기반 stat/read로 단순 치환하면 TOCTOU 계약이 약해진다.                                                                                                    |
| `src/agent/owner-native-files.ts`                                               | FS 1개: SQLite atomic callback 안의 origin/bytes 재검증. 일반 8개 I/O 메서드는 공식 FS다. transaction 중 suspend할 수 없다.                                                                                                                               |
| `src/external-agents/agents.ts`                                                 | ChildProcess type 1개와 Stream 1개: 현재 cross-spawn의 Windows npx/.cmd quoting 및 ACP WebStream 어댑터. 재연결 타이머와 spawn 이벤트 취소는 Effect로 옮겼다. 공식 Node spawner는 node.spawn을 쓰므로 quoting/SDK stream 경계까지 검증해야 완전 전환이다. |
| `src/external-agents/config.ts`, `src/mcp/config.ts`                            | 각 FS 1개: 동기 공개 config read/overview 계약. async 호출부로 바꾸면 공식 FS로 전환 가능하다. hash/path는 이미 공식 서비스다.                                                                                                                            |
| `src/files/listing.ts`                                                          | FS 1개: bounded directory handle/Dirent/lstat. Path 1개: 공식 Path에 없는 posix.matchesGlob. callback 취소/Git 프로세스는 이미 Effect다.                                                                                                                  |
| `src/files/paths.ts`                                                            | FS 1개: 동기 lstat, 심링크 거부와 device/inode 비교. 공식 stat의 정보·동기 경계 계약을 확장해야 한다.                                                                                                                                                     |
| `src/files/text.ts`                                                             | Crypto 1개: 64KiB incremental SHA256. FS 2개: O_NOFOLLOW, positional read, 동일 FD의 nanosecond stat. 단발 해시는 공식 Crypto로 전환했다.                                                                                                                 |
| `src/oauth/validation-harness.ts`                                               | HTTP 1개: 공식 NodeHttpServer의 loopback native factory. Crypto 1개: 일정시간 timingSafeEqual. listener·요청·응답·취소 lifecycle은 공식 서비스다.                                                                                                         |
| `src/runtime/host.ts`                                                           | ChildProcess 1개: process exit에서 동기 process-tree 강제 종료 safety net. FS 1개: 기존 동기 executable 검사/rename callback 계약. 일반 archive 프로세스와 서비스는 공식 구현이다.                                                                        |
| `src/shell/run.ts`                                                              | ChildProcess 1개: 전체 process tree, exitCode/signal, TERM→KILL와 leader 종료 뒤 inherited pipe abandonment의 기존 계약. 공식 spawner는 signal 종료를 PlatformError로 나타내므로 값 형태까지 adapter를 검증해야 한다.                                     |
| `src/skills/skills.ts`                                                          | FS 1개: 동기 catalog/read와 nofollow 검사. 순수 hash/path는 공식 서비스로 전환했다. async catalog 경계나 nofollow 드라이버 확장이 필요하다.                                                                                                               |
| `src/workflow/owner-workflow-engine.ts:220`                                     | 공식 Encoded.register callback의 Effect<unknown, unknown, WorkflowInstance/WorkflowEngine>. 결과는 concrete schema로 검증해 저장한다. generic runtime registry의 오류를 임의의 좁은 타입으로 단언하지 않았다.                                             |
| `src/workflow/owner-workflow-engine.ts:393`                                     | 공식 Activity.Any.executeEncoded의 Effect<any, any, any>. 공식 Workflow.intoResult와 instance context로 소비한다. Effect 자체 실행 엔진도 같은 type-erased API를 쓴다.                                                                                    |
| `tests/io-range.test.ts`                                                        | FS 1개: await 없이 열린 FD를 순간 관찰하는 회귀. async stat로 바꾸면 완료 뒤를 보고 열린 순간을 놓칠 수 있다.                                                                                                                                             |
| `tests/support/fake-acp-agent.ts`                                               | Stream 1개: native ACP stdout/stdin WebStream adapter. production과 동일 프로토콜·flush를 검증한다.                                                                                                                                                       |
| `tests/support/http.ts`, `apps/agent/server/tests/dev-hmr-api-recovery.test.ts` | 각 HTTP 1개: 공식 HTTP 서버 또는 Vite native proxy의 loopback factory. HTTP 요청은 공식 HttpClient로 전환했다.                                                                                                                                            |

## 검증

- `vp install`: 통과, lockfile 변경 불필요.
- 전체 `vp test --run --maxWorkers=2`: **247파일·1,372테스트 통과, 3개 건너뜀**, exit 0 (`/tmp/effect-warning-full-tests-1.log`). GPU/CPU 캐시 모델을 포함하는 기본 수집 조건을 그대로 사용했으며 skip 조건은 변경하지 않았다. 유료 모델·실제 구독 SDK·로그인·라이브 eval/bench는 실행하지 않았다.
- Migrator: 7파일·24테스트 통과. HTTP fixture: 직렬 9파일·121통과. OAuth callback 변경 후 4파일·50통과. provider 19파일·204통과. root hash/path/guidance 7파일·61통과. 최종 작은 lint 수정 회귀 3파일·18통과.
- 실제 FS 주입을 덮어쓰던 archive 회귀를 수정하고 9테스트를 재통과했다. runtime ConfigProvider의 env snapshot이 기존 per-call 재조회 계약을 깨뜨리는 회귀를 발견해 매 호출 새 provider를 제공하고 runtime 4테스트를 재통과했다.
- 전체 타입 검사: 마지막 측정 **일반 오류 0, warning 출력 40개(중복 제외 38곳), exit 1** (`/tmp/effect-warning-typecheck-final-verified.log`). 중간 검사에는 standalone server의 host 경고가 추가 중복되어 42개였다. 이전 기준 684개에서 줄였지만 통과로 표시하지 않는다.
- memory/native worker build와 app build/bundle 통과. React Router dependency의 use-client directive bundler 경고는 남는다. 실제 SEA 패키징·Windows packaging·서명·공증은 미실행이며 CI 범위다.
- dev 격리 smoke: 16180 backend와 16173 UI proxy 모두 동일 buildId `561926a04103fc3067b00bc7`/runtime ID로 ready. 종료 뒤 port 닫힘과 manifest 제거 확인. health는 lazy backend 기동 검사이므로 이 smoke만으로 DB 초기화가 실행됐다고 주장하지 않는다. 기존 5180 서버의 runtime ID/ready는 유지했다. 실제 DB는 read-only로 schema 49와 active run/attempt 0을 확인했다.
- 최종 `vp check`: **820파일 포맷, 729파일 lint/type-aware 검사 통과**, 오류·경고 0, exit 0 (`/tmp/effect-warning-integration-check-last.log`). 최종 Schema decoder 그룹화 뒤 관련 2파일·7테스트, dev 오류 출력 보완 뒤 2파일·3테스트도 통과했다.
- 최종 `vp run --no-cache agent#bundle`: 5개 build task 통과 (`/tmp/effect-warning-bundle-last.log`). 기존 기본 dev 서버는 앞선 bundle로 실행 중이며 이번 변경을 반영하기 위한 재시작은 수행하지 않았다. source 경고 예외 승인이나 전역 ignore 옵션은 추가하지 않았다.
- 실제 문서 명령 `vp run agent#dev --backend-port 16180 --web-port 16173 --storage /tmp/context-agent-effect-dev-final.kYUSKS --manifest /tmp/context-agent-effect-dev-final.kYUSKS/dev.json`도 격리 검증했다. backend와 UI proxy는 buildId `89d7402229c65efd96891bec`, runtime ID `cb3d3b27-01bb-4f17-8aa6-82e4c3ba307f`로 ready였다. SIGINT 뒤 supervisor exit 0, 두 port 닫힘, manifest 삭제를 확인했다 (`/tmp/app-dev-smoke-repro.log`). 기존 5180 ID는 유지했다.
- 최초 샌드박스 내 smoke는 로컬 socket 접근 제한 상태에서 시작 전 exit 1이었다. Cause가 `undefined`로 출력되는 별도 문제를 발견해 `runPromiseExit`와 `Cause.pretty`로 고쳤다. 실제 포트를 점유한 격리 fixture에서 exit 1과 EADDRINUSE 원인 출력도 통과했다 (`/tmp/app-dev-port-conflict.log`).

커밋·푸시·배포·failed run 재생·앱 세션 메시지 전송은 수행하지 않았다. 기존 병행 dirty 변경을 보존했다.

## 후속: 남은 경계의 실제 전환과 결정 사항

앞선 40개 경고를 남긴 결과는 경고 정리 전체 완료가 아니다. 후속 구현에서 MCP·외부 ACP 설정 읽기/overview/available/신뢰 검사, Skills catalog/read, CLI 폴더 검사, dev owner lock의 수명을 실제 비동기 Effect 서비스로 바꾸고 호출부도 함께 변경했다. 외부 ACP 실행은 공식 ChildProcessSpawner와 연결별 Scope, SDK Web Stream은 공식 NodeStream/NodeSink와 실제 backpressure/close를 관리하는 서비스로 전환했다. 브라우저 SDK의 fetch 경계도 공식 HttpClient와 응답 스트림 소유권으로 변경했다. Goal asset의 일반 생성·채택·검증·폐기는 공식 FileSystem과 Semaphore로 직렬화하며 Worker 생성 직전의 동기 fence는 보존했다. text의 mkdir/rename/remove도 공식 서비스다. 이 항목들의 후속 최종 검증은 별도로 기록한다.

아래 표는 설치된 4.0.2를 기준으로 한 당시 조사다. 모든 공식 버전에 없는 API라는 뜻이 아니다. 후속 PR #8900 재검증에서 4.0.3의 noFollow·positional read 지원을 확인했으며 아래 마지막 절이 최신 판단이다. 진단을 없애려고 import를 다른 파일로 옮기거나 타입을 단언하지 않았다.

| 필수 계약                               | 설치된 공식 API의 근거                                                                                                                                                                                                                          | 범위를 넓힐 때 필요한 실제 작업                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loopback HTTP factory                   | `@effect/platform-node/src/NodeHttpServer.ts:449–452,478–480`은 native Server factory를 받는다. layerTest는 host 설정 없이 port 0을 쓴다. checker 0.51.1에서도 factory import를 경고한다.                                                       | checker의 `internal/rules/node_builtin_import.go:117,132–140`는 심볼 사용처 없이 모듈명만 검사한다. 공식 make/layer/layerConfig의 factory 전용 사용을 판별하도록 검사기의 심볼 분석과 회귀를 수정해야 한다. 직접 HTTP 요청·listen/close 경고는 유지해야 한다. |
| Ed25519 서명과 일정시간 비교            | `effect/src/Crypto.ts:81–174,235–242`에는 randomBytes/digest/UUID/ULID만 있다. release-contract sign/verify와 OAuth timingSafeEqual은 digest로 대체되지 않는다.                                                                                 | Crypto 서비스에 key import·sign·verify·constant-time equality와 Node 및 타 플랫폼 드라이버를 추가하고, 현재 키/서명 bytes·검증 실패·보안 계약을 대조해야 한다. 별도 앱 서비스로 감싸기만 하면 native import 경고는 남는다.                                    |
| nofollow·정밀 파일 식별·Dirent 스트리밍 | `FileSystem.open` flag는 문자열 목록뿐이며 O_NOFOLLOW가 없다. NodeFileSystem.stat은 링크를 따른다. File.Info에는 ctimeNs/mtimeNs가 없으며 bigint dev가 안전 범위를 넘으면 오류, 큰 inode는 None이다. readDirectory는 이름 배열 전체를 반환한다. | lstat, nofollow open, 동일 FD의 정밀 bigint stat, 제한·취소 가능한 scoped Directory 스트림을 공식 서비스와 드라이버에 추가해야 한다. 심링크 치환·같은 FD 검증·큰 inode·시간 정밀도·취소/close 회귀가 필요하다.                                                |
| SQLite atomic 안 commit 직전 파일 fence | `owner-native-artifacts.ts` atomic callback의 verifyAtFence 다음에 publication row를 저장한다. 공식 NodeFileSystem readFile/realPath는 비동기 callback 기반이다.                                                                                | 동기 파일 드라이버를 공식 제공하거나, 트랜잭션과 파일 변경 방지를 묶는 별도 lease/게시 프로토콜을 설계해야 한다. 검사를 transaction 밖으로 옮기면 기존 fence 계약을 보존하지 못한다.                                                                          |
| Worker 생성 직전 동기 lease 검증        | full-loop-execution의 NodeWorker.layer 동기 factory가 검증 뒤 즉시 Worker를 만든다. 일반 asset I/O는 후속에서 이미 Effect로 바꿨다.                                                                                                             | Worker 획득·registry 폐기·취소·실제 종료와 lease의 수명을 함께 관리하는 비동기 admission/finalizer 프로토콜이 필요하다. 단순 hook의 Promise 반환은 원자성을 보존하지 못한다.                                                                                  |
| 범용 Workflow 실행                      | 공식 Encoded.register는 Effect<unknown, unknown, …>, Activity.Any.executeEncoded는 Effect<any, any, any>다. 현재 결과는 concrete schema로 저장한다.                                                                                             | 공식 encoded 실행 인터페이스의 타입 소거 설계와 검사기의 공식 API 경계 인식을 함께 바꾸거나, 범용 엔진을 특정 workflow에만 허용하도록 제한해야 한다. 좁은 타입 assertion은 해결이 아니다.                                                                     |
| 프로세스 signal/process-tree 종료       | 공식 ChildProcessHandle.exitCode는 signal 종료를 PlatformError로 표현하며 실제 signalCode를 공개하지 않는다. 동기 process.exit safety net은 Effect 종료를 기다릴 수 없다.                                                                       | signal 정보 및 arbitrary process group 종료를 드라이버에 추가하고, leader 종료 뒤 inherited pipe·TERM→KILL·Windows tree 종료 계약을 검증해야 한다.                                                                                                            |
| bounded incremental SHA256 / POSIX glob | Crypto.digest는 전체 Uint8Array를 받으며 Path에는 matchesGlob가 없다.                                                                                                                                                                           | 스트리밍 digest 드라이버와 기존 Node POSIX glob 의미를 보존하는 공식 Path capability 및 호환 회귀가 필요하다.                                                                                                                                                 |
| CLI bootstrap 환경 전달                 | main의 storage/SEA runtime 환경 설정을 lazy runtime 모듈과 별도 worker/SDK가 상속한다. ConfigProvider는 설정 읽기를 제공하며 process 환경 setter가 아니다.                                                                                      | 앱 runtime 생성 시 CLI ConfigProvider를 주입하고, resources.runtimeRoot의 동기 per-call 환경 계약과 worker/SDK의 명시적 env 전달 호출부를 함께 재설계해야 한다.                                                                                               |

사용자에게 필요한 결정 하나를 요청했다: 기존 보안·DB 계약을 보존하는 필수 경계만 근거 있는 개별 예외로 인정할지, 공식 Effect 드라이버/API와 검사기 확장까지 작업 범위를 넓힐지. 답변 전에는 어떠한 추가 진단 억제도 적용하지 않는다. 독립적으로 가능한 앱 변경은 계속 진행한다.

요청한 질문의 문구는 다음과 같다.

> 공식 API와 검사기의 한계가 확인됐습니다. 최신 검사기도 공식 NodeHttpServer에 필수인 createServer를 경고하고, Crypto에는 Ed25519·일정시간 비교가 없으며 FileSystem에는 O_NOFOLLOW·나노초 stat가 없습니다. 기존 보안·DB 계약을 보존하면서 이 필수 경계만 근거가 있는 개별 예외로 인정할까요, 아니면 Effect 드라이버/API와 검사기 자체의 확장까지 작업 범위를 넓힐까요? 후자는 FileSystem·Crypto·Workflow 및 각 플랫폼 드라이버와 검사 규칙을 함께 수정·검증해야 합니다. 해결 가능한 앱 코드는 답변과 별개로 계속 수정합니다.

선택지는 `필수 경계만 개별 예외 인정`과 `Effect·검사기 확장까지 진행`이다. 전자는 해당 위치와 이유를 기록한 예외가 필요하며 전역 경고 무시는 허용하지 않는다. 후자는 저장소 앱 변경을 넘어 공식 capability와 플랫폼 구현·검사 규칙·회귀 검증을 추가한다. 둘 중 어떤 선택도 아직 승인됐다고 취급하지 않았다.

이 질문 뒤 사용자가 PR #8900 및 Workflow의 구체 타입 패턴 재검증을 요청했다. 예외 제안은 보류하며, 공식 API 적용 가능성을 다시 검증한 결과를 마지막 절에 기록한다. 이전의 범위 확대/예외 선택을 해결의 유일한 방법으로 취급하지 않는다.

### 후속 경계 진단의 정확한 위치

아래는 `/tmp/effect-warning-followup-types-final.log`의 27개 경고이며 일반 오류는 0개다. 추가 억제 없이 남겼다. 각 계약과 드라이버/검사기 확장 작업은 바로 위 표에 있다. 상대 URL fixture 후속 수정의 검증 결과는 아래에 추가한다.

| 파일:행:열                                                           | 진단       |
| -------------------------------------------------------------------- | ---------- |
| `apps/agent/scripts/package.ts:8:28`                                 | `TS377057` |
| `apps/agent/scripts/package.ts:10:23`                                | `TS377057` |
| `apps/agent/server/launch-project.test.ts:7:30`                      | `TS377057` |
| `apps/agent/server/main.ts:156:3`                                    | `TS377076` |
| `apps/agent/server/main.ts:173:25`                                   | `TS377076` |
| `apps/agent/server/release-contract.test.ts:2:37`                    | `TS377057` |
| `apps/agent/server/release-contract.ts:4:30`                         | `TS377057` |
| `apps/agent/server/serve.ts:10:73`                                   | `TS377057` |
| `packages/memory-agent/src/agent/goal-worker-assets.ts:6:44`         | `TS377057` |
| `packages/memory-agent/src/agent/native-artifact-loader.ts:10:8`     | `TS377057` |
| `packages/memory-agent/src/agent/owner-native-files.ts:3:44`         | `TS377057` |
| `packages/memory-agent/src/files/listing.ts:9:32`                    | `TS377057` |
| `packages/memory-agent/src/files/listing.ts:11:23`                   | `TS377057` |
| `packages/memory-agent/src/files/paths.ts:9:53`                      | `TS377057` |
| `packages/memory-agent/src/files/text.ts:4:28`                       | `TS377057` |
| `packages/memory-agent/src/files/text.ts:15:27`                      | `TS377057` |
| `packages/memory-agent/src/files/text.ts:17:22`                      | `TS377057` |
| `packages/memory-agent/src/oauth/validation-harness.ts:6:30`         | `TS377057` |
| `packages/memory-agent/src/oauth/validation-harness.ts:11:45`        | `TS377057` |
| `packages/memory-agent/src/runtime/host.ts:3:23`                     | `TS377057` |
| `packages/memory-agent/src/shell/run.ts:5:23`                        | `TS377057` |
| `packages/memory-agent/src/skills/skills.ts:13:23`                   | `TS377057` |
| `packages/memory-agent/src/workflow/owner-workflow-engine.ts:220:37` | `TS377030` |
| `packages/memory-agent/src/workflow/owner-workflow-engine.ts:392:58` | `TS377030` |
| `packages/memory-agent/tests/io-range.test.ts:2:50`                  | `TS377057` |
| `packages/memory-agent/tests/support/http.ts:2:30`                   | `TS377057` |
| `apps/agent/server/tests/dev-hmr-api-recovery.test.ts:14:50`         | `TS377057` |

### 후속 검증 기록

- 공식 Migrator와 기존 연결을 사용하며 schema 49, `user_version`/이력 일치, metadata 최초 채택, 동시 마이그레이션, 실패 rollback을 검증했다. DB 드라이버를 변경하거나 사용자 DB를 복사하지 않았다.
- 최종 앱·memory·runtime bundle 5개 task 통과: `/tmp/effect-warning-followup-build-verified.log`.
- `vp run typecheck`: 일반 오류 0, 고유 경고 위치 27, exit 1. 실행 로그에는 `runtime/host.ts`가 standalone 서버 검사에도 포함되어 28회 출력된다. unstable 외 진단 억제와 전역 exit-code 무시는 없다: `/tmp/effect-warning-followup-typecheck-last.log`.
- 첫 후속 전체 회귀는 RRSI 상대 URL 오류 2개가 실패했다. 브라우저 문서 위치 기준 URL 해석 및 네트워크 오류 원본 보존을 수정했다. 다음 회귀는 1,381개 통과, URL 검증 assertion 1개 실패, 3개 skip이었다. lint 수정 중 URL 객체를 문자열과 직접 비교한 테스트 오류를 고쳤고 관련 3파일·15개가 통과했다: `/tmp/effect-warning-followup-final-ui-tests.log`. 마지막 전체 재검증 결과는 아래에 기록한다.
- 격리 dev 명령은 임시 storage `/tmp/context-agent-effect-dev-followup.arNFwM`, backend 16180, web 16173, 별도 manifest로 검증했다. 두 health의 build ID는 `656a5e89637184d57675d996`, runtime ID는 `ee0b03e3-3255-4ddb-8e83-6bcf82a3c68d`, ready였다. 해당 supervisor만 SIGINT로 종료한 뒤 exit 0, owner lock·manifest 삭제, 양쪽 port 닫힘을 확인했다: `/tmp/effect-warning-followup-dev-smoke.log`. health 확인은 lazy 사용자 DB 초기화를 실행했다는 뜻이 아니다.
- ACP 승인 중계 통합 테스트는 실제 프로세스 시작과 3개 대기를 포함하지만 Vitest 기본 5초 제한이었다. 각 대기의 기존 6초 제한은 그대로 두고 테스트 전체 제한을 20초로 명시했다. 해당 파일 12개 테스트가 통과했다: `/tmp/effect-warning-followup-acp-complete.log`.
- 기본 dev 서버 재시작 직전 실제 DB를 readOnly로 검사했다. `chat_runs`, `work_tasks`, `agent_run_attempts`에 running/queued/waiting/resuming 상태가 없었다. 검증된 기존 supervisor PID 22977만 SIGTERM으로 종료했고 5173/5180이 닫힌 뒤 `vp run agent#dev`를 실행했다. 새 backend와 UI proxy 모두 build ID `656a5e89637184d57675d996`, runtime ID `3305295c-9b4c-4d7f-a060-dfc15e2771f4`, ready였다. 시작 로그는 `/tmp/effect-warning-followup-default-dev.log`다. 서버는 실행 상태로 남겼다.
- 재시작 뒤 readOnly DB 확인: schema 49 유지, runs aborted 41/completed 1264/failed 328, tasks blocked 1/cancelled 7/completed 1907/failed 12, attempts cancelled 7/completed 1907/failed 12/interrupted 1로 직전과 동일했다. failed run 재생·앱 메시지 전송·모델 실행은 하지 않았다. health 검증만으로 lazy Migrator 초기화까지 실행했다고 주장하지 않는다.
- `vp check` 최종: 821파일 포맷, 730파일 lint/type-aware 검사 통과, 오류·경고 0, exit 0: `/tmp/effect-warning-followup-check-final-complete.log`. 별도 Effect typecheck의 27개 고유 진단은 위와 같이 남아 있다. Windows 패키징은 사용자 지시대로 CI 검증 대상으로 남겼다.
- 최종 `vp test --run --maxWorkers=2`: **247파일·1,382테스트 통과, 기존 3개 skip, 실패 0, exit 0**. 마지막 코드 상태에서 전체 회귀가 통과했다: `/tmp/effect-warning-followup-full-tests-final.log` (250.87초). 앞선 URL assertion 실패와 ACP timeout은 위 수정으로 해결했다. CodeGraph sync 및 `git diff --check`도 통과했다.

## PR #8900 및 Workflow 재검증

사용자의 PR 근거에 따라 “공식 FileSystem에 noFollow가 없다”는 일반화와 “공식 API 경고라 예외가 필수”라는 결론을 철회한다. 예외 승인은 없으며 추가 억제는 없다.

- [PR #8900](https://github.com/Effect-TS/effect/pull/8900)은 2026-10-08 06:46:47 UTC에 merge commit `182e26dae1c8d16adf0372b6b106babb87d0f7b0`으로 머지됐다. [Effect 4.0.3 release](https://github.com/Effect-TS/effect/releases/tag/effect@4.0.3)에 포함됐으며 태그 소스도 대조했다.
- 설치본 effect/platform-node/node-shared는 4.0.2다. Effect 4.0.2 npm 게시일은 10월 7일로 해당 PR 이전이다. 설치본 `FileSystem.open` 옵션은 flag/mode뿐이고 Node 드라이버도 noFollow 분기가 없다. 4.0.3 태그는 `noFollow: true`, `File.ReadOptions.position: bigint`를 제공한다.
- 공개 npm registry 재검증 시 effect latest는 4.0.2이며 effect 4.0.3 버전 metadata와 tarball은 없다(404). platform-node 4.0.3은 peer effect `^4.0.3`, node-shared `^4.0.3`을 요구한다. 따라서 GitHub 릴리스와 npm 배포 상태가 다르다. 혼합 버전·임시 타입 확장·node_modules 수동 패치는 적용하지 않았다. 공개 API로 정상 설치할 호환 조합이 현재 차단 요인이다.
- 새 noFollow는 마지막 경로의 심링크를 거부한다. POSIX Node/Bun에서 지원하며 Windows/Deno는 BadArgument로 실패한다. 부모 경로 검증, lstat, 동일 FD의 nanosecond ctime/mtime·정밀 bigint identity를 추가하지는 않는다. text의 위치 지정 읽기는 새 API로 이행 후보지만 나머지 정밀 stat 계약까지 자동 대체되지는 않는다. 동기 Worker 생성/SQLite commit fence도 비동기 open 옵션과 별개다.
- 4.0.3은 UUID 메서드를 Effect 값에서 옵션을 받는 함수로 바꾼다. 호환 조합이 게시되면 noFollow/positional read뿐 아니라 UUID 호출부·Workflow 복구/중단 변경을 함께 검증해야 한다.

### Workflow의 구체 타입과 저장 경계

공식 공개 `WorkflowEngine.register`는 Name/Payload/Success/Error/R 제네릭을 제공하며, `Activity.Activity<Success, Error, R>`도 concrete schema Type을 유지한다. 이 API를 사용하는 도메인 실행은 any로 작성할 필요가 없다. 프로젝트의 등록/호출과 새 회귀도 구체 schema를 사용한다.

반면 현재 custom durable engine이 구현하는 `WorkflowEngine.Encoded.register`는 공식 4.0.2와 4.0.3 모두 Effect<unknown, unknown, WorkflowInstance | WorkflowEngine> callback을 받으며, `Activity.Any.executeEncoded`는 양 버전에서 Effect<any, any, any>다. 공식 makeUnsafe/메모리 엔진도 해당 encoded 경계를 사용한다. 이 사실은 두 진단의 발생 원인이지, 다른 제네릭/typed registry 설계가 불가능하다는 증명은 아니다. 공개 typed registry로 바꿀 때는 등록 시 서비스 캡처, heterogeneous workflow schema, scoped 실행·중단·suspension·복구 계약을 실제로 이행해야 한다. 단순 generic 전달 helper, 넓은 타입을 좁혀 단언하기, import 이동으로 진단을 숨기지는 않았다.

조사 중 `Activity.executeEncoded` 결과에 success/error schema를 다시 적용하는 실제 버그를 발견했다. FiniteFromString으로 42를 인코딩한 결과는 이미 문자열인데 두 번째 encoder가 숫자를 요구해 codec 오류가 발생했다. 회귀에서 실패를 확인한 뒤 encoded Exit 자체만 저장/복구하고 공식 makeUnsafe가 concrete schema를 한 번 디코딩하도록 수정했다. 기존 identity codec의 저장 형식은 유지한다. 이 수정은 `Activity.AnyWithProps` 타입 단언도 제거했다. schema 49와 기존 DB는 변경하지 않았다.

### 남은 진단의 적용 범위 재대조

위 27개 위치 표는 계속 유효하며 Activity 위치는 392행이다. 각 경고를 새 PR의 범위와 대조한 결과:

| 위치 그룹                                                                            | 현재 코드의 실제 계약과 PR #8900 영향                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text.ts의 fs 2곳·crypto                                                              | nofollow open/positional read는 4.0.3의 실제 대체 후보다. 동일 FD의 nanosecond/bigint stat와 64KiB incremental hash는 별도다. 해당 source comment도 설치 버전을 명시하도록 정정했다.          |
| native-artifact-loader.ts                                                            | 동기 openSync O_NOFOLLOW·같은 FD의 fstat/read·realpath 검증. 새 비동기 noFollow만으로 동기 Worker factory fence를 치환하지 못한다.                                                            |
| owner-native-files.ts·goal-worker-assets.ts                                          | SQLite publication 직전 동기 realpath/bytes hash·Worker lease fence. 일반 파일 작업은 이미 Effect이며 PR은 동기 fence API를 추가하지 않는다.                                                  |
| paths.ts·skills.ts                                                                   | lstat의 link 자체 식별과 segment/device/inode 검증. PR의 open noFollow는 lstat를 추가하지 않는다.                                                                                             |
| listing.ts fs/path                                                                   | bounded scoped Dirent 순회와 POSIX matchesGlob. PR은 directory stream/glob capability를 추가하지 않는다.                                                                                      |
| package.ts fs/crypto                                                                 | 자산 symlink 제외 lstat·bounded incremental SHA256. noFollow 옵션과 별개다.                                                                                                                   |
| release-contract.ts 및 테스트·OAuth crypto                                           | Ed25519 sign/verify·일정시간 비교. FileSystem PR과 별개이며 digest 치환은 해당 계약을 보존하지 않는다.                                                                                        |
| launch-project.test.ts·OAuth HTTP·tests/support/http.ts·dev-hmr-api-recovery.test.ts | 공식 NodeHttpServer에 loopback createServer factory를 전달한다. 네트워크 lifecycle은 공식 서비스다. checker가 import 모듈명만 검사하는 근거를 앞 절에 기록했다. 진단 예외를 추가하지 않았다.  |
| serve.ts                                                                             | React Router의 native request/response server bridge. noFollow와 별개다.                                                                                                                      |
| main.ts env 2곳                                                                      | CLI storage/SEA runtime 설정의 lazy runtime·SDK·worker 상속. read Config로 setter를 치환할 수 없으며 명시적 bootstrap provider/env 전달로 이행할 여지가 남는다.                               |
| host.ts·shell/run.ts                                                                 | 동기 emergency process tree 종료 및 signal/leader 종료 후 inherited pipe 계약. FileSystem PR과 별개다.                                                                                        |
| io-range.test.ts                                                                     | 실제 열린 FD의 순간 관찰. native 보안 handle의 회귀가 제거되지 않았으므로 유지한다.                                                                                                           |
| owner-workflow-engine.ts 2곳                                                         | encoded 실행 계약의 unknown/any. concrete schema 중복 인코딩 버그와 불필요한 단언은 수정했으나 이 두 진단은 남는다. typed registry의 추가 설계 검토 대상이며 예외 필수라고 결론내리지 않는다. |

검증: 관련 Workflow/engine/goal contract 3파일·10개 통과 (`/tmp/effect-pr8900-workflow-tests.log`), bundle 5 task 통과 (`/tmp/effect-pr8900-build.log`), `vp check` 821파일 포맷/730파일 lint 통과 (`/tmp/effect-pr8900-check.log`). 별도 전체 타입 검사 일반 오류 0, Effect 경고 27, exit 1 (`/tmp/effect-pr8900-typecheck-final.log`). 초기 회귀는 의도한 codec 실패를 재현했으며 새 테스트의 finite schema 검사도 수정했다. 마지막 전체 회귀 결과는 아래에 기록한다.

PR 재검증 후 최종 전체 회귀: **247파일·1,383개 통과, 기존 3개 skip, 실패 0, exit 0** (`/tmp/effect-pr8900-full-tests.log`, 254.49초). 최종 `vp check`도 포맷·lint·type-aware 검사 오류/경고 없이 통과했다 (`/tmp/effect-pr8900-check-complete.log`). 별도 Effect 타입 검사는 일반 오류 0·경고 27로 exit 1이며 경고 정리 전체 완료가 아니다.

활성 작업이 없음을 readOnly로 확인한 뒤 프로젝트 supervisor PID 20503만 정상 종료하고 `vp run agent#dev`로 수정 bundle을 반영했다. 5173 UI proxy와 5180 backend는 모두 build ID `76af09a690b3ef0e1ad28f5d`, runtime ID `ec0d4c7c-6d83-4ce6-8144-153731ce7d18`로 ready이며 실행 중이다. schema 49와 직전 run/task/attempt 기록 수는 모두 유지됐다. 로그는 `/tmp/effect-pr8900-default-dev.log`다. CodeGraph sync 및 diff 검증도 통과했다. 모델 호출·실패 run 재생·커밋·push·진단 예외 추가는 하지 않았다.

### 후속: registry 및 encoded 제네릭 경계의 구체 제약

프로젝트에서 npm config의 registry URL만 비밀정보 없이 읽어 확인한 값은 `https://registry.npmjs.org/`다. 같은 공식 URL의 `/effect/4.0.3` 응답은 HTTP 404였다 (`/tmp/effect-403-metadata-check.json`). 사설 registry나 프로젝트 registry 설정 차이에 의한 버전 불일치가 아니다. npm devEngines는 이 프로젝트의 pnpm 사용을 요구하므로 첫 npm config read는 EBADDEVENGINES로 거부됐다. 읽기 전용 config 조회에만 force를 사용했으며 설치·설정 수정은 하지 않았다. GitHub/git/tarball 의존성으로 우회하지 않았다. 이 부분의 최소 다음 단계는 공식 effect 4.0.3 게시 확인 후 effect/platform-node/node-shared/vitest 호환 조합의 실제 metadata·API를 대조해 적용하는 것이다.

Workflow는 공식 문서, 설치본과 4.0.3 태그의 makeUnsafe·메모리 엔진 예제를 다시 대조했다. 구체적인 제약은 아래와 같다.

1. owner-workflow-engine.ts:220의 저장된 callback은 공식 `Encoded.register`에서 받은 `Effect<unknown, unknown, WorkflowInstance | WorkflowEngine>`다. 원래 공개 register의 Success/Error/R 제네릭은 makeUnsafe가 encoded callback을 만들 때 이미 소거된다. schema는 runtime 값과 codec을 검증하지만 TypeScript의 원래 Error 타입 및 R 서비스 목록을 복원하지 않는다. 임의 TaggedError wrapping, orDie, assertion은 저장된 오류나 suspension 계약을 바꾸거나 진단을 숨기므로 적용하지 않았다.
2. 392행의 `Activity.Any.executeEncoded`도 공식 인터페이스에서 `Effect<any, any, any>`다. 저수준 callback에는 공개 Activity.Activity<Success, Error, R>의 제네릭이 없다. makeUnsafe가 반환 뒤 concrete schema를 적용하므로 여기에 decoded activity 실행을 대신 넣으면 현재 encoded 저장/복구 프로토콜과 서비스 요구 타입을 함께 다시 구현해야 한다. 이전의 AnyWithProps 단언은 실제 중복 인코딩 수정에서 이미 제거했다.
3. 공개 typed register를 별도로 구현해 type erasure 이전에 Result를 캡처하는 대안을 검증했다. 등록 시 `Context<Exclude<R, RuntimeServices>>`를 캡처하고 실행 시 `Context<RuntimeServices>`와 합성하는 정상 설계에서도, 현재 공개 타입으로 `Context<RuntimeServices | Exclude<R, RuntimeServices>>`를 `Context<R>`에 대입하면 TS2322가 발생한다. `/tmp/effect-workflow-context-probe.ts`와 `/tmp/effect-workflow-context-probe-final.log`의 3행이 단언 없는 최소 컴파일 재현이다. official makeUnsafe는 같은 context 합성에 `as Context<any>`를 사용한다. R 전체를 등록 시 요구하면 공개 register가 내부 WorkflowInstance/Execution/Scope를 제외한다는 계약이 깨진다. Context.fromEntries 등의 임의 타입 인수나 generic forwarding helper로 숨기지 않았다. 이 재현은 모든 다른 엔진 설계가 불가능하다는 증명은 아니다.

현재 makeUnsafe/Encoded 형태를 유지하면서 두 Effect 채널 진단을 없애려면 **타입이 소거되기 전에 공식 wrapper가 Workflow.intoResult 및 서비스 캡처를 완료하고, 저수준 adapter에는 never-error Result 실행 closure를 전달하는 API**가 필요하다. register의 prepared runner 및 activity의 scoped prepared runner를 공개하면 앱은 오류를 값인 Workflow.Result로 저장하면서 unknown/any 오류·서비스 Effect를 직접 실행하지 않아도 된다. 이때 기존 SuspendOnFailure/CaptureDefects, interruption, activity retry, 동일 execution replay와 codec 저장 형식을 검증해야 한다. 이는 검사기 예외 요구가 아니라 현재 소비 가능한 adapter API의 구체 변경 지점이다. 공개 typed service를 직접 구현하는 대안은 서비스 캡처/heterogeneous registry의 별도 구조 검증이 필요한 후속 설계이며, 완료됐거나 불가능하다고 표현하지 않는다.

버전과 무관한 나머지 경고도 이전 위치 표와 실제 코드에 대조했다. 추가로 main.ts의 env setter 두 곳은 lazy agent storage 선택과 resources.runtimeRoot의 per-call lookup을 연결하며, runtimeRequire/runtimeArtifact/runtimeWorker/builtinSkillsDirectory가 이를 사용한다. 읽기 Config API로 setter를 바꾸면 SDK/worker의 기존 환경 상속을 보존하지 못한다. 명시적 bootstrap/runtime locator 주입으로 이행할 여지는 있지만 단순 경고 제거 치환이 아니다. package.ts의 lstat는 symlink 제외 목록, Skills의 lstat는 디렉터리 symlink 거부·일반 파일 분류와 이후 no-follow open을 담당한다. readLink + stat의 두 단계 검사로 바꾸면 원래 단일 lstat 시점의 non-follow metadata 계약이 달라지므로 진단만 없애려고 치환하지 않았다. 이 항목들도 예외 승인 또는 전환 불가능으로 처리하지 않았다.

이번 후속은 조사와 컴파일 재현 및 문서 변경이며 새 product 코드·DB 변경은 없다. 따라서 직전 247파일·1,383개 통과 결과를 새 테스트 실행으로 표시하지 않는다. 경고 정리는 여전히 완료되지 않았다.

이번 후속의 새 검사: `vp check` 821파일 포맷·730파일 lint/type-aware 통과 (`/tmp/effect-encoded-followup-check.log`); `vp run typecheck` 일반 오류 0, 27개 고유 Effect 진단 위치, host.ts의 standalone 재검사를 포함한 출력 28회, exit 1 (`/tmp/effect-encoded-followup-types.log`). diff 검사 통과. 예외·타입 단언·import 우회·진단 억제는 추가하지 않았다.

### 공식 main preview 설치 및 호환 검증 (2026-10-11 후속)

사용자가 preview 설치를 승인했다. effect / @effect/platform-node / @effect/platform-node-shared / @effect/vitest 네 패키지를 공식 main CI 커밋 844a77b18c03b4faa386cf04bf94908d3d37abc7의 전체 SHA URL로 고정했다. 모든 설치 버전은 4.0.3이고 각 패키지에서 해석한 Effect 경로가 동일하여 Effect 사본은 한 개다. root package.json, pnpm-workspace.yaml, pnpm-lock.yaml에 반영했으며 사용자의 다른 의존성 변경을 보존했다. 최초 lockfile 해석은 승인된 preview의 exotic 하위 의존성을 허용하는 일회성 PNPM_CONFIG_BLOCK_EXOTIC_SUBDEPS=false를 사용했다. 영구 정책 변경 없이 이후 vp install --frozen-lockfile은 기본 공급망 검사로 통과했다. vp env doctor도 통과했다. Effect 계열 peer 불일치는 없으며 기존 TypeScript 7 / typescript-eslint 및 oxc-transform-react / plugin-react peer 경고는 별도다.

preview의 UUID API가 Effect 값에서 함수로 변경되어 app, memory-agent, eval, 테스트의 호출부 41개 파일을 함수 호출로 맞췄다. readFileBytesEffect는 공식 scoped FileSystem.open({ noFollow: true }) 및 File.read({ position })를 사용한다. 여러 64KiB chunk 보존, symlink leaf 거부, hard-link 거부 테스트를 추가했다. Windows/Deno처럼 noFollow를 지원하지 않는 플랫폼은 BadArgument로 안전하게 실패한다. parent directory guard는 기존 caller 책임이다. 편집 파일의 nanosecond fstat / 동일 FD 계약과 native artifact의 동기 admission fence는 유지한다. 공식 파일 Scope가 handle 종료를 담당한다.

검증: 파일/링크/Migrator 3파일 11개 통과 (/tmp/effect-preview-targeted-tests.log). vp check --fix는 730파일 warning/lint/type 오류 없이 통과 (/tmp/effect-preview-check-final.log). 별도 vp run typecheck는 실제 오류 0, Effect 경고 27개, exit 1 (/tmp/effect-preview-types-final.log). Workflow unknown/any 두 경고는 그대로이며 추가 진단 억제는 없다. agent#bundle 5개 task 통과 (/tmp/effect-preview-build.log), 대형 JS chunk 및 bundle의 use client directive 경고는 출력된다. 격리 dev backend 16180은 ready, localhost:16173 UI는 HTTP 200, 정상 종료 후 manifest와 backend.lock이 제거됐다 (/tmp/effect-preview-isolated-dev.log). 기본 실서버는 중단하지 않았고 실제 DB 및 모델 실행을 사용하지 않았다. 실서버 반영은 별도 DB 작업의 마지막 재시작과 조율한다.

전체 회귀 실행 /tmp/effect-preview-full-tests.log에서는 빌드와 겹친 native owner 2초 시작 타임아웃 한 건을 확인했다. 해당 workflow-completion-evidence.test.ts는 이후 단독 재실행 26개 모두 통과 (/tmp/effect-preview-retry-test.log). 전체 최종 결과는 완료 후 아래에 기록한다. CodeGraph 명령이 이 실행 환경에서 발견되지 않아 해당 소스 탐색에 직접 파일 도구를 사용했다.

최종 전체 실행은 247파일 중 244통과·3실패, 1,381통과·3실패·3skip, 303.59초였다. 세 실패는 모두 native owner 시작의 기존 2초 deadline 초과다. workflow-completion-evidence 단독 26개 통과 후, 실패한 workflow-completion-evidence / attachments / workflow-run-bindings 세 파일을 --maxWorkers=1로 다시 실행하여 41개 모두 통과했다 (/tmp/effect-preview-retry-failed-tests-final.log, 26.56초). 전체 실행 자체를 통과로 표시하지 않는다. 첫 세 파일 재시도는 병행 DB 작업의 fingerprint 정규식 수정 중 suite 로딩 SyntaxError로 실제 테스트가 실행되지 않았다 (/tmp/effect-preview-retry-failed-tests.log); 현재 저장된 수정으로 최종 재시도는 통과했다. 테스트 중 vp check는 일시 생성된 .native-cold-execution fixture 두 파일을 포맷 실패로 보았으므로 이를 수정하지 않고 테스트 종료 뒤 검사한다. 이 작업에서는 owner-rpc/fingerprint/DB migration 변경을 하지 않았다. 디스크는 최종 19GiB 여유였고 실서버 재시작·실제 DB 변환·압축·삭제·모델 실행은 별도 DB 작업 소관이다.

테스트 종료 뒤 최종 vp check는 823파일 포맷·732파일 lint/type-aware 통과 (/tmp/effect-preview-check-posttests.log). 현재 병행 DB fingerprint 변경을 포함한 vp run typecheck는 실제 오류 0, Effect 경고 30개 고유 위치 / 출력 31회, exit 1 (/tmp/effect-preview-types-posttests.log). preview 변경만의 27개 경고에 owner-rpc-fingerprint.ts의 pipeable overload 1개 및 synchronous schema decode 2개가 추가되었다. 이 세 경고는 별도 DB 작업 소관이며 host.ts standalone 중복 출력도 포함한다. diff 검사 통과.

### Windows 회귀 수정과 worker deadline 재검증 계획

앞선 noFollow 전환을 Windows 지원까지 완료했다고 처리한 판단을 정정한다. 이전 O_RDONLY | O_NOFOLLOW는 Windows에 없는 O_NOFOLLOW가 0으로 처리돼 정상 파일을 읽었지만 공식 noFollow=true는 Windows에서 open 전에 BadArgument를 반환했다. 따라서 읽기/Skills/replace/delete의 실제 호환 회귀였다. 현재 FileReadPlatform Reference의 명시적 windows/posix 분기로 POSIX 공식 API는 유지하고 Windows native positional read/fstat/typed-close 계약을 복원했다. Windows에서는 lstat로 관찰된 symlink를 열기 전에 거부한다. 이 lstat/open 사이의 링크 교체 경쟁은 원자적으로 차단하지 않으며 기존 caller의 parent/leaf 검증도 계속 필요하다. checkLeaf hard-link 거부와 Skills의 checkLeaf=false 일반 hard-link 허용을 보존했다.

text-file-effect.test.ts의 Windows 정상 읽기/여러 chunk/replace/delete 및 symlink/hard-link 테스트 두 개, skills.test.ts의 posix/windows skill 읽기·link 거부 두 분기를 포함해 범위 실행 2파일 7통과·선택에서 제외한 기존 테스트 6개 미실행 (/tmp/effect-windows-read-regression.log, 5.74초). 이는 Mac에서 Reference로 Windows 분기를 주입한 결과이며 Windows 커널, reparse point, 권한 또는 실제 symlink 생성 권한을 확인한 결과가 아니다. Windows CI는 정상파일 읽기·Skills·replace/delete 및 권한이 허용된 link fixture를 검증해야 한다. Windows에서 POSIX noFollow 테스트를 강제로 실행하지 않는다.

worker 타임아웃 세 건을 모두 빌드 부하로 단정할 수 없다. 이전 4.0.2 전체는 247파일/1,383통과/3skip/254.49초, preview 전체는 244파일통과/3파일실패/1,381통과/3실패/3skip/303.59초였다. 최초 실패 시각 20:26:26은 격리 dev의 빌드/시작과 겹쳤지만 attachments 20:28:35, workflow-run-bindings 20:28:41은 dev supervisor 종료 후였다. 포맷 검사 출력은 20:28:35에 끝났으므로 두 번째와 일부 검사 부하도 겹쳤다. 한 worker 재검사 41통과는 부하 민감성의 근거이며 preview cold-start 성능 회귀를 배제하는 통제된 비교는 아니다. 현재 코드/DB 작업도 병행 변경돼 정확한 A/B는 미실행이다.

후속 재검증은 별도 DB 작업의 압축/마이그레이션 및 다른 build/lint/test가 종료됐다는 확인 뒤 수행한다. lockfile·client/worker·DB schema 관련 소스와 runtime artifact hash를 기록해 동일 입력을 고정하고 임시 DB/저장소만 사용한다. 먼저 실패한 세 파일을 동일 preview에서 1 worker, 이어 2 workers로 순차 실행한다. worker 생성부터 ready까지의 단조 시간은 격리 harness에서 측정하며 제품의 2초 제한은 늘리지 않는다. 동시성에 따라 다시 실패하거나 2초에 근접하면 동일 startup 경로의 4.0.2/preview를 별도 의존성 격리 환경에서 비교해야 한다. 최소 몇 번의 cold-start 결과로 분포와 ready 이전 단계(모듈 로드, native addon, index/readonly DB 초기화)를 비교하며 어떤 단계가 달라졌는지 확인 전에는 preview 회귀를 제외하지 않는다. 기존 assertion/timeout을 완화하거나 기존 실서버를 재시작하지 않는다. 지금 대규모 재검증은 실행하지 않았다.

Windows 수정 뒤 vp check --fix는 733파일 warning/lint/type 오류 없이 통과 (/tmp/effect-windows-read-check.log). memory-agent#typecheck는 실제 타입 오류 0개이며 기존 Effect 경고로 exit 1 (/tmp/effect-windows-read-types.log). diff 검사 통과. 이번 Windows 수정의 제품/테스트 변경 파일은 src/files/text.ts, tests/text-file-effect.test.ts, tests/skills.test.ts이며 docs/decisions.md와 이 기록도 갱신했다. 최신 수정 뒤 대규모 전체 검사·번들·실서버 재시작은 실행하지 않았으므로 별도 DB 작업의 최종 build/regression에 포함해야 한다.

### 명시적 runtime 설정, 전역 소유권 정리 및 개발 export 회귀

이번 범위는 runtime 설정과 backend Scope 소유권으로 제한했다. Workflow와 HTTP의 추가 재설계는 하지 않았다. backend main의 CONTEXT_AGENT_HOME/CONTEXT_AGENT_RUNTIME 환경 변경 두 곳을 제거하고 server entry의 configureAgentBackend로 동일한 compiled agent에 설정한다. contextGeneractiveAgent/contextGeneractiveBackendCleanup 전역은 제거했다. backend Scope는 agent dispose 뒤 storage lock을 해제하며 SIGINT/SIGTERM/SIGHUP/beforeExit listener를 정리한다. 모든 관련 worker 생성에 runtimeWorkerOptions를 적용하여 runtime 경로 snapshot만 workerData metadata에 전달하고 기존 payload와 SDK 환경은 보존한다.

새 `memory-agent/runtime-resources` import에 필요한 workspace package export를 types/development/import/default 조건에 명시했다. 각 조건은 같은 src/runtime/resources.ts를 가리키며 exports:false/dts:false인 workspace source 패키지 정책은 유지한다. deep import/임시 alias는 사용하지 않았다. 실제 linked package에도 export가 있음을 확인했고 새 Vite 개발 인스턴스에서 실제 React Router server build를 로딩하여 대상 세션 URL SSR 200/HTML과 빈 임시 저장소를 확인했다. 이 결과만으로 이미 실행 중인 Vite의 기존 package cache가 갱신됐다고 주장하지 않는다. 사용자 서버는 종료·재시작하지 않았다.

변경 파일: apps/agent/app/.server/agent.ts, app/entry.server.tsx, server/main.ts, server/server-build.d.ts, server/runtime-resources-dev.test.ts; packages/memory-agent/package.json, src/runtime/resources.ts, src/agent/full-loop-execution.ts, src/imports/importer.ts, src/memory/native-search/client.ts, src/memory/embedding/embedder.ts, src/memory/morph/analyzer.ts, src/secrets/sweep.ts. 결정은 docs/decisions.md에 기록했다. 기존 병행 변경과 실제 DB는 수정하지 않았다.

의존성 설치는 sandbox DNS 제한으로 처음 실패하여 node_modules 연결이 불완전해졌다. 동일 frozen lockfile을 승인된 네트워크로 다시 설치해 복구했다 (/tmp/effect-next-install-recovery.log). 현재 Effect preview SHA는 변경하지 않았다. vp run typecheck의 실제 오류는 0이며 Effect 경고는 27→25개, 경고로 exit 1이다 (/tmp/effect-runtime-final-types.log). 새 경고 억제는 추가하지 않았다.

첫 번들 빌드 통과 (/tmp/effect-runtime-bundle.log). 전체 회귀는 249파일 중 247통과·2실패, 1,393통과·2실패·3skip, 351.90초 (/tmp/effect-runtime-full-tests.log). 실패는 owner-read-recovery의 get_subagent_reports와 workflow-completion-evidence의 empty proof 검증에서 native owner 2초 startup-timeout이다. 전체 초반에는 타입 검사를 병행했으므로 이 실행으로 cold-start 성능 회귀를 배제할 수 없다. 제한을 늘리거나 assertion을 완화하지 않았다. 전체 통과로 표시하지 않는다.

최종 재검증: 두 실패 파일과 runtime-resources-dev.test.ts를 --maxWorkers=1로 실행하여 3파일/47개 전부 통과했다 (/tmp/effect-runtime-targeted-final.log, 39.36초). 전체 실행 자체는 실패 상태로 유지한다. vp check는 826파일 포맷 및 734파일 lint/type-aware 검사 통과 (/tmp/effect-runtime-final-check.log). 최종 agent#bundle도 통과 (/tmp/effect-runtime-final-bundle.log). 기존 번들 경고인 use client directive는 남아 있다.

실제 최종 번들을 임시 loopback 포트와 임시 저장소에서 두 번 시작했다. 각 실행에서 /api/health와 홈 SSR 200, SIGTERM 후 exit 0, backend.lock 제거, 같은 포트/저장소 재시작을 확인했다. 두 번 모두 종료 뒤 저장소가 비어 있어 DB가 생성되지 않았다 (/tmp/effect-runtime-backend-lifecycle-final.log). 첫 임시 검증 harness는 잘못된 /api/dev/health 경로로 404를 받아 실패했으며 자기 프로세스만 종료·정리했다. CodeGraph에서 실제 /api/health 경로를 확인한 뒤 vp node의 프로젝트 Node 26.8.2로 최종 검증했다. 이 harness 실패를 제품 실패와 혼동하지 않는다.

vp env doctor는 통과했으며 PATH에서 Homebrew node/npm/npx/yarn과 fnm이 먼저 잡히는 기존 경고가 있다 (/tmp/effect-runtime-env-doctor.log). 직접 node로 수행한 첫 임시 harness는 26.4.0이었으며 최종은 vp node로 수정했다. 운영 DB·모델·사용자 서버는 사용하지 않았고 커밋/푸시는 하지 않았다. 종료 확인 시 5173/5180 listener는 없었다. AGENTS.md에 따라 codegraph init을 호출했고 Already initialized 안내 후 codegraph sync로 13개 변경 파일을 동기화했다. 테스트 파일 위치 탐색에서 rg --files를 먼저 사용한 위반을 사용자에게 인정했고 이후 코드 탐색은 CodeGraph로 수행했다. diff 검사 통과.

남은 범위는 기존 25개 Effect 경고(파일/암호/HTTP/ChildProcess 경계와 Workflow unknown/any), 전체 실행의 native worker 2초 deadline 민감성, 실제 Windows CI 검증이다. 이 작업에서 추가 경고 억제, Workflow/HTTP 재설계, native worker deadline 변경은 하지 않았다.

### Native worker startup-timeout 원인 진단과 실제 로컬 반영

남은 전체 회귀 두 timeout의 진단만 진행했다. 다른 25개 경고나 새 기능은 확장하지 않았다. 제품 변경은 native-search/worker.ts의 전체 @effect/platform-node import를 공식 NodeFileSystem/NodePath 하위 모듈 두 개로 좁힌 것이다. 기존 DB 스키마 검사, SQLite/native 초기화, cache lease, 인덱스 열기와 ready 프로토콜, client의 2초 startup 및 2초 shutdown 제한은 그대로다. 테스트와 assertion을 삭제하거나 timeout을 늘리지 않았다.

/tmp/native-owner-startup-probe.ts의 별도 Node preload로 worker 생성/online, 모듈 로딩, 첫 SQLite 검사, native extension 로딩과 ready를 관측했다. 제품에는 계측을 추가하지 않았다. catalog/lockfile/client/worker/runtime artifact/앱 번들 SHA-256은 /tmp/native-startup-input-before.sha256과 during.sha256으로 고정해 초기 진단 중 일치를 확인했다. paired baseline은 46개 통과, 49회 ready 관측, 1,114모듈/online→ready 중앙값426ms·최대900ms였다 (/tmp/native-owner-startup-paired.log 및 probe/summary.json).

수정 전 계측 전체는 249파일 중 242통과·7실패, 1,386통과·9실패·3skip, 384.15초였다 (/tmp/native-owner-startup-full.log). 원래 두 테스트의 실패만 고정적으로 발생한 것이 아니며 다른 native owner 초기화·후속 계약에도 실패가 나타났다. 482회 ready 관측에서 보통 1,113모듈, preload→ready 중앙값509ms/최대3,969ms, 생성→ready 최대4,020ms였다. 최대 표본의 첫 SQLite 검사 전이3,877ms이고 그 뒤 extension 완료70ms·ready25ms였다. ready가 2초 뒤에 관측된 것은 timeout 후 cleanup 대기 중의 관측도 포함하므로 성공적인 2초 시작이라고 해석하지 않는다. 모듈 로딩 목록에는 @redis/client 478개, bloom58개, time-series46개, search40개, json25개가 있었다. 공식 platform-node index가 NodeRedis를 re-export하여 worker가 사용하지 않는 Redis SDK까지 ESM으로 로딩했다. 이것은 Redis 네트워크 호출이 있었다는 뜻이 아니다.

계측이 없는 원래 실행과 계측 실행의 시간/실패 수를 그대로 성능 A/B라고 단정하지 않는다. preload hook과 파일 기록 자체의 영향이 있으며 모든 OS scheduling 지연 원인을 특정한 것은 아니다. 다만 SQL/native 전에 지연이 발생하는 단계와 불필요한 ESM 의존성은 직접 관측했다. 계측 전체 후반에는 사용자의 즉시 로컬 반영 요청을 우선하여 dev 빌드를 실행했다. 그 전에 발생한 startup 지연도 있었지만 후반 결과는 완전히 무부하인 통제 실행이라고 주장하지 않는다.

공식 subpath 수정 뒤 같은 두 파일/2 workers/계측으로 46개 모두 통과, 49회 ready, 310모듈로 감소했다 (/tmp/native-owner-startup-optimized.log, 12.43초 및 optimized/summary.json). preload→ready 중앙값232ms·최대273ms, 생성→ready 최대322ms, 첫 SQLite 검사 전 최대267ms였다. SQL/migration 관련 모듈은13개로 유지돼 Migrator나 DB 검증을 빼서 만든 결과가 아니다. 최종 전체는 별도 계측 없이 같은 --maxWorkers=2로 실행하며 build/type/lint와 겹치지 않게 했다.

프로젝트는 릴리스 전의 로컬 개발 환경이라는 사용자 교정을 반영했다. 이전의 별도 운영 DB·배포 승인 프레이밍은 적용하지 않는다. 실제 dev가 종료되어 비어 있던5173/5180을 복구했고, 최종 worker 반영 재시작 전 로컬 agent.db를 readOnly로 확인해 running 기록0개 및 대상 세션의 running=null을 확인했다. 제가 시작한 supervisor만 정상 종료·재시작했고 DB 해시 마이그레이션은 재실행하지 않았다. 현재 실제 사용 경로는 buildId57f272d3328bd34ae4dcfa88, instance97a14183-43fb-47d4-913b-ec6ae212b3e2이며 health ready와 대상 세션 페이지200을 확인했다 (/tmp/context-agent-local-dev-final.log). 실제 모델 메시지는 전송하지 않았다. 이 서버는 사용자 요청으로 복구한 dev이며 격리 진단 프로세스와 구분한다.

subpath 수정 뒤 첫 계측 없는 전체 실행은 248파일 통과/1파일 실패, 1,394통과·1실패·3skip, 227.89초였고 startup-timeout은 없었다 (/tmp/native-owner-optimized-full-untraced.log). 유일한 실패는 subagents-async의 concurrent children 테스트의 idle=false assertion이었다. 테스트는 slow parent turn을 fork한 직후 children gate를 해제하여, parent의 SDK turn이 실제로 들어오기 전에 두 children이 완료될 수 있었다. fork의 startImmediately는 외부 비동기 경계까지 실행 완료를 보장하지 않는다. fixture responder가 slow parent의 Deferred gate를 등록했다는 별도 Deferred 신호를 기다린 뒤 children을 완료하도록 순서만 고쳤다. 원래 idle/no-followup/시간 비중첩 assertion은 모두 유지했고 실제 child 및 parent 작업은 계속 격리 fake provider를 사용한다. 제품 Subagents 로직은 변경하지 않았다. 추가 변경 파일은 tests/subagents-async.test.ts다. 이는 타입 검사로 보장되지 않는 실행 순서의 런타임 검증이다.

최종 검증은 해당 동시성 파일과 원래 timeout 두 파일의 3파일/58개 통과 후, 계측 없는 전체 `vp test --run --maxWorkers=2`로 249파일 모두 통과, 1,395개 통과·3skip, 226.44초, exit 0이었다 (/tmp/native-owner-final-full.log). 전체 실행 중 무거운 build/type/lint 검사를 병행하지 않았다. `vp check`는 826파일 포맷 및 734파일 lint/type-aware 검사 통과였다 (/tmp/native-owner-final-check.log). 별도 `vp run typecheck`는 실제 TypeScript 오류 0개, 기존 Effect 경고 25개 때문에 exit 1이다 (/tmp/native-owner-final-types.log). 경고 억제는 추가하지 않았다. 제품 worker 수정 후 `vp run agent#bundle`도 통과했다 (/tmp/native-owner-optimized-bundle.log).

최종 전체 실행 전후 lockfile/client/worker/runtime artifact/앱 번들 SHA-256이 일치했다 (/tmp/native-startup-input-optimized.sha256, final.sha256). codegraph init의 Already initialized 안내 후 sync로 변경한 두 소스 파일을 동기화했고 git diff --check도 통과했다. 2026-10-11 13:46 UTC 이후 실제 로컬 backend의 같은 buildId/instance와 ready, 대상 세션 페이지 HTTP 200을 다시 확인했다. 당시 요청된 실제 dev는 계속 실행 중이었다. 다시 시작할 때는 저장소 루트에서 `vp run agent#dev`를 실행하면 backend 5180과 HMR frontend 5173을 구성한다. DB 마이그레이션은 재실행하지 않았고 커밋/푸시는 하지 않았다. 이번 startup-timeout 후속 작업은 완료했으며 남은 별도 항목은 Effect 경고 25개와 사용자 CI의 Windows 패키징 검증이다. 이후 사용자의 정리 요청으로 supervisor와 backend/frontend 자식을 정상 종료했고 5173/5180, 격리 listener, backend.lock 및 dev manifest 해제를 확인했다.

### release-contract의 공식 Crypto API 재검증

최신 `vp run typecheck` 전체 메시지를 먼저 확인했다 (/tmp/release-crypto-before-types.log). release-contract.ts의 TS377057 전체 안내는 `This module reference uses the crypto module, the corresponding Effect API is Crypto from effect. effect(nodeBuiltinImport)`이며 개별 sign/verify 치환 코드나 Layer 지정은 없다. 25개 전체 진단도 읽었으며 이를 개별 연산 지원 여부의 증거로 대신 사용하지 않았다.

사용자가 제공한 https://effect.website/docs/v4/api/effect/Crypto 와 현재 설치본 effect/src/Crypto.ts, platform-node/src/NodeCrypto.ts 및 platform-node-shared/src/NodeCrypto.ts를 직접 대조했다. 현재 서비스는 randomBytes, 난수, UUID/ULID, SHA-1/256/384/512 digest다. NodeCrypto.layer는 이 서비스를 제공하고 digest는 Effect.try로 createHash.update(data).digest를 실행하여 PlatformError를 반환한다. sign/verify, key import/export/generation, timingSafeEqual, incremental hash state/update API는 없다. driver의 내부 node:crypto 전체 namespace가 서비스의 공개 기능을 확장하지 않는다.

이 파일의 실제 작업은 canonical JSON을 UTF-8로 인코딩한 원문에 Ed25519 sign(null)/verify(null)을 적용하는 것이다. SHA-256을 먼저 적용하는 치환은 서명 바이트와 보안 프로토콜을 바꾼다. PKCS#8 private PEM/SPKI public PEM은 그대로 유지한다. canonical UTF-8만 TextEncoder로, 서명 출력만 공식 Effect Base64.encode로 전환했다. 검증 입력의 기존 Buffer base64 decoder는 padding 생략/base64url/공백을 허용하지만 공식 Base64.decode는 길이·알파벳에 엄격하므로 입력 계약 변경 없이 치환할 수 없다. 서명·검증의 동기 호출 및 unknown key/invalid signature/잘못된 PEM의 기존 throw 계약도 유지했다. 이 작업을 Effect Crypto 서명 전환으로 표시하지 않는다. 동기 암호 연산에는 중단 가능한 callback/Promise나 AbortSignal이 없으며 새 취소 보장을 주장하지 않는다. 이 파일에는 상수시간 비교와 스트리밍 해시 작업이 없다.

Crypto 진단 5곳의 판정을 정정한다:

| 진단 파일                       | 실제 작업 및 공식 API와의 차이                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server/release-contract.ts      | Ed25519 PEM sign/verify는 미지원. 인코딩 부분만 전환 완료.                                                                                                                                                                                                                                                                                        |
| server/release-contract.test.ts | fresh Ed25519 PKCS#8/SPKI 키 생성과 독립 Node sign/verify 상호운용 oracle. Crypto에 키 생성 없음. 생성된 테스트 키는 실제 자격증명이 아니다.                                                                                                                                                                                                      |
| scripts/package.ts              | 이미 Crypto digest로 artifact SHA-256 검사. 남은 createHash는 정렬된 file name + NUL + file content 전체를 한 상태에 누적하는 runtime manifest hash. digest는 전체 Uint8Array 한 번만 받으므로 모든 staged native 자산을 동시에 메모리에 모으는 치환과 다르다. chunk별 digest를 합쳐도 같은 값이 아니다.                                          |
| src/files/text.ts               | 이미 공식 digest/UUID 사용. 남은 createHash는 같은 scoped FD의 64KiB positional read와 함께 페이지 offsets/UTF-8 검사를 만들며 원문 전체 SHA-256을 누적. 공식 digest는 증분 상태 없음. 현재 최대 파일 크기 2MiB이므로 전체 버퍼 설계도 가능하지만 메모리/동일 FD 읽기 계약을 따로 검토할 후보이며 API 자체가 불가능한 파일이라고 단정하지 않는다. |
| src/oauth/validation-harness.ts | randomUUID는 공식 randomUUIDv4로 전환 가능. timingSafeEqual은 같은 길이의 OAuth 문자열 바이트를 상수시간 비교하며 공식 Crypto에 대응 없음. 두 연산을 함께 미지원으로 묶었던 설명은 잘못이었다. 이번 release 범위에서는 수정하지 않았다.                                                                                                           |

다른 20개 진단은 FileSystem/Path/HTTP/ChildProcess 및 Workflow unknown/any로, 전체 메시지를 읽었지만 이번 범위에서 모두 미지원 또는 필수 경계라는 결론을 다시 내리지 않았다. 각 실제 호출과 드라이버 계약을 확인해야 하는 남은 작업이다.

관련 런타임 테스트는 1파일/8개 모두 통과했다 (/tmp/release-crypto-tests.log). 기존 release 선택/변조/unknown key/버전 gate와 새 Ed25519 독립 상호운용·한글/이모지 UTF-8·Base64 출력 일치·기존 입력 인코딩·corrupt signature·malformed PEM 검증이다. 타입만 확인하는 테스트는 추가하지 않았다. vp check는 826파일 포맷 및 734파일 lint/type-aware 통과 (/tmp/release-crypto-check.log), agent#bundle도 통과 (/tmp/release-crypto-bundle.log). 변경 후 별도 typecheck는 실제 타입 오류 0, 기존 경고 25개 때문에 exit 1 (/tmp/release-crypto-after-types.log); 억제와 import 우회는 추가하지 않았다. 직전 전체 회귀 249파일/1,395통과 이후 이번 좁은 인코딩 변경은 관련 테스트로 검증했으며 전체 회귀를 다시 실행했다고 주장하지 않는다. dev 재시작, 실제 DB 수정, 모델 호출, commit/push는 하지 않았다.

마지막 프로세스 확인에서 이전에 종료한 PID와 다른 supervisor 88937 및 backend89153/frontend89165가 5173/5180을 새로 점유하고 있었다. 이 작업에서는 dev 시작 명령을 실행하지 않았다. 새 실행의 활성 작업과 소유자가 확인되지 않아 임의 종료하지 않았으며, 현재 서버가 종료 상태라는 확인은 할 수 없다. 관련 검증 명령은 모두 완료했고 diff 검사 및 CodeGraph 두 소스 파일 동기화는 통과했다.

### Node builtin 경계 재대조 (2026-10-12)

위 표의 일부 판단을 설치본 소스로 다시 확인해 정정했다. 위치별 전체 표는
[EFX11–12 검증](efx11-12-verification.md#node-builtin-경계의-설치본-api-재대조-2026-10-12)에 있다.

- `launch-project.test.ts`, `tests/support/http.ts`, `dev-hmr-api-recovery.test.ts`: "공식 NodeHttpServer도 native
  factory를 인자로 받는다"는 판단은 틀렸다. `NodeHttpServer.layerTest`가 factory 없이 ephemeral 리스너를 Scope로
  제공하므로 전환했다.
- `src/oauth/validation-harness.ts`: `randomUUID`는 `effect` `Crypto.randomUUIDv4`로 전환했다. `timingSafeEqual`과
  운영 loopback factory는 그대로다.
- `tests/io-range.test.ts`: async stat이 "열린 순간을 놓친다"는 근거는 맞지 않다(테스트는 handle이 보일 때까지
  폴링한다). 대상 stat과 `/dev/fd` 목록은 FileSystem으로 바꿨고, 상속 descriptor 번호의 fstat만 대응 API가 없어 남는다.
- `src/runtime/host.ts`, `src/shell/run.ts`: 공식 spawner도 process group 종료(`detached`, `killSignal`,
  `forceKillAfter`)를 제공한다. 남는 이유는 `windowsVerbatimArguments` 부재, 신호 종료 이름의 값 부재, 동기 kill 부재,
  inherited pipe abandonment 부재다.
- `src/files/text.ts`: `open(..., { noFollow: true })`는 있으나 `File.Info`에 ctime·ns mtime이 없어 페이지 stamp
  정밀도를 유지할 수 없다.
