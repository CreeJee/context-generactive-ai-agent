# shell

## Overview

`packages/memory-agent/src/shell`은 에이전트가 호스트에서 셸 명령을 실행하는 계층이다. `run.ts`는 명령 하나를 자식 프로세스(POSIX에서는 별도 프로세스 그룹)로 띄운다. 이 파일은 타임아웃·취소·강제 종료, 출력 head/tail 캡처, 비밀 환경 변수 제거를 맡는다. `sandbox*.ts`는 sh 스킬 스크립트를 `@anthropic-ai/sandbox-runtime`의 OS 샌드박스 안에서 실행한다. 실행 한 번마다 worker thread를 하나 띄우고, Effect RPC(`Prepare`/`Finish`)로 감싼 명령 줄과 위반 보고를 주고받는다.

## Interface

- `runCommand` — `CommandOptions`(`command`, `cwd`, `timeoutSeconds`, `env`)로 호스트에서 명령 하나를 실행하고 `CommandResult`를 돌려주는 Effect. `ChildProcessSpawner`가 필요하고, 실패하면 `CommandStartFailed`를 낸다
- `CommandResult` — 실행 결과 타입: `status`(`succeeded`|`failed`|`timed_out`|`cancelled`), `exitCode`, `signal`, `durationMs`, `stdout`/`stderr`, `*Truncated` 플래그
- `CommandOptions` — `runCommand` 입력 타입
- `CommandStartFailed` — 프로세스 spawn 실패를 나타내는 `Schema.TaggedError`(`reason: SpawnFailed`, `cause: Defect`)
- `stopAllCommands(force?)` — 이 프로세스가 소유한 모든 셸 명령을 취소한다. `force`면 `SIGKILL`로 즉시 죽인다. 서버 종료 때 쓴다
- `commandEnvironment(source)` — 비밀로 보이는 환경 변수를 빼고 `TERM=dumb`, `NO_COLOR`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`을 넣은 env를 만든다
- `hostShell(source)` — 명령이 실행될 셸 파일 경로(로그인 셸, `/bin/sh` 또는 `cmd.exe`)를 돌려주는 Effect
- `defaultTimeoutSeconds` / `maxTimeoutSeconds` — 명령 타임아웃 기본값 120초, 최대값 1800초
- `runSandboxed` — dual 함수 `(setup, run)`. worker를 띄워 `Prepare`로 감싼 명령을 받고, `run`으로 실행한 뒤 `Finish`로 stderr에 위반 내역을 덧붙인다. 오류는 `E | SandboxUnavailable`이고 `FileSystem`이 필요하다
- `sandboxPolicy({projectRoot, storageRoot, network})` — 홈/임시 폴더를 읽어 `network`, `allowLocalBinding`, `allowWrite`, `denyRead`, `denyWrite` 정책을 만드는 Effect
- `SandboxSetup` — worker에 `workerData.sandbox`로 보내는 `Schema.Struct`(`command`, `commandId`, `network`, `allowLocalBinding`, `allowWrite`, `denyRead`, `denyWrite`)
- `SandboxUnavailable` — 샌드박스를 쓸 수 없음을 나타내는 TaggedError. `reason`은 `unsupported_platform`|`missing_dependencies`|`setup_failed`이고 `detail`이 붙는다. `sandbox.ts`에서도 re-export한다
- `SandboxUnavailableReason` — 위 `reason`의 `Schema.Literals`
- `SandboxReportFailed` — 위반 로그 annotate 실패(`reason: annotate_failed`)를 나타내는 TaggedError
- `Prepare` / `Finish` / `SandboxRpcs` — 샌드박스 worker RPC 그룹. `Prepare`는 감싼 명령 줄을 돌려주고, `Finish`는 `{stderr}`를 받아 주석이 달린 stderr를 돌려준다
- `sandbox-worker.ts` — worker thread 진입점. `runtimeWorker("sandbox-worker")`로 로드되고 `runNativeEffect(Layer.launch(server))`로 RpcServer를 띄운다. export는 없다
- 하위 디렉터리 없음

## Invariants

- 샌드박스 실행 하나에 worker 하나를 쓴다. sandbox-runtime은 모듈 인스턴스마다 정책·프록시·위반 저장소를 하나씩 두므로, 동시 실행끼리 allowlist를 공유하면 안 된다. 클라이언트 protocol은 size 1, concurrency 1이고, 서버도 concurrency 1이다
- RPC 순서는 `Prepare` 다음 `Finish`다. `Finish`는 명령이 끝난 뒤 한 번만 보낸다. host가 감싼 명령을 직접 spawn하고, 그동안 worker는 살아서 네트워크 프록시를 서비스한다
- worker setup이 실패해도 worker는 종료하지 않는다. `Effect.exit`로 실패를 보관하고 `Prepare`가 그 실패를 돌려준다. `Finish`는 prepared 실패를 `SandboxReportFailed`로 바꾼다
- worker의 setup 실패 `detail`은 고정 문자열(`invalid_setup`|`runtime_unavailable`|`initialize_failed`|`wrap_failed`)만 쓴다. runtime 메시지에는 경로가 담길 수 있고, 그 메시지가 셸 도구 결과까지 가기 때문이다
- worker마다 별도 `TMPDIR`(`makeTempDirectoryScoped` 스크래치 폴더)을 준다. runtime이 프록시 소켓 이름을 pid로 짓기 때문이다. worker와 스크래치 폴더는 scope와 함께 끝난다(성공·실패·인터럽트 모두)
- `SandboxManager.initialize`는 `acquireRelease`로 감싸고, release에서 `SandboxManager.reset`을 호출한다. network는 `strictAllowlist: true`이고 ask callback이 없어 목록 밖 호스트는 거부된다
- `Finish` 응답은 최대 5초 기다린다. 타임아웃이나 오류가 나면 명령의 원래 stderr를 그대로 쓴다
- 샌드박스 정책: 쓰기는 `projectRoot`, `/tmp`, 임시 폴더, 홈의 캐시 경로만 허용한다. `<projectRoot>/.agents/skills`는 쓰기 금지다(`save_code_skill`로만 바꾼다). 홈의 자격 증명 저장소와 `storageRoot`는 읽기 금지다. loopback 바인딩은 `network`에 `localhost`가 있을 때만 허용한다
- `activeCommands` 레지스트리는 `globalThis.__contextGeneractiveAgentShellProcessState`에 하나만 둔다. 번들 중복이나 dev reload로 모듈이 여러 번 평가돼도 exit hook은 하나만 설치된다
- process `'exit'` 훅이 `activeCommands`를 동기로 읽으므로, 레지스트리는 네이티브 `MutableHashSet`이어야 한다. force 경로의 kill은 동기로 시작한다
- 명령 환경은 `extendEnv: false`인 `commandEnvironment`를 쓴다. 이름이 `TOKEN`/`SECRET`/`PASSWORD`/`API_KEY`/`AUTH` 등에 맞는 변수는 명령에 넘기지 않는다(R14)
- POSIX에서는 `detached: true`로 자체 프로세스 그룹을 만든다. 중지는 `SIGTERM`으로 시작하고 3000ms 뒤 `SIGKILL`을 보낸다. 그 뒤 pipe와 `exitStatus`를 각각 최대 100ms만 기다린다(detached 자손이 pipe를 붙잡고 있을 수 있음)
- 출력 캡처는 stream마다 앞 2KiB와 뒤 14KiB만 남기고, 생략한 바이트 수를 표시한다. 상한은 모델 컨텍스트 크기에 맞춘 값이다
- `runCommand`는 호스트 실행이라 경로 규칙이 샌드박스하지 않는다. 샌드박스는 `runSandboxed`를 거쳐야 한다

## Side Effects

- 자식 프로세스 spawn: 셸(로그인 셸, `/bin/sh`, `cmd.exe`)로 명령을 실행한다. stdin은 ignore이고 stdout/stderr pipe를 drain한다
- 프로세스 시그널: `SIGTERM`/`SIGKILL`을 프로세스 그룹에 보낸다(타임아웃, 취소, `stopAllCommands`, process exit)
- 전역 상태: `globalThis.__contextGeneractiveAgentShellProcessState` 레지스트리를 변경하고 `process.once('exit')` 리스너를 설치한다
- 타이머: 명령 타임아웃 sleep, kill grace 3s, close grace 100ms, `Finish` 타임아웃 5s
- worker_threads: 실행마다 `sandbox-worker` Worker를 생성·종료한다. env는 `process.env`에 `TMPDIR`을 덮어쓴 값이다
- 파일 시스템: `context-agent-sandbox-` 접두사 임시 디렉터리를 만들고 scope 종료 때 삭제한다
- 환경 변수 읽기: `process.env`, `process.platform`, 홈/임시 디렉터리
- OS 샌드박스: worker 안에서 `@anthropic-ai/sandbox-runtime`의 `SandboxManager.initialize`/`reset`/`wrapWithSandbox`를 호출한다(네트워크 필터 프록시 서비스, 파일 시스템 접근 제한). 위반 로그는 `annotateStderrWithSandboxFailures`로 읽는다
- 런타임 패키지 로드: `requireRuntime("@anthropic-ai/sandbox-runtime")`
- 로깅: `sandbox_report_unavailable`(debug), `sandbox_reset_failed`

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
