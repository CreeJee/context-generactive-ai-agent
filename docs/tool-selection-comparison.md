# 도구 선택 비교: 서버 내부 실행 경로

2026-10-08. 실험 상태는 중지다. 이번 변경에서는 실제 인증 확인, 서버 재시작, 모델 요청을 실행하지 않았다.

2026-10-27. TanStack을 지우면서 `tool-comparison.ts`와 이를 서버 runtime에서 실행하던 `agent.ts`의 `runToolComparison`을 지웠다. 이 경로는 TanStack run adapter만 감쌌고, 저장소 안에서는 호출하는 곳이 없었다. 가드가 받던 요청도 TanStack 형식이어서 바깥 평가 컨트롤러는 어차피 다시 써야 한다. 실험을 다시 하면 `packages/memory-agent/eval/pilot-guard.ts`의 `pilotGuarded`처럼 run의 model을 감싸서 요청을 확인한다.

## 구현

- `apps/agent/app/.server/agent.ts`의 `runToolComparison`은 기존 앱 singleton의 ManagedRuntime에서 실행한다. 새 Node 인증 프로세스를 만들지 않는다.
- `tool-comparison.ts`는 기존 ProviderRegistry의 provider 객체와 run adapter를 빌린다. 계정 DB 행, OAuth client, credential getter를 평가 코드로 전달하지 않는다. 인증 connect/cancel/disconnect와 모델 설정 변경을 거부하고 선택 모델을 고정한다.
- 인증 status는 기존 앱 서비스를 그대로 호출한다. 해당 서비스도 키체인을 읽을 수 있으므로 이 변경만으로 인증창이 없어졌다고 주장하지 않는다. 키체인 권한이나 인증 설정은 변경하지 않았다.
- 실제 채팅 코드는 고정 revision `f49d0eafd7625fbadddeea2f739db49a5cd4822d`의 임시 snapshot을 사용한다. 서버 인증 경계는 실행 중인 서버의 것이므로 평가 시 서버 build/revision도 함께 기록해야 한다.

## 임시 평가 컨트롤러

`/tmp/shell-selection-experiment/server-comparison-job.ts`의 `runServerComparisonEntry`는 import 시 실행하지 않는다. 이미 실행 중인 서버 내부에서 `runToolComparison` 함수를 executor로 주입하는 작업이다. 외부 HTTP endpoint나 임의 모듈을 로드하는 API는 추가하지 않았다. 이 파일을 별도 CLI에서 실행하여 앱 singleton을 다시 만들면 안 된다.

컨트롤러는 고정된 여섯 과제·세 반복·두 조건만 받는다. 같은 작업 폴더와 저장소 경로를 순차 재사용하며, 이전 runtime을 dispose한 뒤 테스트 DB를 제거한다. fixture 복원, 조건, 검증 명령은 서버 소유 설정으로 주입한다. `process.env`를 조건별로 바꾸지 않는다. 실제 기억과 OAuth profile은 복사하지 않으며, 임시 memory·secret·import·skill 설정만 사용한다.

shell과 CodeGraph 자식 프로세스에는 기존 임시 OS sandbox를 적용한다. 일반 파일 도구의 외부 경로도 임시 project 밖에서 거부한다. 두 조건 모두 CodeGraph와 전용 파일 도구, 고정 `run_check`를 제공한다. 첫 adapter 호출 전에 시스템 지침, 초기 메시지 내용, `run_shell`을 제외한 도구 순서·설명·schema·승인 속성을 비교한다. 과제/반복별 context hash를 유지하고 차이가 있으면 모델 adapter로 전달하지 않는다. 프롬프트를 임의로 정규화하거나 다시 쓰지 않는다.

장부는 `/tmp/shell-selection-experiment/app-request-ledger.json`을 이어 사용한다. 기존 모델 요청 2회, catalog 요청 2회와 입력 추정량 18,537을 초기화하지 않는다. 새 요청은 adapter/catalog 호출 전에 보수적으로 예약한다. 예약은 실제 네트워크 성공 횟수와 구분해야 한다. 총 240회 제한은 catalog도 포함하므로 모델 240회 한도보다 엄격하다. 회당 최대 10회, 입력 추정 총 150만, 실행 120초, 기존 시도 4회를 포함해 총 36회로 제한한다. 이미 등록한 시도는 자동 재실행하지 않는다. 빈 응답이나 실패에서 후속 과제를 자동 실행하지 않는다.

구형 `app-experiment.ts`와 `app-live-worker.ts`의 새 프로세스 인증 실행은 비활성화했다. 기존 stop 기록을 해제하지 않았다.

## 검증 및 남은 단계

- 변경한 서버 파일의 `vp check`와 독립 TypeScript 검사가 통과했다. `vp test packages/memory-agent/tests/provider-contracts.test.ts --run`은 8개 테스트가 통과했다. 전체 저장소 테스트는 이번 변경에서 다시 실행하지 않았다.
- `server-preflight.json`: OS sandbox로 네트워크·키체인을 차단한 mock owner에서 두 조건의 실제 채팅 SSE·저장·hydration, 비어 있는 초기 기억, OAuth 행 미복사, 동일 system/context hash, 도구 30/29개, mutation 거부, run lease 해제, 실패 Scope 종료와 owner 생존을 확인했다.
- 요청 제한은 기존 사용량을 가진 테스트 장부 복사본으로 검증했다. 11번째 회당 요청, 241번째 총 요청, 기존 4회 이후 33번째 추가 시도, context mismatch를 차단한다. 실제 장부는 바이트 단위로 보존한다.
- 새 작업 함수 자체의 mock 검증은 `server-job-preflight.json`에 별도로 기록한다. 두 조건의 완료, 재실행 거부, 모델 대기 중 Fiber interruption, controller lock 정리와 owner 생존이 통과했고 테스트 프로세스 종료 코드도 0이다. 이 mock에서는 상위 OS sandbox가 적용돼 있으므로 CodeGraph에 중첩 sandbox를 추가하지 않는다. 실제 서버 모드는 자식에 sandbox를 적용한다.
- 취소 검증 중 DB 종료 뒤 SDK 후처리가 접근하는 오류를 발견했다. 컨트롤러 finalizer가 DB를 열어 둔 채 앱 cancel을 실행하고, SSE·검증 작업 Promise의 종료를 기다린 뒤 runtime을 dispose하도록 수정했다. 종료를 확인하지 못하면 controller lock을 유지한다. 수정 후 취소 검증에서 DB 종료 오류가 재발하지 않았다. 실제 서버의 인증 UI와 장시간 timeout은 미검증이다.

실제 서버에 새 내부 모듈을 로드하고 안전하게 작업을 전달하는 단계는 아직 실행하지 않았다. 실행 중인 서버가 새 소스를 로드할 수 없다면 해당 서버를 재시작해야 한다. 병행 작업을 멈추거나 다른 인증 프로세스로 우회하지 않는다. 재시작이나 추가 인증이 필요한 경우 먼저 구체적인 대상·이유·최소 조치를 보고한다. 실제 앱에서 인증창 없이 실행되는지, 이전 빈 응답 문제가 해결됐는지, 실제 32회 비교 결과는 미검증이다.

새 장부의 상한은 앱 adapter/catalog 호출 예약 기준이다. 기존 장부의 4건은 실제 HTTP 요청 관측값이다. 실제 평가 전에 앱 내부 재시도·토큰 갱신 요청을 포함한 요청 관측 계약도 확인해야 하며, 예약 수를 실제 HTTP 성공·모델 추론 수로 보고하지 않는다.

## 실행 중인 서버 연결 확인

2026-10-08, `/tmp/shell-selection-experiment/server-connection-probe.json`에 로컬 확인 결과를 저장했다. 인증·채팅 endpoint는 호출하지 않았고 health GET만 사용했다.

- 백엔드: `http://127.0.0.1:5180`, PID `7540`, runtime instance `825143a4-4cc0-433c-8723-dd8b4419cc43`. health 200/ready이며 기존 `backend.lock` instance와 일치한다.
- 로드된 build ID: `6b28b5df4bcb265a9dd0486c`. 확인 시점 소스 fingerprint: `84a991ac43ebee4aa0f93db1`. loaded build와 소스가 다르다.
- 해당 PID는 `dist/context-agent.mjs --dev-backend` 프로세스이고 debugger는 활성화되지 않았다. frontend의 기본 포트 5173은 연결 거부였다.
- `scripts/dev.ts`는 stable backend의 HMR을 끄고 빌드된 실행 파일을 시작한다. `server/main.ts`와 `serve.ts`는 고정 React Router ServerBuild를 제공한다. 소스 또는 외부 작업 모듈을 런타임에 로드하는 지원 API는 확인되지 않았다.
- 현재 디스크의 번들도 새 비교 함수/컨트롤러를 포함하지 않는다. 새 함수는 서버 내부 export이며 이를 호출하는 평가 접수 API는 아직 없다. 단순 파일 수정 또는 현재 chat/ACP API만으로 새 격리 runtime 실행을 요청할 수 없다.

연결 단계의 차단 원인은 인증이 아니라 서버의 고정 코드 경계다. debugger 활성화·코드 주입·build-ID gate 우회 또는 별도 인증 프로세스로 우회하지 않았다. 새 내부 작업 접수 경로를 빌드에 포함하고 해당 stable backend만 재빌드/재시작해야 한다. 재시작은 현재 런타임과 진행 중인 채팅·명령을 종료할 수 있으므로 실시하지 않았다. frontend 전체나 다른 세션을 중지할 필요가 있는 것으로 판단하지 않는다. 재시작 후 인증창이 다시 필요한지는 인증 status를 조회하지 않았으므로 미확인이다.

이 확인 동안 서버 설정·DB·기억·보안 권한을 변경하지 않았고, 실제 모델 요청은 추가 0회다. 누적 모델 2회/catalog 2회와 최대 남은 시도 32회를 유지한다. 전체 비교는 여전히 미완료이며 유효한 실제 비교 표본은 0개다.
