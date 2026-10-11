# 2026-10-11 Effect 타입·포맷 정리

초기 전체 검사의 오류 117개는 일반 TypeScript 불일치가 아니라 Effect의 `@stability unstable` API 사용 진단(TS377136)이었다. 사용자 후속 답변에 따라 공식 RPC·Workflow·SQL 구현을 유지하고 app/memory-agent의 `unstableApiUsage`만 off로 설정했다. API 안정성 표기는 버전 호환성 약속이며 런타임 안전성 판정이 아니다. 자체 RPC·Workflow 구현으로 교체하지 않았다.

공개 registry를 조회한 Effect latest는 4.0.2, platform-node/vitest latest는 4.0.3, tsgo latest는 0.51.1이었다. platform-node/vitest 4.0.3은 조회 시 존재하지 않는 effect 4.0.3을 peer로 요구했다. 따라서 실제 설치 가능한 effect/platform-node/vitest 4.0.2를 정확한 catalog 버전으로 정렬하고 lockfile을 갱신했다. tsgo는 이번 실행 API 업데이트와 구분해 기존 0.48.1을 유지했다. [공식 Effect 4.0.2 변경 기록](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.2)을 확인했다.

포맷 문제 3개(vite.config.ts, native-search-public-service JSON, owner-read-recovery.test.ts)를 포맷하고 vite.config.ts의 미사용 react import를 제거했다. 병행 작업이 비활성화한 plugin 설정은 유지했다.

Effect 4.0.2 업데이트 후 기존 카탈로그 소유자 취소 회귀가 실패했다. 공유 cache lookup은 다른 대기자가 있으면 최초 호출자의 취소 후에도 계속되었다. 테스트 기대값을 바꾸지 않고 Deferred·Ref·Semaphore와 짧은 uninterruptible admission/cleanup으로 기존 계약을 보존했다. 대기자 취소는 소유자에게 전파되지 않고 소유자 취소는 SDK AbortSignal과 대기자에게 전달된다. 실패·중단 후 즉시 재시도, profile 격리, 30초 성공 TTL을 유지한다. 새 TTL 테스트는 TestClock을 사용한다. 실제 구독 SDK·자격 증명은 사용하지 않았다.

검증:

- 전체 `vp check`: 포맷 809파일, lint/type-aware 720파일 오류·경고 0으로 통과.
- 카탈로그·계정 격리 회귀: 2파일·25테스트 통과.
- `vp run agent#bundle`: runtime/frontend/backend build 통과.
- 기본 `vp run agent#dev`: UI HTTP 200, backend ready, UI proxy를 통한 대상 세션 read-recovery GET 통과. runtimeInstanceId `921ab20b-70b6-404c-9bee-61c443d30a8a`, buildId `54cc2a26c304e66180763e67`.
- 실제 DB 읽기 검증: schema 49, 실행 중 run 0, 기존 두 recovery receipt ID 동일. 메시지·모델 호출·failed run 재생·receipt 재적용 없음.
- 전체 타입 명령: 실제 오류 0, 기존 경고 684개, 종료 코드 1. Effect tsgo의 기본 `ignoreEffectWarningsInTscExitCode=false`가 경고에도 실패를 반환한다. 경고를 계속 표시하면서 오류만 종료 코드에 반영하는 옵션은 사용자 답변을 기다리며 변경하지 않았다. 오류 진단·검사 설정은 유지했다.
- 첫 종합 회귀에서 카탈로그 취소 1개가 실패했고 수정 후 관련 회귀가 통과했다. dev 시작 빌드와 겹친 다음 병렬 종합 회귀에서 시간 제한 3개가 실패했다. 해당 workflow 16개 및 process recovery 3개는 각각 격리 재검증에서 통과했다. 빌드 완료 후 순차 종합 회귀 결과는 아래 기록한다.
- 미실행: GPU embedding.test.ts, Windows packaging(CI 범위), 유료 모델·실제 구독 SDK·run 재생. 커밋·푸시·배포 없음.

순차 종합 회귀: 243개 파일·1,355개 테스트 통과, 3개 건너뜀, 종료 코드 0. `vp test --exclude packages/memory-agent/tests/embedding.test.ts --maxWorkers=1 --run`을 빌드 완료 후 실행했다. 앞선 병렬 timeout을 완전히 제거했다고 주장하지 않으며 격리·순차 실행 결과와 구분한다.

관련 변경은 pnpm-workspace.yaml/pnpm-lock.yaml, app/memory-agent tsconfig, 위 포맷 3파일, subscription-provider.ts 및 해당 테스트, docs/decisions.md다. 일반 경고의 종료 정책에 관한 pending 질문을 제외하면 별도 승인을 기다리는 구현은 없다.

로그: `/tmp/context-agent-type-cleanup-{baseline,check-baseline,install,peers,provider-check,provider-tests,app-build-final,check-last,typecheck-final,tests-updated,tests-final,tests-serial-final,workflow-recheck,process-recovery-recheck,dev-final}.log`. 기존 TypeScript 7과 typescript-eslint 및 사용자 oxc-transform-react와 plugin-react의 peer 경고는 이번 Effect peer 변경과 별도이며 임의 다운그레이드하지 않았다.

후속 결정: 사용자는 unstable만 끄고 나머지 경고를 고치기로 답했다. 위 종료 정책 질문은 더 이상 pending이 아니며, `ignoreEffectWarningsInTscExitCode`는 켜지 않았다. 이후 공식 서비스·Migrator 전환과 최신 검증은 [후속 구현 기록](effect-warning-remediation-2026-10-11.md)에 있다. 이 문서의 테스트 수와 기본 dev build ID는 앞선 시점의 결과다.
