# EFX11–12 이어쓰기 검증 (2026-10-10 UTC)

**EFX12 최종 판정 (2026-10-12): 차단 일부.** `vp check`는 통과한다. `vp run typecheck`는 일반
TypeScript 오류 0개, Effect 경고 25개 고유 위치(출력 26회)로 exit 1이다. 남은 25곳은 설치된 Effect
4.0.3 preview에 대체 API가 없는 native 경계이며, 진단 억제·severity 하향·exit-code 제외·개별
예외 없이 남긴다. 상세는 아래 [EFX12 gate 최종 정리](#efx12-gate-최종-정리-2026-10-12)를 따른다.

최신 후속 결과(2026-10-11 04:20 UTC): 사용자 승인으로 실제 대상 세션을 복구하고 기존
5173/5180 dev 서버를 재시작했다. schema 49는 이미 적용되어 있어 추가 upgrade는 없었다.
원본 13개 row의 격리 복원 검증과 불변 receipt/revoke 경로를 사용했으며 기존 실패 기록을
보존했다. 새 입력 admission은 ready, 새 run·모델 사용은 0이다. 최신 전체 회귀는 241개 파일 /
1344개 테스트 통과(3 skip, GPU 제외), 마지막 admission preview 후 관련 26개 테스트 통과다.
EFX12의 기존 타입 진단 117개와 별도 JSON 포맷 1개는 여전히 남는다. Windows packaging은 CI에서
검증하며 미출시 구 release 설치·downgrade는 이번 완료 조건이 아니다. 현재 DB의 원자적 migration,
동시 시작·rollback·readonly worker schema 검증과 실제 적용 근거는
[실제 적용 기록](background-result-run-failure-2026-10-11.md#실제-적용과-db-단일-기준-2026-10-11-0420-utc)을 따른다.

최종 현황: EFX11 기준 충족. 최종 종합 회귀 237개 파일 / 1312개 테스트 통과,
SIGBUS 없음. 새 브리지를 포함한 Mac 패키지의 compiler 없는 시작·core API·재시작·정상
종료와 DB 호환성 검증도 통과했다. EFX12는 기존 unstable 타입 진단 117개와 별도 JSON
포맷 1개 때문에 gate 전체 완료로 표시하지 않는다. GPU 파일은 미실행, Windows는 CI
대기다. 아래 초기 실패 이력과 최종 재검증을 구분한다.

2026-10-11 후속 검증: 읽기 실패 분류와 명시적 recovery receipt/API를 추가했으며,
최신 전체 회귀 240개 파일/1337개 테스트 통과(3 skip, GPU 파일 제외), DB schema 49까지
0.0.13 source opener 호환성과 업그레이드 전 백업의 재열기를 확인했다. 기존 unstable 진단
117개와 JSON 포맷 1개는 남아 EFX12 gate를 완료로 표시하지 않는다. 실제 사용자 DB 적용은
충분한 백업 공간과 복원 검증·재시작/receipt 승인이 필요하다. 자세한 변경과 검증·백업 제한은
[실패 조사와 복구 API](background-result-run-failure-2026-10-11.md)의 후속 구현 절을 따른다.

## 확인한 계획과 범위

앱의 실제 SQLite 세션 저장소를 읽기 전용으로 확인했다. 대상은 project
`72c2d6e0-23af-402d-be08-f74b28aee6e9`, session
`3bfb5fe9-4ef1-48be-be32-6f019e35b4a2`이다. 당시 Goal v13, plan v19에서
EFX01–10은 완료, EFX11은 진행 중이었다. EFX11은 opt-in, in-process Goal,
runtime compilation, JS fallback, 수동 transport의 정리이고, EFX12는 안정성,
0.0.13 릴리스 호환성, 패키지·컴파일러 없는 시작, unstable API 및 성능 증거다.
세션에는 메시지를 보내거나 실행을 요청하지 않았고 계획 상태도 수정하지 않았다.

병행 작업으로 존재하던 변경을 유지했다. 아래 기록은 기존 migration을 이어서
통합·수정한 결과이며 전체 dirty diff를 이번 작업의 단독 변경이라고 주장하지 않는다.

## 구현·보완

- 빌드에서 만들어진 native/worker artifact를 필수로 사용하는 실행 경계를 이어서
  통합했다. Goal/build generation과 파일 SHA를 분리하여 동일한 worker bytes를
  쓰는 서로 다른 Goal의 unique 충돌을 막았다. 기존 content-hash pin은 검증한다.
- 실행 중 `start_new_goal`의 자기 pending RPC만 요청 접수에서 제외하고, 최종 적용은
  모든 pending/uncertain receipt를 다시 검사한다.
- 완료 evidence를 proposal과 실제 완료 snapshot으로 구분했다. SDK 및 durable run의
  성공 후 owner가 버전, 성공한 노드, dispatch, operation receipt를 재검증한다.
- 승인 후 재개는 owner에 저장된 interrupt와 SDK가 검증한 approval Map에만 의존한다.
  이미 완료된 도구를 재실행하거나 이전 중단 run의 성공을 만들어내지 않는다.
- 확정된 읽기 실패는 tagged 실패 결과와 `ok: false`로 전달한다. write/provider의
  불확정 결과를 정상 완료로 바꾸지 않는다.
- 취소 시 실제 worker 종료를 기다리고, native SQLite reader에 명시적 close와 종료
  acknowledgement를 추가했다. 임시 DB를 지우기 전에 test runtime을 종료한다.
- fake embedder의 384차원 계약과 관련 fixture를 맞췄다. production admission의
  검색 크기·deadline 기준은 낮추지 않았다.
- dev CLI와 환경 설정, manifest 생성·정리, ready/build-ID 검사, 실행 문서를 보완했다.
  UI HMR 및 backend의 명시적 rebuild/restart 계약은 유지한다.

주요 파일: `apps/agent/scripts/dev.ts`, `dev-configuration.ts`,
`apps/agent/package.json`, `apps/agent/README.md`,
`packages/memory-agent/src/agent/{chat,full-loop-execution,full-loop-preflight,full-loop-worker,goal-worker-assets,owner-native-artifacts}.ts`,
`src/workflow/{workflow,completion-evidence,run-bindings}.ts`,
`src/memory/native-search/{client,worker}.ts`, `src/testing/fake-embedder.ts`,
`packages/turbovec/src/read_session.rs`, native types와 관련 회귀 테스트.
제품·설계 결정은 `docs/decisions.md`에 날짜와 함께 남겼다.

## 실행과 검증

저장소 루트에서:

```sh
vp install
vp run agent#dev --backend-port 15180 --web-port 15173 --storage /tmp/context-agent-dev
```

기본값은 backend 5180, UI 5173이다. `--manifest`를 지정할 수 있고 CLI가 환경 변수
`CONTEXT_AGENT_DEV_BACKEND_PORT`, `CONTEXT_AGENT_DEV_WEB_PORT`, `CONTEXT_AGENT_HOME`,
`CONTEXT_AGENT_DEV_MANIFEST`보다 우선한다. 별도 터미널 실행은 앱 README를 따른다.
backend 변경은 기존 프로세스에 자동 반영되지 않으며 사용 중인 요청을 확인한 뒤
명시적으로 재시작해야 한다.

| 검증                                                       | 결과                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| dev 구성·API 복구 집중 테스트                              | 3개 파일, 6개 통과                                                                                                                           |
| Rust library tests                                         | 9개 통과                                                                                                                                     |
| OS 복구·subagent·native artifact·완료 evidence 집중 재검증 | 4개 파일, 41개 통과                                                                                                                          |
| workflow·external approval·uncertain admission 집중 재검증 | 27개 통과; 같은 실행의 OS port tests 3개는 sandbox EPERM 후 위 집중 실행에서 통과                                                            |
| `vp check --no-fmt`                                        | 702개 파일, lint 및 일반 타입 검사 통과                                                                                                      |
| `vp check`                                                 | 기존 별도 작업의 `docs/native-search-public-service-2026-10-09.json` 포맷 1개로 실패; 이 파일은 변경하지 않음                                |
| `vp run typecheck`                                         | 설정된 검사 실패: Effect unstable API 오류 117개; 일반 TS 오류 0개                                                                           |
| production build, `vp run agent#package`                   | 통과; darwin-arm64 실행 파일 약 308.6 MB, ad-hoc 서명 검증 통과                                                                              |
| 격리 dev 실행                                              | 15180/15173, 임시 storage/manifest, backend 및 UI proxy health의 build ID와 ready 일치; UI HTTP 200                                          |
| 저장소 밖 패키지 시작                                      | `PATH=/usr/bin:/bin`, 임시 storage, 15181, UI HTTP 200; Node/Vite/compiler 없는 PATH에서 시작                                                |
| 패키지 RSS 참고값                                          | UI 첫 GET 뒤 435280 KiB; 단일 관측값으로 성능 기준 통과를 주장하지 않음                                                                      |
| 0.0.13 migration prefix                                    | 공개 릴리스 태그의 30개 migration이 현재 prefix와 일치; 임시 DB 30→48 업그레이드, 구 opener의 업그레이드 DB 거부, 보관한 30 backup 열기 확인 |
| 초기 병렬 종합 회귀                                        | embedding 제외, 7 실패 / 1303 통과 / 3 skipped, subagents SIGBUS 1개; 집중 실행의 통과만으로 전체 통과 처리하지 않음                         |

0.0.13 검증은 해당 태그의 source opener를 현재 설치된 Effect에서 실행한 것이다.
실제 배포 binary의 업그레이드·rollback 증거와 같다고 간주하지 않는다. 사용자는 후속
확인에서 호환성 범위를 DB로 명시했고 Windows 패키징은 CI에서 검증하기로 했다.
따라서 구버전 실행 파일 설치·rollback은 이 작업의 완료 차단 항목이 아니다.
사용자 DB를 복사하거나 시험 자료를 넣지 않았다. 기존 사용자 서버 5173/5180은
유지하고 제가 띄운 별도 dev/package 프로세스만 종료했다.

## Effect unstable API inventory

작업 초기 로그 `/tmp/context-agent-typecheck.log`와 후속
`/tmp/context-agent-final-types2.log`를 비교하면 117개의 파일별 개수도 일치한다.
이번 이어쓰기 구현이 새로 늘린 진단이 아니며 시작 시점의 dirty Effect migration
기준선에 포함된다. 하지만 공개 릴리스 0.0.13의 합격 기준이나 현재 설정된 타입 검사의
성공을 의미하지 않는다. severity는 변경하지 않았다.

기존 diagnostic severity나 ignore 설정은 변경하지 않았다. 117개는 모두
`TS377136 effect(unstableApiUsage)`이며 다음 경계에 분포한다. 각 파일은
`packages/memory-agent/` 기준이다.

| 파일                                            | 개수 |
| ----------------------------------------------- | ---: |
| `src/agent/effect-rpc-message-port.ts`          |   16 |
| `src/agent/full-loop-effect-rpc.ts`             |    8 |
| `src/agent/full-loop-execution.ts`              |    3 |
| `src/agent/full-loop-worker.ts`                 |    3 |
| `src/approvals/relayed.ts`                      |   10 |
| `src/workflow/goal-execution.ts`                |    9 |
| `src/workflow/owner-workflow-engine.ts`         |   38 |
| `tests/effect-rpc-message-port.test.ts`         |    8 |
| `tests/effect-workflow-engine-contract.test.ts` |    7 |
| `tests/goal-worker-assets.test.ts`              |    3 |
| `tests/owner-workflow-engine.test.ts`           |    5 |
| `tests/support/effect-database-sync.ts`         |    7 |

종합 순차 재검증(`vp test --exclude packages/memory-agent/tests/embedding.test.ts --maxWorkers=1`)
결과는 **235개 파일 통과 / 1310개 테스트 통과 / 3개 skipped / SIGBUS 1개**다.
단언 실패는 없어졌으나 subagents test worker가 다시 종료되어 전체 명령은 실패했다.
실행 시간은 317.84초다. 빌드·패키징을 동시에 하지 않았으므로 동시 빌드나
테스트 병렬도만을 원인으로 설명할 수 없다.

## 완료 판단의 한계

EFX11의 주요 제거 경로와 이어쓰기 통합을 구현했지만 EFX12를 완료로 표시하지 않는다.
병렬 및 순차 실행에서 발생한 macOS SQLite WAL/SHM SIGBUS는 crash report의 `walFindFrame`,
`FS pagein error: 22`로 확인했다. 집중 재검증은 통과했으나 수명 관리 수정만으로
해결됐다고 결론 내릴 수 없다. 아래 브리지 재개 검증은 이 초기 결과와 구분한다.
실제 사용자 workload의 장시간 안정성·성능 및 유료 provider 호출은 검증하지 않았다. GPU embedding test는
이 Mac에서 WebGPU adapter가 없어 ONNX abort가 발생하는 기존 제약으로 제외했다.

추가 조사에서 host의 `node:sqlite`와 Rust addon의 bundled `rusqlite`가 같은 process에서
동일한 DB를 열고 있음을 확인했다. SQLite는 이런 별도 library 복사본의 POSIX lock
추적이 서로 공유되지 않는 구성의 위험을 공식 문서
[Multiple copies of SQLite linked into the same application](https://sqlite.org/howtocorrupt.html#multiple_copies_of_sqlite_linked_into_the_same_application)에
설명한다. 사용한 SQLite Unix VFS source도 같은 PID의 별도 복사본이 SHM deadman lock을
인식하지 못하면 SHM을 truncate할 수 있는 경로를 포함한다. 이는 crash와 일치하는
원인 후보이며, 특정 crash의 원인을 완전히 입증한 것은 아니다. SQLite library를
하나로 통일하거나 DB reader를 별도 process에 두는 설계가 필요할 수 있다. 임시로
locking을 끄거나 immutable 읽기를 사용하면 일관성을 깨뜨리므로 적용하지 않았다.

재현·검증 로그는 `/tmp/context-agent-final-*.log`, release source probe는
`/tmp/context-agent-release-check/probe.ts`에 있다. 임시 로그는 영구 산출물이 아니므로
위 표와 제한사항을 repository 기록의 기준으로 삼는다.

## SIGBUS 통제 재현과 수정안 (재개 조사)

`/tmp/context-sqlite-lock-original-probe.ts`에서 Node writer가 WAL DB를 갱신하는 동안
다른 thread가 reader를 1200번 열고 검색하고 닫았다. 앱·provider·사용자 DB를 쓰지 않았다.

| reader 및 파일 구성                                 | 결과                                     |
| --------------------------------------------------- | ---------------------------------------- |
| bundled Rust reader + Node writer, 같은 DB          | Node 26.4에서 exit 138/SIGBUS, 약 0.45초 |
| 같은 Node SQLite library의 reader + writer, 같은 DB | 6925번 쓰기, integrity_check ok          |
| bundled Rust reader + Node writer, 다른 DB          | 9250번 쓰기, integrity_check ok          |
| 보존한 기존 addon + Vite+ Node 26.8.2, 같은 DB      | exit 138/SIGBUS, 약 0.62초               |

기존 addon SHA256은 `9b0906f89a1cc6861a007257decd75a13ff9cb167235a70ba7aba272a095af14`다.
소스의 별도 SQLite 복사본과 실제 crash stack, 같은 파일 여부와 driver를 바꾼 통제
재현이 일치한다. 수정 후 동일 재현의 통과까지 확인해야 해결로 판단한다.

프로세스를 분리하는 대신 Rust `rusqlite/loadable_extension`으로 Node가 제공한 SQLite
API table을 공유하는 수정안을 작성했다. `sqlite3_turbovec_init`은 임시 `:memory:`
connection에서만 로딩하며 SQL 함수를 등록하지 않는다. 초기화 전 reader는 실패하고,
API table과 addon은 process 동안 유지한다. 사용자 DB의 extension 권한을 켜지 않는다.
Rust 자체 테스트만 bundled SQLite를 쓸 수 있으며 production build에서는 금지한다.
addon 파일 게시는 temporary copy 후 rename으로 바꿔 기존 서버의 mmap inode를 보존한다.

재현 회귀 파일은 `tests/fixtures/sqlite-lock-process.ts`, 검증은
`tests/sqlite-lock-bridge.test.ts`다. 새 TypeScript 수정안은 lint 및 일반 타입 검사에
통과했고 unstable 진단은 기준선과 동일한 117개다. 최초 빌드 시 새 Cargo 빌드 의존성
다운로드와 lockfile 갱신 시도가 자동 승인 검토에서 거절되었다. 이후 사용자가 의존성을
정리했고, 아래 재개 검증은 `--offline --locked`와 임시 target directory만 사용했다.
추가 다운로드, lockfile 갱신 및 설치된 addon 교체는 실행하지 않았다. 기존 0.0.13 Mac asset은 약73 MB인 것으로
메타데이터만 확인했고 다운로드·실행·설치·다운그레이드는 하지 않았다.

실제 `libsqlite3-sys/loadable_extension` 빌드 의존성은 prettyplease/quote/syn이며,
buildtime_bindgen을 켜지 않으므로 별도 bindgen/LLVM 설치는 필요하지 않다. 수정안의
마지막 lint 실행은 705개 파일에서 통과했다. Rust 전체 SQL unit 검증은 향후
`cargo test --lib --no-default-features --features test-sqlite --manifest-path packages/turbovec/Cargo.toml`
로 실행한다. 기본 production 기능은 Node SQLite를 필수로 사용한다.

## 브리지 후보의 격리 검증 (2026-10-10 UTC)

원래 SIGBUS가 발생한 `subagents.test.ts`의
`cancelling the parent stops a waiting child, and a restart never reruns one`은 유지했다.
실제 앱과 같은 Layer 및 DB를 사용하여 실행 중 부모 취소, 승인 정리, runtime 재시작,
안전한 checkpoint에서의 새 recovery attempt와 notification 소비를 검증한다.
Rust 단위 테스트나 삭제해도 되는 임시 진단 테스트로 분류하지 않는다.

사용자가 정리한 의존성으로 Mac 대상의 오프라인 해석이 통과했다. 이어서 다음 격리
빌드가 성공했다. Cargo.lock을 변경하지 않았고 산출물은 `/tmp`에만 생성했다.

```sh
cargo build --offline --locked --release \
  --target-dir /tmp/context-agent-sqlite-bridge-target \
  --manifest-path packages/turbovec/Cargo.toml
```

테스트 프로세스의 Node resolve hook 및 임시 Vitest alias만으로
`/tmp/context-agent-sqlite-bridge-addon/memory-turbovec.node`를 연결했다.
저장소 addon과 실행 중 서버, 사용자 DB는 교체·재시작·변경하지 않았다.
검증 중 저장소 addon SHA256은
`77df01cb811d113a68318165ffce6601e0c58ed32ad150f323e56d9788e59563`으로,
이전 통제 재현에서 보존한 addon과 달랐다. 이전 바이너리로 되돌리지 않았다.

| 재개 검증                                                                 | 결과                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 격리 release 빌드                                                         | 통과, 26.39초                                                                    |
| 같은 WAL DB의 Node writer + 브리지 native reader                          | 읽기 300회 / 쓰기 9899회, integrity_check ok; 초기화 전 거부 및 반복 초기화 포함 |
| 원래 subagents + 실제 MemorySearch + native-vector recovery + bridge 재현 | 4개 파일 / 25개 테스트 통과                                                      |
| Rust SQL 및 control 단위 테스트 (`--offline --locked`, test-sqlite)       | 9개 통과; 임시 unit target 사용                                                  |
| `vp check --no-fmt`                                                       | 705개 파일 통과                                                                  |
| `vp run typecheck`                                                        | 실패, 기존 TS377136 117개; 일반 TypeScript 오류 0개                              |

종합 순차 실행은 237개 파일 / 1315개 테스트를 대상으로 **223개 파일 통과,
1259개 테스트 통과 / 53개 실패 / 3개 skipped / 27개 unhandled errors**로 종료했다
(551.39초). **SIGBUS는 발생하지 않았다.** 전체 명령은 실패이며 통과로 바꾸어 기록하지 않는다.
실패 51개와 unhandled errors는 sandbox의 localhost 제한(EPERM, transport_unavailable 및 후속 timeout)에서
발생했다. 나머지 두 실패는 격리 검증 연결과 직접 native fixture의 초기화 문제였다.

- 테스트 resolve hook이 임시 unpacked runtime의 stand-in도 가로챘다. 실제로 해석된
  checkout `turbovec/index.js` 경로만 바꾸도록 `/tmp` hook을 수정했다. runtime fixture의
  계약이나 production resolver는 변경하지 않았다.
- `src/memory/native-search/pin.test.ts`는 직접 addon을 사용하므로 production worker와
  같은 bridge 초기화를 추가하고 fixture 삭제 전에 reader를 닫도록 했다. pin, 만료,
  취소, one-shot 검증은 그대로 유지한다.
- 실패한 14개 파일을 모두 localhost 허용 환경에서 격리 재검증했다. OS 복구 3개,
  가짜 Kagi HTTP 6개, Vite·가짜 OAuth 5개, dev API 1개가 통과했다. 나머지 9개 실패
  파일 및 실제 검색·subagent·복구·bridge 4개 파일을 함께 실행하여 **13개 파일 /
  142개 테스트**가 통과했다. 합계 재검증 157개 통과이며 재실행에서도 SIGBUS가 없다.
- 수정 후 `vp check --no-fmt`는 705개 파일에서 통과했다. `vp check`는 이번 작업과
  무관한 `docs/native-search-public-service-2026-10-09.json`의 기존 포맷 1개로 실패했다.

로그는 `/tmp/context-agent-sqlite-bridge-{isolated-build,isolated-probe,all-tests,os-recovery,local-http,vite-oauth,dev-api,final-retests,final-lint}.log`다.
격리 연결은 `/tmp/context-agent-sqlite-bridge-hook.mjs`와
`/tmp/context-agent-sqlite-bridge-vitest.config.ts`이며 저장소의 실행 설정을 바꾸지 않는다.

격리 검증의 통과는 브리지 후보에 대한 증거이며 실제 실행 중 서버에 배포했다는 뜻이
아니다. Windows 패키징은 사용자가 지정한 CI 검증 대상이다. 구버전 실행 파일
설치·rollback은 요청 범위에서 제외한다. DB 호환성은 위의 릴리스 migration prefix와
임시 DB 업그레이드, 구 opener의 새 DB 거부 및 업그레이드 전 backup 열기를 기준으로
검증했다. 이어서 아래에서 브리지를 포함한 패키지의 compiler 없는 시작도 검증했다.

## 최종 종합 실행과 Mac 패키지 (2026-10-10 UTC)

수정한 pin fixture와 checkout 경로만 치환하는 격리 resolve hook을 사용하여 종합 명령을
localhost 허용 환경에서 다시 실행했다. 외부 다운로드, 실제 provider나 계정 호출 없이
**237개 파일 / 1312개 테스트 통과 / 3개 skipped**, 명령 exit 0, **357.36초**다.
SIGBUS나 unhandled errors는 없다. GPU embedding 파일은 이 Mac의 기존 WebGPU/ONNX
제약으로 미실행이며 실패 항목에 섞지 않는다. 앞선 sandbox 실행 실패 기록은 보존한다.

```sh
NODE_OPTIONS='--import=/tmp/context-agent-sqlite-bridge-hook.mjs' \
  vp test --config /tmp/context-agent-sqlite-bridge-vitest.config.ts \
  --exclude packages/memory-agent/tests/embedding.test.ts --maxWorkers=1
```

현재 source를 `/tmp/context-agent-bridge-package-repo`에 복사하고 이미 설치된 의존성을
참조하여 runtime artifacts와 React Router app을 새로 빌드했다. 복사본의 package collector만
임시 turbovec 경로를 선택하도록 연결하여 격리 addon을 포함시켰다. 원래 저장소의
build/dist/addon을 덮어쓰지 않았다. Mac SEA 실행 파일은 **306.9 MB**, ad-hoc 서명과
서명 검증이 통과했다. 실제 설치, 배포 또는 notarization은 하지 않았다.

실행 파일을 다시 저장소 밖 `/tmp/context-agent-bridge-sea-wKZvVT`로 복사하고 임시
storage/임의 port에서 실행했다. 서버 PATH는 `/usr/bin:/bin`이며 Node/Vite/compiler가
없다. 임시 config는 CPU와 imports off를 선택하여 GPU model 다운로드와 사용자 기록
import를 피했다. credential 환경 변수를 전달하거나 keychain/auth endpoint를 호출하지 않았다.

| Mac 패키지 검증                                                   | 결과                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 첫 시작 / UI / client asset                                       | 통과; 첫 HTTP 200까지 5799 ms                                          |
| project/session 생성 및 session/workflow 상태 읽기                | 통과; 실제 packaged app의 Node writer와 native reader 초기화           |
| runtime에 unpack한 bridge addon과 native.mjs/Goal worker SHA 검증 | 통과; 임시 빌드 bytes와 일치                                           |
| 정상 종료 및 같은 storage 재시작                                  | 두 번 모두 SIGTERM exit 0; 재시작 854 ms, project/session 보존         |
| 종료 뒤 DB 검사                                                   | schema 48, integrity_check ok, nodes 0개 (import/model 실행 없음)      |
| 첫 core API 뒤 RSS                                                | 366512 KiB; 단일 관측값이며 기존 값과 성능 우열을 판정하지 않음        |
| 실제 unpacked native worker를 연결한 MemorySearch/복구            | 2개 파일 / 15개 통과; host는 fake embedder를 쓰는 Node 테스트 runtime  |
| unpacked prebuilt artifact를 연결한 Goal 등록/worker 실패         | 2개 파일 / 3개 통과; fake provider, 실제 packaged artifact/worker 사용 |

Typecheck 초기 로그와 최종 로그의 `TS377136`을 파일 및 진단 API 문자열로 비교했다.
**117개 모두 같은 파일별 개수와 같은 진단 symbol multiset**이며 일반 TS 오류는 0개다.
severity는 바꾸지 않았다. 설정된 typecheck는 여전히 **실패**다.
전체 `vp check`의 포맷 실패도 초기·최종 로그에서 같은 별도 JSON 1개다.
그 파일은 수정하지 않았으며 현재 SHA256은
`67d199d7d356a605e07483873cefe9c3dfe354faefdd708143d06cf7e44a501a`이다.

사용자가 정리한 Cargo.lock SHA256
`4dab466d9e99b8f52c4d02565a4a18d1921915620c60f3bc4044d01f811276e8`과 저장소 addon
SHA256 `77df01cb811d113a68318165ffce6601e0c58ed32ad150f323e56d9788e59563`은 재개 검증
전후에 같다. 사용자 서버를 중단하거나 재시작하지 않았고 제가 시작한 패키지 서버는 종료했다.

## Plan v19 완료 기준별 판정

앱 plan/evidence 자체를 변경하지 않았다. 다음은 이 Codex 작업의 검증 판정이다.

| 단계·기준                                                                 | 판정             | 근거 또는 제한                                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EFX11-1 기능당 단일 production 경로, legacy 선택 flag 제거                | 통과             | Goal Worker/RPC, prebuilt native artifact, native search 경로; source audit에서 과거 두 환경 flag와 nativeSearch 설정 없음                                            |
| EFX11-2 대체 전용 타입/설정/fixture/dead code 정리, public API 보존       | 통과             | 제거 diff 및 API exports/DB 읽기 계약 유지; 실제 취소·복구 계약 테스트는 보존                                                                                         |
| EFX11-3 missing/corrupt artifact 및 worker/native failure에 fallback 없음 | 통과             | 종합 회귀와 실제 unpacked Goal failure/search 회귀                                                                                                                    |
| EFX11-4 과거 binding/evidence 위조·backfill 없음                          | 통과             | 공개 릴리스 schema migration, historical revision 및 completion evidence 회귀                                                                                         |
| EFX12-1 0.0.13 DB forward-open·migration 실패·old-open/복구 범위          | 통과 (DB 범위)   | 공개 태그 migration prefix 30과 동일, 30→48·evidence 보존; 첫 additive migration 쓰기 실패 후 schema/rows/version 30 유지 및 구 opener 재열기; 백업 복구 확인         |
| EFX12-2 check/typecheck/tests/package gate                                | 차단 일부        | 2026-10-12 재판정: `vp check` 통과(JSON 포맷 해소, unstable 진단은 off). typecheck는 일반 오류 0, 대체 API 없는 native 경계 경고 25곳으로 exit 1. 아래 최종 정리 참조 |
| EFX12-3 compiler/Vite 없는 prebuilt production 시작 및 workflow runner    | 통과             | SEA startup/core API/정상 종료, prebuilt hash 확인; packaged worker/native artifact의 fake-provider Goal 실행 경계 회귀                                               |
| EFX12-4 unstable API adapter/service 경계·upgrade inventory               | 통과 (inventory) | 위 12개 경계 파일·117개 동일 진단 기록; 정책상 typecheck 성공과 구분                                                                                                  |
| EFX12-5 startup/RSS·saturation·crash/recovery 실측과 위험 보고            | 통과 (측정 범위) | startup/RSS 단일 값, 종합 admission/saturation/crash/recovery 회귀, 같은 DB control/패키지 재시작; 장기 사용자 workload 성능은 미실행                                 |

EFX11의 확인된 기준은 충족했다. EFX12는 실패한 check/typecheck와 외부 CI 항목을
남긴 상태이며 모든 gate가 통과했다고 선언하지 않는다.

## DB rollback 범위와 Windows CI 인계

최종 DB probe는 0.0.13 source opener로 생성한 실제 임시 파일의 복사본을 사용했다.
첫 additive migration에 query_only 쓰기 실패를 유도했을 때 schema와 사용자 row,
user_version 30이 그대로였고 구 opener가 다시 열었다. 정상 업그레이드 파일은 48이고
구 opener가 거부했다. 복원한 업그레이드 전 backup은 구 opener가 열었다.
이는 구 실행 파일 설치 검증이 아니라 요청한 DB 호환성 검증이다.
각 migration은 개별 transaction이므로 뒤 단계에서 실패하면 앞 단계의 commit까지
되돌린다고 약속하지 않는다. **업그레이드된 DB를 구버전으로 직접 열거나 user_version만
낮추지 않는다. rollback에는 업그레이드 전 일관된 DB backup 복구가 필요하다.**

Windows는 로컬 미실행/CI 대기다. 기존 `.github/workflows/release.yml`의 win32-x64 job에서
다음 순서가 필요하다. 이 작업에서는 CI를 dispatch하거나 배포하지 않았다.

1. 고정 Node/Vite+·lock 의존성 및 Rust/MSVC를 준비하고 default node-sqlite addon을 빌드한다.
   bundled test-sqlite를 production feature와 섞지 않는다. loader export와 linker 호환성은 CI에서 확인한다.
2. Rust 단위 검증은 `cargo test --locked --lib --no-default-features --features test-sqlite`로,
   실제 API-table 공유는 Node bridge regression과 실제 MemorySearch/취소·복구 회귀로 확인한다.
3. `vp check`, project typecheck, 관련/종합 테스트를 실행하고 위 기준선 실패를 별도 보고한다.
4. 기존 `vp run agent#package`, `vp run agent#smoke-package`로 Windows 실행 파일을 만든 뒤
   저장소 밖 임시 storage에서 UI/core API/prebuilt artifact/bridge/reopen을 확인한다.
   Windows taskkill 종료는 Mac SIGTERM exit 0와 구분한다. ZIP/SHA artifact 생성까지만 검증하고
   release 업로드는 별도 배포 요청 범위다.

최종 로그: `/tmp/context-agent-sqlite-bridge-comprehensive-final.log`,
`/tmp/context-agent-bridge-package-{artifacts,app-build,build,smoke}.log`,
`/tmp/context-agent-bridge-packaged-{search,goal}.log`,
`/tmp/context-agent-bridge-db-compat-final.log`.
임시 DB probe는 `/tmp/context-agent-release-check/probe-final.ts`이며 사용자 DB 복사본이 아니다.

검증 종료 뒤 `01a126a7-7f18-76b9-b5de-15c1f093301c`의 파일 I/O Effect 개선 병행 작업을
통지받았다. 그 작업 파일을 수정·포맷·스테이징하지 않았다. 위 종합 결과는 실행한
시점의 source에 대한 것이며 이후 병행 I/O 변경의 검증까지 포함하지 않는다.

## EFX12 gate 최종 정리 (2026-10-12)

기준은 로컬 main `a4c8740`(테스트 슬라이스 전환과 `tests/support/runtime.ts` 삭제 포함)이다. 사용자 DB,
실서버, 유료 모델, OAuth는 사용하지 않았다. 앞 절의 unstable 117개는 2026-10-11 결정으로
`unstableApiUsage`가 off라 더 이상 출력되지 않고, `docs/native-search-public-service-2026-10-09.json`
포맷 실패도 이미 해소되어 있었다.

### 시작 기준선

| 명령               | 결과                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vp check`         | exit 1: 822파일 포맷 통과, 오류 12개·경고 1개 (server tests의 TS2307/TS2322/TS18046, `backend-restart.test.ts`의 no-base-to-string)                                                        |
| `vp run typecheck` | exit 1: 삭제된 `tests/support/runtime.ts` 참조 TS2307/TS2322/TS377004/TS18046, asyncFunction TS377081 2곳, 테스트 헬퍼 TS377101/TS377049/TS377130/TS377030/TS377080, 아래 native 경계 25곳 |

### 수정한 진단

- `apps/agent/server/tests` 세 파일: Promise `testRuntime`을 `TestEnv`/`testAgent`로 이전했다. 빈 테이블 단언을
  유지하도록 테스트마다 별도 agent 블록을 둔다.
- `read-only-bar.tsx`의 async 콜백은 기존 `runUiEffect`/`uiPromise` 패턴으로, `backend-restart.test.ts`의 async
  then 콜백과 `String(input)`은 Promise 체인과 `new Request(input).url`로 바꿨다. 동기 throw 처리 동작은 같다.
- memory-agent 테스트 헬퍼: 다인자 순수 함수는 `Function.dual`, Effect 반환 함수는 `Effect.fnUntraced`, 서비스 key는
  파일 기준 결정적 이름, 실패해야 하는 SDK 호출은 `flip` 뒤 `orDie`, 수동 `new Promise`는 `Deferred`로 바꿨다.

### native 경계로 남은 25곳

억제·severity 하향·exit-code 제외·개별 예외는 추가하지 않았다(코디네이터 결정, `docs/decisions.md` 2026-10-12).
각 위치의 필요 기능과 대체 API 부재 근거는 [Effect 경고 전환 기록](effect-warning-remediation-2026-10-11.md)의
위치 표·재대조 표와 같으며, Effect·플랫폼 드라이버 업그레이드 때 재검토 대상이다.

| 위치                                                                                                                                 | 필요한 native 기능                                                       | Effect 4.0.3 preview의 부재                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `apps/agent/scripts/package.ts:8,10`                                                                                                 | 증분 SHA-256 manifest, symlink 제외 lstat                                | Crypto.digest는 단발, FileSystem.stat은 링크를 따름               |
| `apps/agent/server/release-contract.ts:5`, `release-contract.test.ts:2`                                                              | Ed25519 PEM sign/verify, 키 생성                                         | Crypto에 sign/verify/key API 없음                                 |
| `apps/agent/server/serve.ts:10`                                                                                                      | React Router RequestListener http bridge                                 | 해당 bridge 없음                                                  |
| `apps/agent/server/launch-project.test.ts:7`, `server/tests/dev-hmr-api-recovery.test.ts:13`, `memory-agent/tests/support/http.ts:2` | NodeHttpServer에 넘기는 loopback `createServer` factory                  | 공식 NodeHttpServer가 native factory를 요구, 검사기는 모듈명만 봄 |
| `memory-agent/src/agent/goal-worker-assets.ts:6`, `owner-native-files.ts:3`                                                          | Worker 생성 직전·SQLite atomic 안의 동기 파일 fence                      | 동기 FileSystem 드라이버 없음                                     |
| `memory-agent/src/agent/native-artifact-loader.ts:10`                                                                                | O_NOFOLLOW로 연 같은 FD의 fstat/read (동기)                              | 동기 nofollow open·같은 FD 정밀 stat 없음                         |
| `memory-agent/src/files/text.ts:4,15,17`                                                                                             | 증분 SHA-256, 같은 FD의 nanosecond stat, Windows 분기                    | 증분 digest·ns stat 없음                                          |
| `memory-agent/src/files/paths.ts:9`, `skills/skills.ts:13`                                                                           | lstat의 링크 자체 식별, device/inode 비교                                | lstat 없음                                                        |
| `memory-agent/src/files/listing.ts:9,11`                                                                                             | bounded Dirent 순회, `posix.matchesGlob`                                 | Directory stream·glob capability 없음                             |
| `memory-agent/src/oauth/validation-harness.ts:6,11`                                                                                  | loopback http factory, `timingSafeEqual`                                 | 상수시간 비교 없음                                                |
| `memory-agent/src/runtime/host.ts:3` (standalone 검사에서 중복 출력), `shell/run.ts:5`                                               | 동기 process-tree 강제 종료, signal/leader 종료 계약                     | ChildProcess가 signalCode·process group 종료를 노출하지 않음      |
| `memory-agent/src/workflow/owner-workflow-engine.ts:220,392`                                                                         | 공식 `Encoded.register`/`Activity.Any.executeEncoded`의 unknown/any 채널 | 공식 encoded 인터페이스 자체가 타입 소거됨                        |
| `memory-agent/tests/io-range.test.ts:2`                                                                                              | await 없이 열린 FD의 순간 관찰                                           | 비동기 stat은 열린 순간을 놓침                                    |

### EFX11 잔여 확인

`CONTEXT_AGENT_GOAL_WORKER`, `CONTEXT_AGENT_NATIVE_ARTIFACT`, `nativeSearch` 분기는 docs 밖 소스에 0건이다.
memory-agent `src`와 앱 server/app에서 런타임 compiler(esbuild/rolldown/vite/typescript/tsdown) import와
인프로세스 Goal 실행 경로도 없다. 이 worktree에서 addon과 `dist/runtime`이 없을 때 테스트는 JS fallback 없이
`NativeOwnerFailed(native-incompatible)`와 `artifact-manifest.json` `NotFound`로 실패했고, 빌드 뒤 통과했다.
남은 "legacy" 표기는 0.0.13 읽기 계약의 데이터 migration(chat thread, OAuth legacy slot)이다.

### 최종 명령 결과

| 명령                                                                    | 결과                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `vp check`                                                              | **exit 0**: 822파일 포맷, 730파일 lint/type-aware 오류·경고 0                                                               |
| `vp run typecheck`                                                      | **exit 1**: 일반 TS 오류 0, Effect 경고 25곳(출력 26회)                                                                     |
| `vp run agent#typecheck` / `memory-agent#typecheck` / `utils#typecheck` | exit 1 (경고 6) / exit 1 (경고 18) / exit 0                                                                                 |
| `tsc -p apps/agent/server/tests/tsconfig.json --noEmit`                 | exit 1: 경고 1 (`dev-hmr-api-recovery.test.ts` loopback factory)                                                            |
| 수정 영역 테스트                                                        | server tests 3파일·5개, backend-restart 11개, memory-agent 수정 헬퍼 사용 38파일 중 37 통과·`external-agents` 1개 간헐 실패 |
| 전체 `vp test --run --maxWorkers=2`                                     | **exit 1**: 239파일 중 236 통과, 1,422 통과·3 실패·10 skip, 390.28초                                                        |

전체 실행 실패는 `chat/history.test.ts`(native search owner `startup-timeout`),
`agent-chat-owner-process-recovery.test.ts`의 실제 OS SIGKILL/SIGTERM 2개, `native-search/control.test.ts`다.
세 파일을 `--maxWorkers=1`로 다시 실행하면 첫 번째는 1개 실패, 두 번째는 3파일·12개 모두 통과했다.
테스트 변경 전 커밋 `85652d3`의 별도 worktree에서도 두 번 중 한 번 OS recovery 2개가 실패했다.
`external-agents.test.ts`도 같은 기준선에서 4회 중 2회 실패했다. 이 간헐 실패는 이번 변경 이전부터 있는
부하 민감성이며 timeout이나 assertion을 완화하지 않았다. 전체 명령은 통과로 표시하지 않는다.
Windows 패키징과 GPU 검증은 앞 절과 같이 CI·미실행 범위다.
