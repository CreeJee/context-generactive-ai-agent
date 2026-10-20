# 결정 기록

확정한 제품·설계 결정을 주제별로 모은다. 주제 안에서는 오래된 결정부터 날짜순으로 적고, 뒤의 결정이 앞의 결정을 대체할 수 있다. 측정 수치와 실험 근거는 결정이 기댄 증거로 함께 남긴다.

새 결정은 맞는 주제의 끝에 `### 제목 (YYYY-MM-DD)` 형식으로 추가한다.

## 목차

1. [범위와 개발 원칙](#범위와-개발-원칙)
2. [Effect 런타임과 진단](#effect-런타임과-진단)
3. [인증·모델·공급자](#인증모델공급자)
4. [대화·실행·기록](#대화실행기록)
5. [Goal·Workflow·Durable 실행](#goalworkflowdurable-실행)
6. [기억·검색·평가](#기억검색평가)
7. [도구·권한·외부 연동](#도구권한외부-연동)
8. [UI·클라이언트](#ui클라이언트)
9. [배포·개발 환경·성능](#배포개발-환경성능)
10. [테스트](#테스트)

## 범위와 개발 원칙

### 범위와 구조 (2026-09-15)

- PRD 전체(R01-R19)를 단계별로 옮기되, 연구용 계약(예산 원장, r00x 평가 등)은 가져오지 않고 직관적인 구조로 다시 만든다.
- `apps/agent`는 React Router(framework mode) 라우트와 UI, `packages/memory-agent`는 서버 로직, `packages/turbovec`는 벡터 인덱스 네이티브 모듈.
- 스택: Effect.ts(서비스, Layer, 타입 있는 오류) + Effect Schema. TanStack AI 도구 스키마는 `toToolSchema`로 Standard JSON Schema를 붙여 넘긴다.
- workspace는 등록한 프로젝트다. 세션, 기억, 권한 설정은 프로젝트에 속한다. 프로젝트는 두 방법으로 등록한다:
  - 실행 파일을 그 폴더에서 실행하거나 폴더를 넘긴다(`context-agent [폴더]`). 이미 등록돼 있으면 그 프로젝트를 고르고, 브라우저를 그 프로젝트가 선택된 화면(`?project=<id>`)으로 연다. 사용자가 그 폴더에서 직접 실행한 것을 브라우저에서 추가한 것과 같은 명시적 의사로 본다.
  - 실행 위치가 실제 작업 폴더가 아니면(Finder 더블클릭의 `/`, 홈 폴더, 저장 루트 안) 프로젝트를 만들지 않고 목록만 보여준다. 폴더를 직접 넘기면 그 폴더를 쓴다.
  - 브라우저에서 절대 경로로 추가한다(프로젝트 선택 옆 버튼 → 대화상자).
  - 두 방법 모두 같은 API(`POST /api/projects`)와 경로 검사(실제 경로, 저장 루트와 겹침 거부, 중복)를 거친다.
- 앱이 이미 떠 있는 포트에서 다시 실행하면 서버를 또 띄우지 않는다. 떠 있는 앱에 폴더를 넘기고 브라우저만 연 뒤 끝낸다. 저장 루트당 서버는 하나만 뜰 수 있어서다(벡터 인덱스 잠금). 포트를 다른 프로그램이 쓰고 있으면 `--port`를 안내한다.
- 저장 루트는 `~/.context-generactive-agent`.

### 개발 규칙 (2026-09-15)

- Node는 루트 `.node-version`(26.8.2)으로 고정한다. vite-plus와 fnm(`--use-on-cd`)이 모두 이 파일을 읽어 셸, 테스트, 패키징이 같은 버전을 쓴다. 실행 파일 빌드(`vp pack --exe`, Node SEA)에 25.7 이상이 필요하고, 배포 런타임과 개발 런타임을 같게 두기 위해서다.
- 앱 개발 서버 인자는 `vp run dev --host 127.0.0.1 --port 5174`처럼 `--` 없이 넘긴다.
- 모노레포 빌드 순서와 캐시는 turborepo를 두지 않고 Vite+의 Vite Task(`vp run`)로 한다. 이미 쓰는 도구에 `dependsOn`, 입력과 출력 캐시가 있어서, 태스크 그래프와 캐시를 두 곳에 나누지 않기 위해서다.
  - 루트 `build`(`pnpm build` 또는 `vp run build`)가 turbovec → memory-agent → agent 순서로 빌드한다. 각 패키지의 `build`와 memory-agent `test`, agent `package`는 workspace 의존성의 `build` 뒤에 돈다(`vite.config.ts`의 `run.tasks`).
  - turbovec `build`(cargo)는 크레이트 파일(`src/`, `build.rs`, `Cargo.toml`, `Cargo.lock`, 빌드 스크립트)만 입력으로, `memory-turbovec.node`를 출력으로 둔다. 자동 추적은 cargo의 `target/`, `~/.cargo` 읽기까지 담아 맞지 않는다. 캐시가 맞으면 cargo 없이 애드온을 복원한다.
  - memory-agent `vp pack`은 선언 파일을 만들지 않는다. 앱이 TypeScript 소스를 바로 쓰고, 선언 생성이 memory-agent 의존성이 아닌 undici-types의 전역 `Response`를 이름 붙이지 못해 빌드가 실패했다. 이 원인과 처리는 아래 '타입 검사 (2026-09-16)'에 있다.
- 변형은 리터럴 태그를 가진 서로소 유니온으로 표현하고 `switch`로 분기한다. `"key" in obj` 식 판별은 쓰지 않는다. 라이브러리 유니온이 깔끔하게 구분되지 않으면 경계에서 한 번 우리 유니온으로 바꾼다.

### 타입 검사 (2026-09-16)

- 각 패키지의 `typecheck` 태스크(`tsc`, agent는 `react-router typegen && tsc`)를 루트 `vp run typecheck`와 `ready`에서 돌린다. `vp check`의 타입 검사는 선언 이식성 에러(TS2883 등)를 잡지 않아서, memory-agent의 에러가 드러나지 않았다.
  - `typecheck`는 캐시하지 않는다(`cache: false`). Vite Task의 파일 추적은 TypeScript 7 `tsc`가 실행 파일을 찾는 경로만 기록하고, 네이티브 바이너리가 읽는 `tsconfig.json`과 소스는 기록하지 않는다. 캐시하면 소스가 바뀌어도 이전 통과를 재생한다. `package.json` 스크립트에는 태스크별 설정을 줄 수 없어서 각 `vite.config.ts`의 `run.tasks`에 둔다.
- DOM 라이브러리가 없는 패키지에서 `Response.json()`과 `new Response()`는 전역 `Response`가 아니라 undici-types의 `Response`를 돌려준다. `@types/node`가 값 `Response`를 `typeof undici.Response`로 선언하기 때문이다. 이 타입이 추론된 export 타입에 들어가면, undici-types가 의존성이 아니어서 이름을 쓸 수 없다. 응답을 만드는 헬퍼의 반환 타입을 전역 `Response`로 적어 막는다(memory-agent `src/agent/chat.ts`의 `json`).
  - `undici-types`를 의존성으로 두거나 `lib`에 `dom`을 넣지는 않는다. 앞의 것은 `@types/node`가 쓰는 버전과 계속 맞춰야 하고, 뒤의 것은 서버 패키지에 브라우저 전역이 섞인다.

### 앱 설정 위치를 모델에 알리기 (2026-09-17)

- 기본 지침에 앱 설정 파일 위치를 적는다. 외부 ACP 에이전트(`<저장소>/agents.json`, `<프로젝트>/.agents/agents.json`), MCP 서버(`<저장소>/mcp.json`, `<프로젝트>/.mcp.json`), skill 폴더(`~/.agents/skills`, `<프로젝트>/.agents/skills`), 앱 설정(`<저장소>/config.json`)이다.
  - 이유: 모델이 "codex 에이전트를 다시 등록해 줘" 같은 요청에서 설정 파일을 찾지 못했다.
- 저장소 폴더는 계정 로그인과 기억 DB가 있어서 file 도구의 거부 대상 그대로 둔다. 그 안의 파일은 사용자에게 바꿀 내용을 보여 주거나, 승인을 거치는 run_shell로 다루라고 적는다. 추가하거나 바꾼 에이전트와 MCP 서버는 사용자가 설정에서 신뢰하기 전에는 쓰이지 않는다.

### 하네스 어댑터 조사 범위 (2026-09-30)

- TanStack AI Codex·Claude Code 하네스는 기존 `SubscriptionTextAdapter`를 대체하지 않고 별도 비밀 없는 호환성 테스트로만 비교한다. 설치 버전·이벤트 매핑·도구 승인·세션 재개·계정 고정·샌드박스 경계의 검증과 미확인은 [H1 결과](./harness-compatibility-h1.md)에 기록한다.
- 하네스 이벤트의 run 토큰 수는 공급자 구독 잔여 한도가 아니다. 인증 정책과 계정별 허용된 쿼터 경로가 확인되지 않은 동안 실제 어댑터 전환이나 숫자형 한도 표시는 결정하지 않는다. Anthropic의 제3자 Claude.ai 로그인 제한은 별도 차단 조건으로 유지한다.

### 에이전트 백엔드 Effect-first 원칙 (2026-10-03)

- 사용자 지시에 따라 현재 작업과 이후의 에이전트 백엔드 구현·수리·리팩터링은 Effect다운 설계와 코드 스타일을 기본으로 한다. `packages/memory-agent`와 `apps/agent`의 백엔드 실행·라우터·생명주기 모듈에 적용한다.
- 서비스·의존성은 `Context`/`Layer`, 예상 가능한 실패는 tagged typed error와 경계 `Schema`, 자원 수명은 `Scope`/`acquireRelease`, 동시 실행·취소는 Fiber/interruption으로 모델링한다.
- 외부 Promise·콜백·Node API·SDK의 변환은 좁은 상호운용 경계에 둔다. 명령형 비즈니스 로직을 Effect로 겉포장한 것만으로 전환을 완료했다고 하지 않는다. 부수 효과 없는 계산은 순수 함수로 둘 수 있다.
- 기존 HMR·Goal·run·OAuth·owner 보호는 유지하며, Effect 전환의 검증과 남은 위반을 단계별로 기록한다. 이 원칙을 저장한 사실은 현재 모든 백엔드 코드가 이미 전환됐다는 뜻이 아니다.

### 프로젝트 AGENTS.md의 경로별 적용 (2026-10-05)

- 메인 채팅과 내부 서브에이전트는 실행 시작 시 프로젝트 루트의 `AGENTS.md` 본문을 읽고, Node.js 내장 `glob`으로 하위 `AGENTS.md`의 위치 목록만 수집한다. `node_modules`·`.git`·자격 증명 경로는 탐색에서 제외하며 기존 파일 도구가 거절하는 링크 파일은 목록에 넣지 않는다. 보고서 전용 실행에는 작업 디렉터리 지침을 추가하지 않는다.
- 모델은 작업 디렉터리에 해당하는 지침을 기존 `read_file`로 전체 읽는다. 루트에서 해당 경로까지 순서대로 읽고, 각 문서를 그 디렉터리와 하위 경로에만 적용한다. 관계없는 폴더의 본문을 미리 주입하지 않는다. 문서를 수정했거나 새 디렉터리로 들어가면 다시 확인하도록 안내한다.
- 도구 인수 해석·접근 범위 추적·지침 변경 비교·호출 차단과 재시도는 구현하지 않는다. 경로별 지침 읽기는 모델에 전달하는 작업 규칙이며 런타임의 실행 승인 조건이 아니다. 기존 도구 실행과 권한 승인 흐름을 유지한다. 목록과 루트 본문은 다음 실행에서 새로 수집한다.
- Effect 의존성 문서 읽기 요구는 루트 지침에서 제거하고 `packages/memory-agent/AGENTS.md`에 둔다. 해당 패키지에서 Effect 코드를 작성하거나 변경할 때 저장소 루트의 설치본 문서를 읽는다.

### 하위호환 기준 (2026-10-12)

- 하위호환의 기준점은 GitHub의 마지막 정식(비 canary) 릴리스다. 2026-10-12 현재 `0.0.13`(2026-09-26)이다. `0.0.12-canary-*`, `0.0.14-canary1` 같은 canary 릴리스는 기준이 아니다.
- 기준 릴리스에서 현재 빌드로의 업그레이드는 사용자 데이터(DB, 대화, 기억, 로그인)를 보존해야 한다. 현재 빌드에서 기준 릴리스로의 downgrade, canary 사이의 호환은 요구하지 않는다.
- 앞의 결정에서 "0.0.13 기준"(2026-10-07)과 "미출시라 구 release를 요구하지 않음"(2026-10-11)은 이 규칙의 두 면이다. 새 정식 릴리스가 나오면 기준점도 그 릴리스로 옮긴다.

## Effect 런타임과 진단

### Effect v4 전환 (2026-09-24)

- Effect는 `4.0.0-rc.117`을 사용한다. 서비스는 `Context.Service`, 복구 가능한 실패는 tagged typed error, 순차적인 내부 흐름은 `Effect.gen`으로 표현한다.
- 도구 입력에서 생략 가능한 키는 `Schema.optionalKey`로 선언한다. v4의 `Schema.optional`은 값의 `undefined`도 허용해 모델에 전달되는 JSON Schema에 nullable 값으로 나타난다.
- Effect의 `Result`는 `Failure`/`Success`로 판별한다. 서비스 밖의 SDK 콜백에서 Effect를 실행할 때는 현재 컨텍스트를 전달하는 `Effect.runPromiseWith`를 쓴다.

### Effect 오류와 내부 흐름 (2026-09-24)

- 에이전트 내부 흐름은 `Effect.gen`과 서비스의 Effect를 직접 조합한다. 이미 Effect인 작업을 Promise로 실행했다가 다시 Effect로 감싸지 않는다. 외부 SDK, 파일 시스템, 영속 저장소처럼 실제 Promise를 반환하는 경계에만 `Effect.tryPromise`를 둔다.
- 예상 가능한 실패는 작업과 원인을 가진 tagged error로 오류 채널에 넣는다. 입력 거절은 별도 도메인 오류로 표현한다. 불변식 위반은 defect로 남기고, 중단은 실패 복구가 소비하지 않도록 전파한다. 비밀 가리기 실패는 원문을 통과시키지 않는다.
- 실행 기준 버전은 Effect v4 RC다. 예상 가능한 실패는 tagged error를 `yield*`하여 오류 채널에 유지하고, 호출 경계에서 HTTP 상태와 오류 코드로 변환한다.
- `@effect/tsgo` 0.45.0의 Effect 언어 서비스를 memory-agent와 앱 타입 검사에 연결한다. 설치 시 TypeScript Go 패치를 적용하고 Effect 오류·경고는 타입 검사 실패로 취급하며 제안은 보고만 한다.
- 비동기 작업의 순서와 완료는 Effect semaphore, Deferred, Queue와 scoped fiber로 표현한다. `Map`은 세션·연결 같은 키로 현재 자원을 찾을 때, `Set`은 순수 멤버십 또는 구독자 목록에 쓴다. 같은 상태를 Map과 Set에 나눠 보관하지 않고, registry 항목은 작업 완료·중단·설정 변경 시 회수한다.
- 병렬 작업의 실행 중·재요청 플래그를 AgentChat의 서비스 전역 Map·Set에 보관하지 않는다. 완료 알림은 Effect Queue와 세션별 직렬화로 처리하고, 취소 뒤 자동 재개 금지는 Work Trace의 `parent_notification_holds`에 영속화한다. 다음 명시적 사용자 턴이 실행 권한을 얻으면 hold를 지운다.
- 압축이 필요한 도구 결과는 `toolCallId`로 단건 조회한다. 세션의 모든 결과 ID를 Map으로 만들어 다른 함수에 넘기지 않는다. SQLite는 `(session_id, toolCallId, seq)` 부분 인덱스로 첫 결과를 찾는다.
- 수명과 실패가 있는 서버 서비스는 생성 함수와 Effect 서비스로 구성한다. plain class는 SDK 어댑터, tagged error, `Context.Tag`처럼 상속이나 런타임 식별성이 필요한 경계에 한정한다. OAuth의 Promise 반환 계약과 셸 종료 안전망은 `docs/effect-audit-2026-09-24.md`의 수명 스펙을 정한 뒤 scoped Effect로 옮긴다.
- 상수 조회와 호출 안에서 끝나는 임시 인덱스에는 Map을 사용할 수 있다. 재시작 뒤에도 필요한 판단은 Work Trace나 DB에 저장한다. 실행 중 fiber와 취소는 Effect scope가 소유하며, 같은 실행을 여러 서비스 Map에 중복 기록하지 않는다. 창 lease는 현재 창의 짧은 점유 신호이며 작업 재개 상태로 취급하지 않는다.
- 기억 승격의 빈 문구, 현재 사용자 승인 누락, 채택되지 않은 claim·근거는 `MemoryPromotionRejected`의 reason으로 실패시킨다. 호출자는 이를 Effect 오류 채널에서 처리한다. 저장 뒤 후보가 없거나 외래 키가 어긋난 경우는 저장소 불변식 위반으로 둔다.

### Effect v4 오류 계약과 테스트 도구 (2026-09-25)

- 사용자에게 복구 방법을 제시할 수 있는 provider 실패에는 `Effect.orDie`를 쓰지 않는다. `ProviderUnavailable`은 HTTP 503 `provider_unavailable`로, 인증 상태 조회 실패는 HTTP 503 `provider_auth_unavailable`로 바꾸고 채팅 UI까지 오류 코드를 보존한다. 존재하지 않는 프로젝트는 HTTP 404로 반환한다.
- 워크플로 규칙의 벡터는 Effect Cache가 요청 중복과 만료를 관리한다. 동일 규칙 조회를 공유하고 실패는 보관하지 않는다. 함수 안에서 끝나는 임시 Map은 조회 인덱스로 허용한다.
- 외부 계약의 숫자는 `Schema.Finite`로 검증해 `NaN`과 무한대를 거부한다. 실제 `unknown` 경계에서는 `decodeUnknownEffect`를 사용하고, 이미 타입이 정해진 값은 해당 타입의 디코더를 사용한다.
- Vite Plus 1.0.0-rc.0과 Vitest 5.0.1로 올리고 `@effect/vitest@4.0.0-rc.117`을 도입한다. Vitest를 workspace override로 고정하고 Node 타입 버전을 통일해 `@effect/vitest`와 Vite Plus가 같은 실행기 인스턴스를 사용하게 한다. 서비스 layer를 공유하는 테스트부터 `layer`와 `it.effect`로 옮긴다. SDK·브라우저 Promise 경계는 일반 Vitest 테스트를 유지할 수 있다.

### Effect v4 정식판 사용 (2026-10-02)

- 이미 이전된 v4 RC.117에서 정식판으로 올린다. `effect`와 `@effect/vitest`는 동일한 `4.0.0`으로 고정하고 catalog와 lockfile을 함께 갱신한다. 별도 버전 체계의 타입 검사 도구 `@effect/tsgo`는 `0.45.0`을 유지한다.
- 채팅의 권한 검토 거부 메시지를 판별하는 문자열 검증은 정식 API `Schema.isStartingWith`를 사용한다. 기존 RC 이름을 복원하는 호환 계층은 추가하지 않는다.
- 병렬 작업의 현재 소스를 복사한 격리 검증본에서 전체 타입 검사, `vp check`, 메모리 테스트 764개(2개 건너뜀), 앱 서버·채팅 관련 테스트 39개, React Router 프로덕션 빌드와 서버 번들이 통과했다. 최초 병렬 검증의 Goal worker 테스트 제한 시간 초과는 전체 메모리 테스트 재실행에서 발생하지 않았다.
- 의존성 설치는 실행 중인 개발 백엔드 재시작과 분리한다. 현재 백엔드는 기존 번들을 계속 사용하며 정식판 백엔드는 병렬 Goal 작업이 끝난 뒤 다음 빌드·재시작부터 적용한다.
- 적용 후 원본 재검증 시 병렬 에이전트가 검증본 생성 이후 수정한 `packages/memory-agent/src/agent/full-loop-execution.ts`와 `packages/memory-agent/tests/full-loop-execution.test.ts`에서 타입·포맷 오류가 관측됐다. 이 파일은 업그레이드 변경에 포함하지 않으며 격리 검증 결과와 원본의 진행 중 상태를 구분한다. 설치 전후 health의 backend build ID·runtime instance ID와 기존 running run ID는 동일했다.

#### 원본 후속 검증 (2026-10-03)

- 원본 설치 상태에서도 `effect`와 `@effect/vitest`가 모두 `4.0.0`이며, 앞서 관측된 병렬 작업 파일의 타입·포맷 오류가 해소됐다. 전체 `vp run -r typecheck`와 `vp check`가 통과했다.
- 원본에서 `vp run --no-cache agent#bundle`로 네이티브·메모리 패키지·앱·서버 번들을 다시 빌드했다. 새 서버 번들은 `--dev-backend --no-open`과 격리된 임시 저장소로 기동해 health의 ready 응답, runtime instance ID와 해당 child의 PID·port·저장소 lock 일치를 확인하고 종료했다. 사용자 프로젝트·모델·keychain 요청은 수행하지 않았다.
- 빌드·lint·테스트 동시 실행에서는 worker·SDK 복사 테스트의 제한 시간 초과와 후속 정리 오류가 관측됐다. 테스트 코드를 변경하거나 제한 시간을 늘리지 않고 단독 재실행했다. 원본 메모리 전체 112개 파일의 766개 테스트 통과·2개 건너뜀, 앱 서버·채팅 관련 13개 파일의 40개 테스트 통과를 확인했다. 테스트별 프로세스 격리는 유지했다.
- 원본 5173 서버는 재검증 시작 시 이미 정지 상태였다. 사용자 저장소에서 Goal을 재개하거나 실제 서버를 자동 기동하지 않았으며, 다음 앱 실행은 새 정식판 번들을 사용한다.

### Map·Set 응답 대기와 상태 소유권 정리 (2026-10-06)

- 화면의 서버 메시지·큐 배열은 배열에서 직접 대조한다. 구독자 목록과 현재 창의 요청 직렬화는 서버 응답을 복제하는 인덱스와 구분한다.
- import·embedding·Kiwi·redaction worker의 요청 ID 레지스트리는 `Ref<HashMap>` 상태로 `Deferred`를 연결하며, 정상 응답·전송 실패·취소 때 등록을 회수한다. 연결 종료나 잘못된 응답은 남은 대기자를 끝낸다. Kiwi 워밍업은 서비스 scope가 소유한다.
- 하위 에이전트의 도구 진행, RPC의 `Ref<HashMap>` 응답 대기·취소 상관관계, OAuth 실행 점유·삭제 및 로그인 진행·결과는 각각 하나의 태그 상태 레지스트리가 소유한다. Goal 실행 권한은 run ID별 capability 하나로 보관하며 영속 dispatch gate와 재실행 금지는 유지한다.
- SDK가 Promise 결과를 순서대로 소비하는 경계의 임시 결과 캐시는 실행 fiber 레지스트리와 구분한다. 병렬 읽기 결과는 SDK 소비 시 삭제하고 취소 시 남은 결과를 회수한다. 정상 종료 시 캐시의 수명은 해당 SDK 실행으로 한정하며, worker의 완료 권한 계약을 바꾸는 종료 hook은 추가하지 않는다. Node 네이티브 worker의 독립 RPC 클라이언트는 현재 로딩·생성 코드 계약을 유지한다.
- 전체 생성식 목록과 유지 근거는 `docs/map-set-audit-2026-10-06.md`에 기록한다. 이 목록은 저장소 코드의 스냅샷이며 의존성·빌드 산출물·스킬 예제는 포함하지 않는다.

#### Effect 진단의 native 경계와 시간·대기 수명 (2026-10-06)

- 새 Effect 진단은 memory-agent와 앱에서 오류·경고까지 검사하고 severity를 유지한다. Vitest·React/query·Node/SDK의 native 계약 및 동기 DTO/SQLite codec, 고정 인자 application API에는 범위를 제한한 진단 예외와 이유를 코드에 남긴다. React UI에는 앱 AGENTS.md의 Effect 적용 제외 기준을 따른다.
- owner의 일회성 요청 대기는 Deferred와 Ref<HashMap>으로, stream producer/consumer 전달은 Queue로 관리한다. RcMap은 공유 scoped resource 획득·반납에 사용한다. 고정된 worker 자산은 세 개의 독립 모듈과 SDK만 복제하므로, native RPC adapter는 외부 Effect 런타임을 가져오지 않고 MessagePort 경계의 Promise 계약을 유지한다. 응답 상관관계는 숫자 ID별 객체로 보관한다.
- Effect 내부 시간은 Clock/DateTime을 사용하고, SDK 동기 callback은 소유자의 Clock을 캡처한다. 해석·센서의 deadline과 HTTP body 취소는 Scope/timeout에 묶고 RRSI 주기 검사는 Schedule/scoped fibers로 관리한다.

### native Map 예외 재검토 (2026-10-06)

- 지역 인덱스·상수·테스트·Node 경계만으로 native Map을 허용했던 1차 판단을 수정한다. 내부 갱신 인덱스는 MutableHashMap, 상수는 HashMap, 재사용 encoder는 Effect Cache로 관리한다. 실제 SDK 승인 데이터와 wire codec 및 해당 계약의 테스트에만 native Map을 남긴다.
- 동일 키 작업의 직렬화는 RcMap에서 Semaphore를 공유한다. 대기 작업도 획득 scope를 유지하고 성공·실패·취소 시 반납한다. 서비스는 상위 scope, 브라우저 lease 직렬화는 ManagedRuntime이 소유하며 HMR 종료 시 dispose한다.
- RRSI worker 응답 대기는 Ref<HashMap>과 Deferred로 관리한다. 고정된 worker의 독립 RPC 클라이언트는 숫자 요청 ID별 객체를 사용하며 native Promise·MessagePort 및 자산 복제 계약을 유지한다.

### 설정 실패와 제보 요청의 Effect 경계 (2026-10-07)

- 설정 파일의 읽기·쓰기 및 검증 실패는 `GlobalConfigFailed` 실패 채널로 전파한다. 저장소 어댑터의 `mapError`는 예상된 실패만 변환하며 결함과 취소는 보존한다. 설정 읽기 실패를 모델 미지원으로 분류하지 않는다.
- 제보 응답은 서버·클라이언트가 공유하는 스키마로 검증한다. 실패 응답의 비공개 본문은 표시하지 않고, 화면의 세션·증거·상세 요청은 소유 fiber의 Scope가 취소를 관리한다.
- React API 오류도 태그와 스키마를 가지며 `Schema.is`로 판별한다. 네트워크·JSON·스키마 검증 실패는 typed failure로 처리하고, Effect 내부의 일반 `Error` throw로 예상된 실패를 만들지 않는다.

### archive 설치의 Effect 서비스와 호스트 경계 (2026-10-07)

- archive 검증·설치 순서는 `ArchiveInstaller`, 다운로드·해시·파일·tar 실행은 주입 가능한 `ArchiveHost`로 분리한다. 구현 의존성은 Layer 구성에서 해결하며 도메인 서비스 메서드에는 호스트 요구사항을 누출하지 않는다.
- 예상 실패는 `ArchiveInstallFailed`와 태그가 있는 reason으로 전파한다. native Promise 진입점에서만 기존 결과 형식으로 변환하며 Effect 호출자는 자기 runtime과 취소 계약을 유지한다.
- 임시 디렉터리는 `acquireUseRelease`가 정상 완료·실패·중단 시 반납한다. tar 중단은 프로세스를 종료하고 close를 기다린 뒤 디렉터리를 정리한다. 정리 실패도 typed error 채널에 남긴다.
- unstable API 진단과 native artifact의 의존성 제한은 유지한다. 서비스로 감싸는 것만으로 어댑터 경고가 해결됐다고 간주하지 않으며, 남은 Node·fetch 경고는 별도로 추적한다.

### Node 플랫폼 서비스와 native factory 호스트 의존성 (2026-10-07)

- archive와 프로젝트 등록의 파일·경로·해시·UUID 작업은 `FileSystem`, `Path`, `Crypto` 서비스로 합성하고 Node 구현은 `@effect/platform-node` Layer에서 제공한다. 서비스 구성 시 의존성을 캡처하며 내부에서 별도의 runtime을 만들지 않는다.
- 프로젝트 경로 부재와 권한·stat·UUID 실패를 구분하고 후자는 `ProjectHostFailed` 실패 채널에 남긴다. symlink의 실제 경로 해석과 저장소 겹침 거부는 유지한다.
- 파일 삭제 재시도는 기존 errno 목록·횟수·지연을 Schedule로 유지한다. 취소할 수 없는 단일 Node 파일 작업은 완료를 기다린 뒤 staging을 해제하되 재시도 사이의 대기는 중단할 수 있다.
- native factory의 명시적 호스트 패키지 목록에 기존 의존성인 `@effect/platform-node`를 추가한다. 외부 패키지 전부를 허용하지 않으며, 빌드와 소스 제거 후 새 프로세스 실행으로 호스트 해석을 검증한다.
- `O_NOFOLLOW`와 동기 transaction fence처럼 설치된 플랫폼 API로 동일하게 표현할 수 없는 보호 계약은 그대로 유지한다. 프로세스·HTTP의 unstable API 정책과 진단 설정은 이 변경에서 낮추지 않는다.

### Effect 4 컬렉션의 키 동등성과 AST 방문 추적 (2026-10-07)

- Set/Map 전환은 API 치환에 앞서 키의 동등성·불변성 계약을 확인한다. Effect 4의 구조 해싱을 AST·scope·변경 가능한 SDK 객체에 적용하지 않고 안정적인 도메인 ID를 우선 사용한다. 외부 객체를 `byReferenceUnsafe`로 전역 표시하지 않으며, 조회마다 새 `byReference` 프록시를 만들지 않는다.
- 린트의 변수·타입 별칭 방문 집합은 한 Program 안의 선언 시작 위치를 키로 쓴다. 이름이 같은 내부 선언을 구분하고 순환 추적을 유지하면서, 부모·scope로 연결된 AST 전체를 해싱하지 않는다. 파일 간 집합으로 확장할 경우 파일 ID도 키에 포함해야 한다.
- AgentChat이 소유한 SDK Worker는 불변 `runId`로 등록·제거하고 Worker와 lease 해제 콜백은 값으로 보관한다. 종료로 변경되는 Worker 내부 상태가 정리 키에 영향을 주지 않는다.
- 문자열·숫자 ID 기반 컬렉션과 함수 참조의 방문·리스너 컬렉션은 별도로 판단한다. 객체를 값으로 보관하는 Map은 객체 키의 구조 해싱 문제에 해당하지 않는다.

### 실행 플래그의 ConfigProvider 주입 (2026-10-07)

- Goal worker와 native artifact 활성화 플래그는 호출 컨텍스트의 ConfigProvider로 읽는다. 기본 제공자는 환경변수를 사용하고 누락된 플래그는 기존대로 비활성화한다.
- worker 경계 테스트는 ConfigProvider Layer에 플래그를 주입한다. 프로세스 전역 환경변수를 변경하지 않고도 실제 워커의 입장·최종화·재열기 계약을 검증한다.

### Effect 4 strict async와 SDK 경계 (2026-10-08)

- 앱과 memory-agent의 `asyncFunction` 진단은 error로 유지한다. 도메인의 반복·대기·병렬 처리·해제는 Effect와 Stream에서 계산하며, Promise 및 AsyncGenerator는 실제 SDK·React·Node 호출 계약에 연결하는 경계에서만 제공한다. `@effect-diagnostics` 억제 주석으로 예외를 만들지 않는다.
- Promise 경계는 실제 네이티브 작업의 rejection을 Cause.UnknownError로 받아 원래 원인으로 반환한다. SDK에 넘기는 기존 AbortSignal의 참조, 실제 SDK 종료를 기다리는 해제 순서와 서비스 Scope 소유권을 유지한다. AsyncGenerator의 return은 진행 중인 pull을 중단하고 자원 해제 완료를 기다린다.
- HashSet·HashMap·FiberMap의 키는 안정적인 문자열·숫자 ID를 사용한다. AST와 변경 가능한 SDK 객체의 참조 동일성이 필요한 곳은 경계의 WeakMap으로 ID를 발급하고 객체는 값으로 보관한다. 외부 객체의 전역 동등성 계약을 변경하지 않는다.
- 고정 Goal worker는 Effect 4의 실행용 dist JavaScript, 전체 런타임 의존성 그래프와 native-effect/native-stream 보조 파일까지 자신의 불변 스냅샷에서 읽는다. Effect 원본·선언·source map은 실행되지 않으므로 Goal마다 복제하지 않는다. 새 캡처의 경쟁 감지, 저장된 해시 검증, cold adoption과 자동 재실행 금지는 유지한다. 실행 파일에도 동일한 agent/runtime 경로와 Effect 패키지를 포함한다.
- 현재 작업 트리에서 AST async 선언과 소스의 억제 주석은 0개다. `vp check` 및 전체 회귀 테스트 221개 파일·1300개 테스트와 브라우저 테스트 4개가 통과했다. native TypeScript의 error 진단은 0개지만 warning 523개로 `vp run typecheck`의 종료 코드는 1이다. warning을 숨기거나 검사를 통과했다고 보고하지 않는다. 실제 유료 모델·Docker 평가는 실행하지 않았다.

- native artifact 서비스 초기화는 소스 패키지의 빌드 경로를 조회하지 않는다. 실제 새 빌드 요청에서만 경로를 확인하고 실패를 NativeRegistrationError로 전달한다. 저장된 artifact를 사용하는 실행 파일의 시작은 소스 checkout을 요구하지 않는다. 이 변경 후 관련 테스트 14개와 독립 실행 파일 스모크 검증 12개가 통과했다.

### Effect 패치 정렬과 API 안정성 진단 (2026-10-11)

- 사용자 확인에 따라 공식 Effect RPC·Workflow·SQL 구현을 유지하며 app와 memory-agent의 `unstableApiUsage`만 off로 설정한다. 일반 타입 오류, 오류·취소·Scope 계약 검사를 유지하며 안정성 경고 때문에 실행 프로토콜을 자체 재구현하지 않는다.
- 공개 registry의 Effect latest는 4.0.2였다. platform-node/vitest latest 4.0.3은 아직 게시되지 않은 effect 4.0.3을 peer로 요구하여 적용하지 않고, 실제 설치 가능한 effect/platform-node/vitest 4.0.2 조합을 정확한 버전으로 고정한다. 다른 사용자 의존성 변경은 유지한다.
- 카탈로그의 최초 호출자 소유권을 유지한다. 대기자의 취소는 소유자 요청을 중단하지 않고, 소유자의 취소는 해당 요청의 AbortSignal과 현재 대기자에게 전달한다. Effect 4.0.2의 공유 cache 조회 수명에 의존하는 대신 Deferred·Ref·Semaphore와 짧은 uninterruptible admission/cleanup으로 이 계약을 표현한다. 실패·중단은 즉시 재시도 가능하고 성공 TTL은 30초로 유지한다.

### 공식 Effect 서비스와 DB Migrator의 적용 (2026-10-11)

- unstable 진단만 끄고 일반 경고는 실제 API·타입·자원 소유권을 고친다. 경고를 종료 코드에서 제외하는 옵션이나 일반 진단 억제는 추가하지 않는다. 공식 RPC·Workflow·SQL을 자체 구현으로 교체하지 않는다.
- DB Migrator는 기존 DatabaseSync 연결과 user_version을 유지한다. BEGIN IMMEDIATE 뒤 cursor를 읽고, legacy 이력 최초 채택·pending SQL·metadata·user_version·FK/행 보존 검증을 atomic commit/rollback한다. 기존 metadata 불일치는 초기화로 덮어쓰지 않고 거부한다.
- 일반 HTTP/프로세스/파일 작업과 타이머는 공식 서비스·Scope/Fiber로 소유한다. 동기 SQLite fence와 SDK/native adapter에 남은 경계는 보존 계약과 전환 조건을 개별 기록하며, API가 없다는 포괄적 판단으로 억제하지 않는다.
- full-loop worker는 Effect 포함 self-contained JS bundle이며 native.mjs는 owner의 Effect/TanStack/Node platform 서비스를 공유한다. 배포 runtime의 dependency 수집에 external Node platform을 포함한다. Windows 패키징은 CI에서 검증한다.
- 구현·잔여 항목·검증은 [Effect 경고 전환 기록](effect-warning-remediation-2026-10-11.md)에 기록한다.

### 동기 경계의 실제 비동기 서비스 이행 (2026-10-11)

- MCP·외부 ACP 설정 읽기와 신뢰/도구 조회, Skills catalog/read, CLI 폴더 검사 및 host 실행 파일 검사는 공식 FileSystem Effect를 반환하며 호출부도 함께 실행한다. 공개 채팅 handle에는 생성 시 캡처한 플랫폼 Context를 제공해 requirement 증가를 막는다.
- 외부 ACP 프로세스와 SDK stream은 Scope·ChildProcessSpawner·NodeStream·NodeSink가 관리한다. Windows 명령의 literal 인자·npm shim escaping·shebang flags를 보존한다.
- dev owner lock은 공식 FileSystem과 Scope로 획득/해제하며 정상 종료는 runtime dispose → lock release → process exit 순서다. stale PID lock 회수와 강제 종료 후 복구는 유지한다.
- Goal asset 일반 생성·publication·adopt·dispose는 FileSystem Effect와 Semaphore로 관리한다. async 검증이 끝난 뒤 owner가 여전히 살아 있는지 DB pin 기록 직전 다시 확인한다. Worker 생성 직전의 동기 파일 fence와 lease release는 유지한다.
- 공식 API에 없는 파일 보안·서명·프로세스 종료 정보 및 공식 Workflow type-erased 경계는 변경하지 않았고 추가 진단 억제도 적용하지 않았다. 해당 범위의 추가 결정은 [후속 기록](effect-warning-remediation-2026-10-11.md)에 있다.

#### 2026-10-11 — Activity의 encoded 결과 저장

공식 Activity.executeEncoded가 이미 적용한 success/error codec을 owner Workflow 저장 경계에서 다시 적용하지 않는다. encoded Exit 모양만 저장·복구하고 공식 WorkflowEngine.makeUnsafe가 concrete schema를 한 번 디코딩한다. FiniteFromString 회귀로 중복 인코딩 오류를 재현하고 수정했다. 기존 identity codec의 저장 형식과 schema 49는 유지한다. PR #8900의 noFollow/positional read는 4.0.3 GitHub 릴리스에 포함됐지만 effect 4.0.3의 npm 배포가 확인되지 않아 버전 혼합이나 타입 패치를 하지 않았다. 진단 예외는 승인되지 않았으므로 보류한다.

#### 2026-10-11 — 공식 Effect preview 및 제한된 파일 API 전환

사용자의 preview 설치 요청에 따라 effect, platform-node, platform-node-shared, vitest를 공식 main CI가 배포한 동일 커밋 `844a77b18c03b4faa386cf04bf94908d3d37abc7`의 pkg.pr.new URL로 고정한다. 네 패키지 모두 4.0.3이며 overrides로 간접 의존성도 동일 커밋을 사용한다. 공급망 정책의 영구 예외는 추가하지 않는다.

일반 bounded 파일 읽기는 공식 scoped FileSystem.open의 noFollow와 positional read를 사용한다. checkLeaf는 열린 handle의 regular-file 및 단일 hard-link 조건을 검사하며 metadata가 없으면 거부한다. Windows 등 noFollow 미지원 플랫폼은 공식 BadArgument로 안전하게 실패한다. 편집 충돌 검사에는 nanosecond fstat 및 동일 FD가 필요하고 공식 File.Info는 이를 노출하지 않으므로 해당 native 경계는 유지한다. UUID 호출부는 preview의 함수 API로 맞춘다. Workflow unknown/any 경고 및 기존 native 경계 진단을 추가로 억제하지 않는다.

#### 2026-10-11 — Windows 정상 파일 읽기 회귀 수정

앞선 모든 OS에 noFollow를 적용한 결정은 Windows의 정상 파일 읽기까지 거부하는 회귀를 만들었으므로 수정한다. macOS/Linux는 공식 FileSystem noFollow 및 positional read를 유지한다. Windows는 명시적 플랫폼 분기로 기존 native FileHandle의 positional read, fstat, close 오류 계약을 유지한다. 열린 handle의 checkLeaf regular-file/hard-link 검사와 caller의 디렉터리/leaf 검증도 유지하며, Windows helper 자체에서도 open 전에 lstat로 관찰된 symlink를 거부한다. 이 검사는 링크 교체 경쟁을 원자적으로 차단하지 않으며 기존 Windows에도 POSIX O_NOFOLLOW 보장은 없었다. Skills에서 허용하던 일반 hard-linked 파일은 checkLeaf=false일 때 계속 허용한다. 테스트는 Context.Reference로 Windows 분기를 주입하여 host OS 전역 변경 없이 검증한다. 실제 Windows 권한 및 파일 시스템 검증은 별도 CI가 필요하다.

### 백엔드 런타임의 명시적 설정과 소유권 (2026-10-11)

- 개발 backend는 고정 번들로 실행하며 UI만 HMR을 사용한다. `contextGeneractiveAgent`와 `contextGeneractiveBackendCleanup` 전역 변수 대신 서버 build의 entry가 동일한 agent runtime의 설정과 dispose를 제공한다. CLI는 첫 서비스 획득 전에 storage/runtime 경로를 설정한다.
- backend Scope는 agent dispose 뒤 storage lock을 해제한다. signal과 beforeExit listener도 해당 Scope에서 제거하며 startup 실패에도 같은 정리 경로를 사용한다.
- runtime 경로는 workerData의 별도 metadata로 전달한다. 기존 worker payload와 SDK 환경은 유지하며 process.env를 변경하지 않는다. checkout의 명시적 null 경로와 미설정 시 기존 환경 변수 fallback을 구분한다.
- `memory-agent/runtime-resources`는 workspace 내부 TypeScript 진입점이다. types/development/import/default 조건은 같은 source를 가리키며 기존 exports:false 패키지 빌드 정책을 유지한다. 앱 서버·실행 파일 빌드는 이를 번들에 포함한다.
- 새 React Router entry는 Web Stream으로 HEAD, shell/all-ready, 렌더 오류, 요청 취소와 렌더 deadline을 유지한다. 격리 Vite 개발조건에서 실제 세션 페이지 SSR을 검증하며 운영 DB와 모델을 사용하지 않는다.

### EFX12 typecheck gate의 남은 native 경계 (2026-10-12)

- 고칠 수 있는 진단은 실제 코드로 고친다. 다인자 테스트 헬퍼는 `Function.dual`로 pipeable 오버로드를 주고, Effect를 돌려주는 헬퍼는 `Effect.fnUntraced`로 쓴다. 서비스 key는 `deterministicKeys`가 요구하는 파일 기준 이름을 쓴다. 앱 서버 테스트는 삭제된 Promise `testRuntime` 대신 `TestEnv`/`testAgent`를 쓴다.
- O_NOFOLLOW·같은 FD의 정밀 stat·동기 SQLite/Worker fence, Ed25519 서명, 상수시간 비교, 증분 SHA-256, 동기 process-tree 종료, NodeHttpServer loopback factory·React Router http bridge, POSIX glob, 공식 Workflow encoded 경계의 any/unknown 25곳은 설치된 Effect 4.0.3 preview에 대체 API가 없다. 진단 억제, severity 하향, exit-code 제외, 개별 예외를 추가하지 않고 보안·동기 fence 계약도 바꾸지 않는다. 따라서 `vp run typecheck`는 이 경고로 exit 1이며 EFX12-2는 '차단 일부'로 남긴다. 위치와 필요한 기능은 [EFX11–12 검증](efx11-12-verification.md)과 [Effect 경고 전환 기록](effect-warning-remediation-2026-10-11.md)에 두고, Effect·드라이버 업그레이드 때 다시 검토한다.

### 비동기 lstat와 Workflow 타입 보존 (2026-10-15)

- 현재 고정된 Effect 4.0.3 preview 커밋은 유지하고, `effect`의 FileSystem 계약·makeNoop와 `@effect/platform-node-shared`의 Node 구현에 `lstat`를 pnpm patch로 추가한다. 소스·실행 JS·타입 선언을 함께 패치하며 기존 stat의 effectify, PlatformError, bigint 메타데이터 변환을 재사용한다.
- 프로젝트·외부 경로 및 shell 작업 디렉터리 검사를 Result와 lstatSync에서 Effect로 전환한다. 각 경로 구성요소의 심볼릭 링크 거부, 하드 링크 거부, device/inode 기반 범위 검사를 유지한다. inode를 표현할 수 없으면 허용하지 않는다. 없는 경로만 부모 경로로 정규화하며 권한·I/O 실패는 PlatformError로 전파한다. 이 검사는 동시 디렉터리 교체를 막는 OS sandbox가 아니다.
- 스킬·워크플로 규칙·AGENTS 목록에서 readLink+stat 우회를 제거한다. 파일 열기의 no-follow, 동일 FD 검사와 SQLite 등록 시점의 동기 검증은 유지한다. 동기 설정 팩토리의 기존 canonicalPath는 별도로 남는다.
- Workflow 등록 콜백은 성공·오류 타입을 제네릭으로 유지하고 Workflow.intoResult가 실패를 결과로 옮긴 뒤 이종 등록 목록에 저장한다. Activity 실행도 성공·오류·서비스 타입을 제네릭으로 전달한다. any 캐스팅이나 오류의 defect 변환으로 경고를 피하지 않는다. 기존 interruption·suspension·보상 동작은 intoResult가 계속 담당한다.
- pnpm 12.4.1에서는 URL 의존성 패치가 lockfile에 기록되고 설치가 성공해도 실제 파일에 반영되지 않았다. 동일 패치의 실제 적용을 확인한 12.13.0으로 마이너 업데이트한다. 패치는 4.0.3에만 지정한다. 의존성 버전·URL·integrity는 유지하고 blockExoticSubdeps 기본값을 끄는 설정은 저장하지 않는다. 패치 등록 시 기존 URL 그래프의 lockfile 생성은 일회성 설정으로 수행했고, 일반 frozen 설치는 기본 보안 설정으로 검증한다.
- 패치 제거 조건은 설치한 Effect가 같은 no-follow lstat 계약을 제공하고, 파일·디렉터리·정상 및 dangling 링크·NotFound·makeNoop 회귀 테스트가 통과하는 것이다. 오류·경고 severity와 검사 종료 기준은 유지한다. 남은 native I/O 경고는 별도 기능 공백으로 보고한다.

### node 내장 fs 경계의 FileSystem 이행 (2026-10-17)

- `nodeBuiltinImport`가 warning이라 검사가 통과하면서 `Effect.try`·`Effect.sync`로 감싼 node fs 호출이 계속 늘었다. 대응 API가 있으면 쓰고, 없으면 진단을 끄지 않고 패치나 모듈로 기능을 채운다.
- 같은 pnpm patch에 `FileSystem.openDirectory(path): Effect<Directory, PlatformError, Scope>`와 `File.Info.mtimeNs`·`ctimeNs`(`Option<bigint>`)를 추가한다. 디렉터리 항목은 링크를 따라가지 않은 종류를 함께 돌려주고, 핸들은 Scope가 닫는다. 나노초 시각은 이미 bigint로 읽는 stat에서 그대로 옮긴다.
- 디렉터리 순회, 텍스트 파일 읽기·생성·교체·페이지 읽기, 샌드박스 임시 폴더, native artifact 읽기를 FileSystem으로 옮긴다. 생성·교체·페이지 읽기의 no-follow는 POSIX에서만 켠다. 이전에도 Windows에는 O_NOFOLLOW가 없었다. 교체는 임시 파일 핸들을 자체 Scope로 닫고, 쓰기·검사·교체 중 어디서 실패해도 임시 파일을 지운다.
- 동기 `canonicalPath`를 없애고 호출부를 `canonicalPathEffect`로 옮긴다. 공급자 도구 정책은 작업공간 루트를 검증할 때 정규화하고, 실패하면 `workspace_root_unavailable`로 거부한다.
- POSIX glob은 Node `path.matchesGlob`이 쓰는 minimatch를 같은 옵션으로 직접 쓴다.
- 동기 fence 두 곳을 Effect 경계로 옮기며, 2026-10-12의 "동기 fence 계약을 바꾸지 않는다"를 대체한다. Goal worker 자산은 `use`가 registry lock 안에서 검증하고 lease를 잡는 Effect가 되고, Worker 생성 직전 `acquireWorkerLease`로 실행된다. Worker를 만들지 못하면 scope finalizer가 lease를 놓는다. native artifact 등록은 SQLite `atomic` 직전에 출처와 바이트를 한 번 검증한다. 대상 경로는 owner 저장소의 content-addressed 경로라 transaction 안의 재검증은 두지 않는다.
- 같은 패치에 `FileSystem.statDescriptor`, `ChildProcess`의 `windowsVerbatimArguments`, `ChildProcessHandle.exitStatus`(`Exited`·`Signaled` 태그)를 추가하고, `@effect/platform-node`에 `NodeHttpServer.createServer`를 노출한다. 셸 명령은 `ChildProcess`로 실행하며 process group 종료와 SIGKILL 유예는 spawner가 맡는다. 종료 시 동기 안전망은 handle의 kill을 `runForkWith`로 시작한다. leader가 끝나고 그룹도 없어 kill이 실패하면 이미 멈춘 것으로 본다. `stopProcessTree`는 없앤다.
- node 내장 import가 남지 않아 memory-agent와 agent 앱의 `nodeBuiltinImport`를 error로 올린다. 이에 따라 2026-10-12에 차단으로 남긴 `vp run typecheck`가 exit 0으로 통과한다.
- 패치 hash를 다시 계산하려면 lockfile 해석이 필요하다. 사용자 결정에 따라 `blockExoticSubdeps: false`를 저장하며, 위 2026-10-15 결정의 "설정을 저장하지 않는다"를 대체한다. pnpm에는 패키지 단위 예외가 없으므로 Effect를 registry에서 받게 되면 되돌린다. 전체 재해석은 무관한 peer 해석(zod 등)을 바꾸므로, 이번 lockfile 변경은 patch hash와 minimatch 항목으로 한정했다.

### 의존성 상향 (2026-10-17)

- 의존성은 가능한 최신으로 올리고, 여러 패키지가 같이 쓰는 버전은 catalog로 모은다. Vite+ 1.3.0, `@effect/tsgo` 0.53.3, `@shadcn/lint` 0.2.1, React Router 8.4, sharp 0.35, undici 8, motion 14 등을 올렸다. `@effect/tsgo`는 0.48이 Oxlint 1.88을 지원하지 않아 함께 올린다.
- zod는 4.6.7 하나로 맞춘다. 성능이 개선된 버전이고, 전체 재해석 때 peer 해석이 zod 3으로 내려가는 일을 막으려고 루트 devDependency와 override `"zod@^4": "catalog:"`를 둔다. `@anthropic-ai/sandbox-runtime`은 자체 zod 3을 유지한다.
- TanStack AI는 0.61 계열에 둔다. 0.69는 ChatResult·adapter·MCP transport·모델 표 API가 크게 바뀌어 별도 단계에서 옮긴다. 그때까지 `@tanstack/ai-react`는 0.29.1로 고정한다. 0.29.5는 `@tanstack/ai-client` 0.37을 끌어온다.
- sharp 0.35의 CommonJS 타입은 `typeof import("sharp", { with: { "resolution-mode": "require" } })`로 읽는다.
- react-simplikit 0.3.3에도 SSR 수정이 없어 기존 패치를 `react-simplikit@0.3.3.patch`로 옮긴다.

## 인증·모델·공급자

### 인증과 모델 (2026-09-15)

> 대체됨: codex app-server 경로는 2026-09-19에 제거했다. 아래 "codex 런타임 제거" (2026-10-12 기록)를 본다. 이 절과 다른 절의 codex 관련 내용(`turn/steer`, `codexAgentLoop`, codex 샌드박스, 번들 skill 끄기, codex 받기)은 역사 기록이다.

- ChatGPT OAuth와 모델 호출은 codex app-server(JSON-RPC over stdio)로 한다. 토큰은 codex가 관리하고 앱은 읽지 않으며, API 키로 재사용하지 않는다. codex 설정, 로그인은 앱 전용 `<저장 루트>/codex`(CODEX_HOME)에 두어 사용자의 `~/.codex`와 섞지 않는다.
- codex는 사용자가 설치하지 않고, 사용자가 설치한 codex는 버전이 같아도 쓰지 않는다. 앱이 codex app-server의 실험 API(`dynamicTools`, `thread/inject_items`, `turn/steer`, code mode)에 기대고 사용자 codex는 스스로 업데이트되기 때문이다. 버전은 npm `@openai/codex` 0.154.0으로 고정한다.
  - 저장소 실행(개발, `vp run start`): 의존성으로 설치된 이 기기용 패키지의 `codex`와 code mode 호스트를 쓴다.
  - 실행 파일: codex를 넣지 않고, 처음 필요할 때 npm 레지스트리에서 이 기기용 tarball(darwin-arm64 116 MB)을 받아 lockfile의 sha512와 대조한 뒤 `<저장 루트>/runtime/codex-<버전>-<플랫폼>`에 푼다. 받는 동안 로그인 상태는 `installing`이고, 실패하면 `install_failed`로 알린 뒤 60초 뒤부터 다시 시도한다(2026-09-15). 시도마다 패키지 전체(윈도우 142 MB)를 다시 받으므로, 상태 조회가 짧은 간격으로 다시 받게 두지 않는다. 실패 이유(받기, 체크섬, 경로, 풀기와 그 오류)는 화면에 보이지 않고 앱을 실행한 창의 로그에만 남긴다. 넣으면 실행 파일이 약 420 MB가 되고 풀 때 디스크를 두 배로 써서다.
  - 대가: codex 프로세스 하나가 뜬다(대화 중 RSS 약 65-73 MB, code mode 호스트 약 5-12 MB).
  - 검토한 대안: 앱이 직접 OAuth 로그인하고 ChatGPT Codex 백엔드 Responses API를 부르는 방식(jcode). 설치물과 프로세스는 줄지만 Codex CLI 요청을 흉내 내는 비공개 경로이고, gpt-5.6 code mode 도구 호출, 스티어링, 긴 대화 압축, 토큰 갱신을 앱이 다시 만들어야 해서 택하지 않았다.
- 모델은 로그인 후 계정에서 쓸 수 있는 목록에서 사용자가 고른다. 없는 모델은 자동 대체하지 않고 오류.
- 모델 호출은 `CodexTextAdapter`(TanStack 어댑터)로 하고, 도구는 `dynamicTools`로 넘겨 `item/tool/call`을 TanStack 도구 실행으로 연결한다. code mode 전용 모델(gpt-5.6 계열)을 위해 `features.code_mode_host`를 끄지 않는다.
- 도구를 쓰는 codex `chat()`(대화, 서브에이전트)은 반복을 codex가 정한다(2026-09-15). 모델 단계가 `tool_calls`로 끝나는 동안 계속 반복하고(`codexAgentLoop`), 도구 결과는 다음 단계에서 기다리던 codex 턴으로 넘어간다.
  - TanStack 기본값(모델 단계 5번)에서는 순차 도구 호출 5번째 뒤에 run이 끝났다. 마지막 결과는 codex에 전달되지 않고 답변 없이 `completed`로 기록되었으며, codex 턴은 결과를 기다리며 남았다.
  - 도구 호출 횟수에는 상한을 두지 않는다(2026-09-15). run은 codex가 답을 마치거나, 사용자가 중지하거나, 실패할 때 끝난다. 긴 작업이 중간에 끊기지 않게 하기 위해서이고, 멈추는 수단은 중지 버튼(Esc)이다.
  - run이 끝나면(완료, 실패, 취소) 기다리던 codex 턴을 `turn/interrupt`한다(`codexRunMiddleware`). 승인 대기로 멈춘 run은 끝난 것이 아니므로 턴을 유지해 이어 간다.
- run마다 새 codex 스레드에 대화 전체를 넣을 때, 최근 사용자 턴 2개(답하는 턴 포함) 밖의 도구 출력은 앞 1,000자만 넣고 "생략됨, 필요하면 도구로 다시" 표시를 붙인다(2026-09-15). 그 턴들의 이미지는 "[image from an earlier message]" 글로 바꾼다. 도구 호출과 인자, 대화 글은 그대로다.
  - 이유: 기록 대부분이 도구 출력이다(이 기기의 가장 큰 대화 49,501자 중 96%). 파일 읽기(한 번 최대 16,000자)가 쌓이면 run마다 수십만 자를 다시 넣게 된다. 원문은 노드와 대화 화면에 그대로 남는다.
- codex 자체 샌드박스는 `read-only`, 승인은 `never`로 둔다. 그러나 codex가 모델에 넣는 권한 안내(`include_permissions_instructions`)와 환경 문맥(`include_environment_context`)은 끈다(2026-09-15). 두 문구가 "샌드박스는 읽기만 허용, 명령은 거절"과 codex 프로세스 폴더를 알려서, `auto` 모드에서도 모델이 파일을 바꿀 수 없다고 판단했기 때문이다. 앱 도구는 호스트에서 프로젝트의 권한 모드대로 실행되고, 그 규칙과 날짜, 시간대, run_shell 셸은 앱 안내문(`workspaceInstructions`)이 알려 준다.

### Anthropic 구독 모델 카탈로그 (2026-09-21)

- Anthropic 구독 OAuth 토큰으로 `/v1/models`를 호출하면 모델 추론 권한이 있어도 403이 반환된다. 모델 선택 UI는 이 API를 entitlement 근거로 사용하지 않는다.
- Claude 모델 목록은 앱이 이미 설치한 `@tanstack/ai-anthropic`의 `ANTHROPIC_MODELS` 메타데이터에서 만든다. 실제 계정 entitlement는 실행 요청의 provider 응답으로 검증하며, OpenAI 구독 모델은 기존 원격 카탈로그를 유지한다.
- 이 결정은 개발 서버 시작과 모델 선택 시 불필요한 403, 토큰 갱신, 재시도 왕복을 제거한다.
- 수정(2026-10-13): 구독 요청이 밝히는 Claude Code 버전(`User-Agent`, billing header의 `cc_version`)은 `claudeCodeVersion` 한 곳에서 관리한다. 모델마다 최소 Claude Code 버전이 있어(Opus 5.5는 2.1.280), 옛 버전을 밝히면 새 모델만 실패한다. 새 모델을 목록에 받을 때 이 값을 현재 Claude Code 릴리스로 올린다.
- 수정(2026-10-13): Opus 5.5와 Fable 5.1은 thinking을 끌 수 없다. 이 두 모델의 구독 요청에만 `thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }`와 `thinking-binding-controls-2026-08-01` 베타를 보낸다. `display`가 없으면 빈 thinking이 오고, `block_binding`이 없으면 압축·모델 전환·system/도구 변경 뒤 옛 서명 thinking이 요청 전체를 거절시킨다. 요청 본문 정리 Schema가 모르는 필드를 지워 `output_config`(effort)가 전송되지 않던 문제도 함께 고쳤다.

### Provider 간 대화 전환 (2026-09-21)

- 같은 세션에서 OpenAI와 Anthropic 모델을 바꿀 수 있다. 저장된 대화는 provider 중립 `ModelMessage`를 원본으로 유지하고, 요청 직전에 대상 provider wire format으로 다시 만든다.
- Anthropic 요청은 빈 메시지를 제거하고 같은 역할의 연속 메시지를 한 턴으로 합친다. 특히 OpenAI의 병렬 tool call 뒤에 저장된 여러 tool result는 Anthropic이 요구하는 하나의 바로 다음 user 턴에 모은다.
- 다른 provider의 암호화 reasoning은 대상 provider에 전달하지 않는다. 화면에 보이는 대화와 tool 결과는 유지한다.

### OAuth 로그인 만료 (2026-09-21)

- 로그인 상태를 조회할 때 access token이 30초 안에 만료되면 refresh token으로 먼저 갱신한다. 일시적인 네트워크 오류나 서버 오류는 로그인 정보를 보존하지만, refresh가 400, 401, 403으로 거절되거나 유효한 토큰 응답을 돌려주지 않으면 저장된 로그인을 지우고 `signed-out`으로 바꾼다.
- 화면은 OpenAI와 Anthropic 로그인 상태를 60초마다 다시 확인한다. 앱을 계속 열어 둔 동안 자격 증명이 만료되어도 설정이나 새 요청을 기다리지 않고 상태와 모델 목록을 갱신한다.

### Windows OAuth 자격 증명 저장 (2026-09-26)

- 네이티브 Windows 키링에서 빈 항목이 타입 선언과 달리 `null`로 반환되는 경우도 로그인하지 않은 상태로 처리한다. `null`과 `undefined` 모두 빈 항목이며 저장소 오류가 아니다.
- Windows Credential Manager의 한 항목은 2,560바이트까지 저장할 수 있고, `@napi-rs/keyring`의 비밀번호는 UTF-16으로 저장된다. OpenAI의 access token, refresh token과 ID token을 묶은 JSON이 이 한도를 넘으므로 Windows에서는 base64로 인코딩한 값을 1,280자씩 OS 저장소의 별도 항목으로 나눈다.
- 모든 조각을 쓴 뒤 기존 `subscription-oauth` 항목에 세대 ID, 조각 수와 무결성 해시를 게시한다. 갱신 실패 시 기존 로그인은 유지하고, 갱신 성공과 로그아웃 시 이전 조각을 지운다. 기존 단일 JSON 항목도 그대로 읽는다. macOS와 Linux의 저장 형식은 유지하며 토큰을 파일에 저장하지 않는다.

### OAuth 콜백 연결 종료 (2026-09-30)

- 한 번만 사용하는 로컬 OAuth 콜백 응답에는 `Connection: close`를 보낸다. 응답 후 서버를 닫을 때 브라우저의 유휴 keep-alive 연결을 기다리지 않아 로그인 완료와 오류 보고가 지연되지 않는다.

### 로그아웃 후 OAuth 재로그인 (2026-10-02)

- 제공자 로그인 버튼은 기존 계정 삭제 여부와 관계없이 새 키체인 슬롯에서 인증을 시작한다. 인증과 자격 증명 확인이 끝난 뒤 계정 메타데이터를 등록하고, 선택된 계정이 없으면 새 계정을 선택한다.
- 이전 계정의 명시적 삭제 기록은 유지해 자동 복원을 막는다. 취소하거나 실패한 로그인은 등록되지 않은 슬롯을 정리하고 실행 가능한 계정으로 노출하지 않는다.

### OAuth 실행과 입력 경계의 타입 검증 (2026-10-02)

- 계정 실행 해제 콜백은 모델 어댑터와 스트리밍 클라이언트의 명시적 계약으로 전달한다. 내부 값을 unknown으로 넓힌 뒤 속성을 탐색하지 않는다.
- OAuth 계정과 워크플로 실행의 DB 조회 결과, 보고서 HTTP 응답, 테스트 워커 IPC 메시지는 Effect Schema로 검증한다. 실패 가능한 계정 작업은 Effect.tryPromise로 오류 채널에 담는다.
- 테마 선택기의 기존 표시를 유지하기 위해 SelectTrigger에 ghost variant를 추가하고 스타일을 UI 컴포넌트에서 관리한다.

### OpenAI 호환 self-hosted 모델 연결 (2026-10-03)

- 사용자가 지정한 지원 범위는 설치된 `@tanstack/ai-openai/compatible` adapter다. 기존 OpenAI·Anthropic 구독 로그인과 분리된 `openai-compatible` provider로 연결한다.
- 첫 구현은 endpoint 하나와 Chat Completions 프로토콜만 사용한다. Responses API, Ollama 네이티브 adapter, 서버별 전용 옵션과 provider-hosted 도구는 포함하지 않는다.
- Base URL, 수동 모델 ID, 서버의 실제 context window와 출력 한도를 설정한다. 모델 목록 조회는 보조 기능이며 `/models`를 제공하지 않는 서버도 수동 모델 등록으로 사용할 수 있어야 한다. API key는 선택 사항이고 OS keychain에만 저장한다.
- 스트리밍과 취소는 기존 에이전트 실행 경계를 재사용한다. function calling을 지원하는 모델은 기존 호스트 도구·MCP·승인 흐름을 사용하고, tool calling을 끄면 도구를 실제 요청에서 제외한다.
- 연결 실패 시 cloud provider로 자동 전환하지 않는다. 로컬 모델 연결은 앱 전체 오프라인 실행을 의미하지 않으며, 별도 MCP·검색·embedding의 외부 통신 정책은 그대로 적용된다.
- adapter 호환 계약을 구현하고 mock 서버로 검증한다. 개별 서버·모델의 호환성은 실제 연결 테스트 전까지 보장하지 않는다.

### OpenAI 호환 연결의 Effect 경계와 수명 (2026-10-04)

- 설정·키체인·HTTP는 Effect 서비스와 tagged error로 합성한다. 단일 fetch의 취소는 `Effect.tryPromise`가 전달한 신호와 `Effect.timeout`으로 처리하며, 별도의 `AbortSignal.timeout` 타이머는 만들지 않는다. 취소와 타임아웃의 mock 회귀를 구분해 확인한다.
- 키체인과 설정 파일은 원자적 단일 저장소가 아니다. 같은 서비스의 동시 갱신·모델 선택과 설정·키 읽기는 한 permit에서 직렬화하고, 시작한 저장 작업은 완료 여부를 확인하기 전 중단하지 않는다. 키 쓰기가 결과 미확정으로 실패하거나 키 기록 뒤 설정 기록에 실패하면 부분 저장으로 보고하며 자동 재실행·임의 rollback은 하지 않는다. 키체인 항목의 새 형식은 서버 URL과 키를 함께 담아 해당 URL에서만 인증에 사용한다(기존 일반 키는 이전 서버에 한해 유지). 키가 있을 때 주소 변경에는 키 교체 또는 명시적 삭제가 필요하다.
- compatible SDK의 동기 adapter 생성·Promise keyring·async iterable 스트림은 상호운용 경계로 남긴다. adapter마다 설정과 키를 고정하고, SDK 요청 취소 신호와 run 종료 `releaseRun`을 결합하여 진행 중 네트워크 요청을 중단한다. 중앙 owner·승인·run 보호 로직은 변경하지 않는다.
- 설정 API의 JSON Promise는 React Router 바깥 경계에서 Effect로 변환하고 안전한 HTTP 오류만 응답한다. React UI에는 Effect를 들이지 않으며 모델 추천은 기존 shadcn 버튼으로 제공하되 직접 입력을 유지한다. 컨텍스트 용량 검사는 휴리스틱이며 실제 tokenizer 계산 또는 모든 로컬 서버 호환성을 보장하지 않는다.

### 모델 연결·vendor·전용 도구 지원의 분리 (2026-10-04)

- `ProviderId`의 기존 문자열은 설정·DB·API의 모델 연결 식별자로 유지한다. `openai-compatible`은 회사 이름이 아니라 endpoint 연결 방식이다. 회사와 native tool schema namespace는 `ProviderVendor`로 표현한다.
- 문자열 집합의 부분집합만으로 인증·도구 지원을 추론하지 않는다. `ProviderConnection`의 `subscription / compatible-endpoint` 태그로 연결 종류를 구분하고, 구독 연결만 `accountProvider`를 갖는다. `NativeToolSupport`의 `vendor-native / unsupported`는 별도로 표현한다.
- runtime은 연결 종류로, native route 생성은 전용 도구 지원 태그로 `switch` 분기한다. 호환 프로토콜이 OpenAI라고 해서 OpenAI OAuth 계정이나 native tool 지원을 부여하지 않는다. `SubscriptionProviderId`·`NativeToolProviderId`는 제거하고 account·tool vendor 이름을 사용한다.
- 공통 chat route와 이미지 승인 initiator는 전체 연결 ID 범위를 사용한다. 호환 chat route는 검증되지 않은 endpoint 설정으로 표시한다. 실제 서버 검증 범위는 [OpenAI 호환 endpoint 검토](openai-compatible.md)에 기록한다.

### 호환 모델 추론 출력과 강도 선택 (2026-10-04)

- 호환 Chat Completions 어댑터가 제공하는 `reasoning_content`·`reasoning` 스트림은 SDK의 `thinking` 항목으로 표시한다. 추론은 기본으로 접고, 진행 중인 추론과 완료된 추론을 구분한다. 최종 답변이나 도구 결과로 취급하지 않는다.
- 강도를 endpoint 전체의 수동 체크박스로 지정하지 않는다. 모델 목록 조회 시 같은 서버의 LM Studio `/api/v1/models` 공개 정보에서 선택 모델의 `capabilities.reasoning.allowed_options`·`default`를 확인한다. 고정된 세 레벨 대신 모델별 공개 옵션을 Chat Completions 계약에 맞춰 제공한다. 실제 LM Studio에서 `off` 전송은 400이고 `none`으로 변환해야 함을 확인했다. `on`은 정확한 강도를 지정하지 않으므로 제외한다.
- 조회 결과는 endpoint 설정 안에 모델 ID·출처와 함께 저장한다. 선택 모델과 ID가 맞는 정보만 사용하고, endpoint·모델 변경 시 다시 조회한다. 인증 키는 같은 서버로만 전달하며 metadata 조회 실패·미지원은 일반 `/v1/models` 결과를 막지 않는다.
- `default`는 서버 기본값을 뜻하며 `reasoning_effort`를 보내지 않는다. 공개된 다른 옵션을 선택할 때만 그 값을 전송한다. 기존 `none` 선택은 알려진 지원 정보가 없으면 서버 기본값으로 처리한다. metadata를 공개하지 않는 vLLM·일반 호환 서버의 강도는 이름으로 추측하지 않는다.

### 호환 모델 metadata 탐지 순서 (2026-10-04)

- OpenAI 호환 프로토콜과 서버 구현을 구분한다. 표준 `/models`는 서버 식별·추론 강도 열거를 보장하지 않는다. `owned_by`는 모델 소유자이며 `organization_owner`를 LM Studio 식별자로 사용하지 않는다.
- 먼저 `/models` 응답의 명시적인 확장을 읽는다. 지원하는 확장 계약은 `capabilities.reasoning.allowed_options`와 선택적인 `default`이며, Chat Completions의 알려진 wire 값을 그대로 제공한다. 이 계약은 OpenAI 표준 필드라는 의미가 아니다. `supported_parameters`에 추론이 있으면 지원 여부만 반영하고 레벨은 추측하지 않는다.
- 별도의 `compatible-model-discovery` 모듈이 서버 확장 탐지를 담당한다. vLLM의 `owned_by: vllm` 힌트나 OpenRouter의 공식 host, 이미 공개된 모델별 지원 정보가 있으면 LM Studio 경로를 조회하지 않는다. 알 수 없는 `/v1` 서버는 같은 서버의 `/api/v1/models`를 2초 제한으로 읽고 LM Studio 응답 계약을 확인한 경우에만 해당 변환을 적용한다. 힌트와 응답 계약은 인증·서버 신뢰의 근거로 사용하지 않는다.
- 알 수 없는 확장·응답 형식·조회 실패는 모델 목록을 막지 않는다. 조회 중 endpoint·모델이 바뀌면 이전 응답을 새 설정에 적용하지 않는다. 새 서버 구현 지원은 탐지 모듈에 해당 서버의 공개 계약을 추가하는 방식으로 확장한다.

### 호환 서버 전용 fallback 제거 (2026-10-04)

- 앞선 자동 서버 탐지 결정을 대체한다. LM Studio `/api/v1/models` fallback과 URL·`owned_by` 기반 서버 분기를 제거한다. 모델 목록의 공개 확장만 읽고, 정보가 없으면 서버 기본값을 유지한다.
- 추론 출력과 추론 강도 제어는 별개다. 공개된 강도 목록이 없으면 `reasoning_effort`를 보내지 않고 강도 선택기를 숨긴다. 서버의 추론 스트림은 강도 정보 없이도 표시·저장·복원한다. 지원 파라미터 이름만으로 레벨을 생성하지 않는다.
- 이전 `lm-studio` 출처 캐시는 설정 파일을 읽을 수 있도록 schema에서 허용하지만 런타임의 지원 강도·지원 여부에는 반영하지 않는다. 다음 모델 목록 조회 성공 시 현재 공개 정보로 교체하거나 제거한다. endpoint 설정이나 사용자 채팅 데이터의 별도 마이그레이션은 하지 않는다.

### 채팅 실행의 공급자별 모델 선택 정규화 (2026-10-04)

- `ActiveProvider.selected`는 글로벌 설정의 provider만 읽고 해당 공급자의 `models.selected`를 사용한다. UI 모델 목록과 실제 채팅이 같은 정규화된 모델·강도 선택을 사용하며, 다른 provider로 우회하지 않는다.
- 호환 모델의 지원 정보가 없는데 이전 `low` 등이 설정에 남아 있으면 공급자 계약에 따라 `default`로 실행한다. 명시적으로 지원되지 않는 강도를 새로 선택하는 요청과 잘못된 모델·provider는 계속 거절한다.

### 호환 모델 템플릿 오류의 요청 구성 진단 (2026-10-04)

- `No user query found in messages` 오류에는 실제 HTTP 요청의 메시지 총수·user/assistant/tool 수와 첫·마지막 역할을 덧붙인다. SDK의 `RUN_ERROR` 이벤트와 예외 양쪽에서 원래 오류를 보존하며, 본문·모델 지침·도구 인수·인증 정보를 진단에 추가하지 않는다.
- 저장 이력에 사용자 메시지가 있다는 사실만으로 실패 요청에도 질문이 있었다고 단정하지 않는다. 모델 템플릿을 자동 교체하거나 가짜 사용자 질문을 삽입하지 않는다. 실패 요청의 구성을 확인한 뒤 해당 경계를 수정한다.
- 역할 개수만으로 서버의 질문 판별 결과를 추정하지 않는다. 추가 진단에는 실행에 고정된 모델 ID, 전송한 도구 정의 개수, 사용자 content의 문자열 길이 또는 parts 개수와 `<tool_response>` 전체 감싸기 여부를 포함한다. 본문은 여전히 기록하지 않는다. 이 감싸기 정보는 Qwen 계열 템플릿을 조사하기 위한 관찰값이며 호환 프로토콜 전체의 사용자 질문 규칙으로 적용하지 않는다.

### 모델 전환 시 근거 기반 인계 (2026-10-05)

- 공급자·모델 또는 호환 서버 endpoint가 바뀌면 이전 모델의 전체 대화·reasoning·도구 프로토콜을 재전송하지 않는다. 검증된 기존 요약 최대 3,000자와 최근 근거 최대 20개·4,000자, 실제 마지막 사용자 요청과 전환 후 이력을 모델에 보낸다. 근거 발췌는 항목당 최대 180자이며 완전한 원문이나 실행 증명이 아님을 명시한다.
- 기존 skills와 `find_memory`·`read_evidence`로 현재 작업에 필요한 내용만 조회하도록 안내한다. 현재 Goal/Plan·권한·도구 목록은 기존 런타임이 제공하며, 인계 요약을 승인이나 새 사용자 지시로 사용하지 않는다. 실제 사용자 질문이 없는 이력에는 질문을 만들어 넣지 않는다.
- TanStack AI의 canonical `messages`와 persistence를 유지하고 `onConfig`의 `providerMessages`로 전송 이력만 조정한다. worker 실행도 owner middleware가 만든 `providerMessages`를 사용한다. 전환 경계와 인계 문맥은 기존 SDK MetadataStore에 저장해 실패·재시작 후에도 같은 전환을 유지한다. endpoint 식별에는 URL의 해시를 사용하며 인증 키는 저장하지 않는다.
- 전환 전 결과가 없는 호출은 SDK `resumeToolState.cancelledToolCallIds`로 자동 재실행을 막는다. 현재 실행에 명시적인 승인 응답이 있는 호출은 SDK 승인 흐름을 따른다. 새 실행에서 완료한 호출·결과는 정상적으로 전달하며, 취소는 과거 호출의 실행 여부를 증명하지 않으므로 작업 반복 전 근거를 확인한다.
- 원본 채팅·기억 evidence는 삭제하지 않는다. 사용자 DB에 별도 마이그레이션을 적용하지 않으며 다음 실행에서 전환 상태를 기록한다. 기존 이력에 endpoint 식별 상태가 없는 경우 같은 모델 이름의 과거 endpoint 변경은 추측하지 않는다.
- 수정(2026-10-14): 첫 항목의 3,000자 요약과 근거 20개 발췌를 없앴다. 전환 경계 이전 대화는 버리지 않고 공급자 중립 형태로 보낸다. 사용자 턴은 그대로, assistant 턴은 글만 남기고 reasoning은 뺀다. 이전 도구 호출은 기록된 결과 노드를 가리키는 한 줄 포인터가 되고, 결과가 없는 호출은 실행 여부를 모른다고 적는다. 전환 후 결과가 들어온 호출만 실제 호출로 짝을 맞춘다. 사용자 턴 위치가 그대로라 일반 compact(검증된 요약 블록, 답한 도구 출력 포인터, `leaveOutAt` 초과 시 오래된 것부터 빼기)가 다른 대화와 똑같이 적용된다. 별도 축약 경로가 있으면 전환 직전 몇 턴이 180자 발췌로만 남아 맥락 손실이 컸고, 크기와 무관하게 같은 규칙으로 줄이는 compact 원칙과도 어긋났다. 이전에 저장된 `context`는 읽기만 허용하고 보내지 않는다.

### 모델 인계 경계의 메시지 식별 (2026-10-05)

- 모델 전환 경계는 메시지 ID로 찾고, JSON 객체 필드 순서에 영향받지 않는 해시로 내용을 검증한다. UI 복원 과정의 도구 메시지 분리나 빈 사용자 메시지 제거로 배열 위치가 바뀌어도 동일한 경계를 유지한다. ID가 없는 메시지는 기존 위치 검사를 사용한다.
- 기존 경계는 저장 이력에서 이전 해시가 일치하는 메시지를 확인한 경우에만 새 형식으로 기록한다. 경계가 없거나 내용이 달라졌으면 계속 실패하며, 과거 도구 실행을 임의로 재생하거나 대화를 삭제하지 않는다.

### OpenAI 호환 응답 진단 (2026-10-06)

> 대체됨: "OpenAI 호환 응답 원본 기록 제거"(2026-10-12)에서 이 기록을 없앴다.

- OpenAI 호환 채팅의 HTTP 응답 본문을 SDK가 읽는 순서대로 `diagnostics/openai-compatible`에 기록한다. `.raw`는 파싱 전 응답 바이트, `.jsonl`은 세션·실행 ID, adapter별 요청 순번, 헤더 수신 시간, 청크별 바이트 수와 완료·취소·실패 단계다. 헤더 이전 실패와 본문 스트림 실패를 구분한다.
- 사용자 요청에 따라 원본 응답을 로컬에 저장하며 요청 본문과 인증 헤더는 저장하지 않는다. 응답 헤더는 content type·길이와 요청 추적 ID 등 허용 목록만 기록한다. 파일 권한은 0600, 폴더 권한은 0700이다. 원본은 요청당 32 MiB까지 저장하고 초과 여부와 전체 수신 크기를 기록한다.
- 응답을 복제하거나 백그라운드에서 읽지 않는다. 소비자 취소를 원본 스트림으로 전달하고, 진단 파일 쓰기 실패는 로그로 알리되 원래 HTTP 결과와 오류를 유지한다. 이전 실패의 원본 응답은 소급 복원하지 못한다.

### 대화 Link 전환과 검증 범위 (2026-10-06)

- 일반 대화 목록 이동은 React Router `Link`를 사용한다. URL 인코딩과 브라우저 뒤로/앞으로·modifier 새 탭 동작을 유지하며 root QueryClient·shell·전역 SSE를 문서 이동으로 다시 만들지 않는다. `preventScrollReset`으로 공통 shell의 스크롤 초기화를 막는다.
- 같은 페이지에서 같은 세션의 lease claim/release는 요청 완료 순서대로 직렬화한다. 빠른 A→B→A 재진입에서 이전 cleanup release가 새 claim 뒤에 적용되지 않게 하며, 다른 세션 요청은 병렬로 진행한다. 실패한 요청의 결과는 호출자에게 전달하고 다음 요청의 진행을 막지 않는다. pagehide beacon 정책은 유지한다.
- 브라우저 전환 회귀 검증은 로그인·모델·history·lease를 브라우저에서만 대체하고 서버 변경과 메시지 전송을 차단한다. fixture UI 격리 검증과 실제 서버·모델 실행 검증을 구분하며 document reload 제거만으로 history 저장소 처리·hydration·API 지연 개선을 완료했다고 보고하지 않는다.

### Catalog 공유와 공개 reasoning 스트림 안전 계약 (2026-10-07)

- 동일 identity의 catalog 조회는 공유하며 성공 캐시와 실패 재시도·owner/waiter 취소를 구분한다. 합성 upstream 비교를 실제 HTTP endpoint나 UI blocking 개선으로 보고하지 않는다.
- 공개 summary의 text/part/ID 상태에 명시적인 상한을 적용하고 초과·중복·충돌·불완전 종료는 typed failure로 처리한다. 원본 transcript를 성공한 것처럼 자르거나 암호화 추론을 공개 내용으로 복호화하지 않는다.
- 미완료 native tool/reasoning block에서 정상 RUN_FINISHED를 만들지 않으며 취소는 실패 본문이나 정상 완료로 바꾸지 않는다. 공급자 오류 본문 대신 안전한 코드·reason을 유지한다.
- 실제 SDK chat→withPersistence→reconstructChat 통합 fixture로 공개 thinking/text 복원과 opaque reasoning 비노출을 검증한다. fixture는 메모리 저장소이며 운영 SQLite·실제 provider 증상 재현과 구분한다.
- 병행 소스 리팩토링을 보존하고 현재 회귀 결과와 역사적 결과를 나눈다. 측정 범위와 잔여 조건은 `docs/performance-api-streaming.md`에 기록한다.

### 호환 공급자 설정 응답의 공유 스키마 (2026-10-07)

- 브라우저의 호환 공급자 설정 요청은 서버와 동일한 설정·상태 스키마를 사용한다. 순수 스키마만 노출하는 `memory-agent/compatible-config` 경로로 연결하며 응답과 변경 요청을 경계에서 검증한다.
- 부분 저장 가능성이 있는 409 응답은 `PartialWrite`로 구분하고 기존 새로고침 안내를 유지한다. 실패 응답의 비공개 본문은 읽거나 표시하지 않으며 요청과 응답 소비는 같은 Effect Scope에서 취소한다.

### OpenAI 공개 reasoning summary 스트림 (2026-10-07)

- OpenAI의 공개 reasoning summary 시작·증분·종료 이벤트는 summary part별 SDK reasoning 메시지로 전달한다. 종료 이벤트의 전체 텍스트는 이미 전달한 증분을 중복 출력하지 않는다.
- 공개 summary와 암호화 reasoning의 식별자를 분리하고, 암호화 reasoning을 다음 공급자 요청에 전달하는 기존 계약은 유지한다. summary 이벤트를 Anthropic content block 종료로 해석하지 않는다.

### 보조 모델 호출의 취소와 시간 제한 (2026-10-07)

- 권한 분류와 턴 요약의 모델 호출은 Effect가 시간 제한과 취소를 소유한다. AbortController를 요구하는 SDK에는 호출 Fiber의 신호를 연결하고, SDK rejection과 동기 예외를 typed error로 변환한다.
- 권한 분류의 60초 제한은 provider 준비를 포함한다. timeout과 요청 실패, 예상하지 못한 결함은 사용자 확인으로 돌아가며, Fiber interruption은 전파한다. 턴 요약의 백그라운드 작업은 서비스 Scope 종료 시 취소한다.
- 보조 호출의 UUID는 Crypto 서비스를 사용하고 기본 Node Layer는 NodeCrypto로 제공한다. RouteCatalog의 기본 시각은 런타임 Clock을 사용하고 snapshot 갱신은 Ref의 원자적 변경으로 기록한다.

### codex 런타임 제거 (2026-10-12 기록)

- codex app-server(JSON-RPC over stdio)와 번들 codex 런타임은 2026-09-19 커밋 `ca4a525`에서 제거했고, 구독 OAuth로 공급자 API를 직접 부르는 subscription provider runtime(`f3a2120`)이 대신한다. 이 결정을 늦게 기록한다.
- 앱은 codex를 받거나 실행하지 않는다. codex 다운로드·재시도, `CODEX_HOME`, `turn/steer`, `codexAgentLoop`, codex 샌드박스와 skill 설정에 관한 앞의 결정은 역사 기록이며 현재 동작의 근거로 쓰지 않는다.
- 코드에 남은 `codex` 이름은 Codex CLI 대화 가져오기(`imports/codex.ts`), 자격 증명 거부 경로 `.codex`, ChatGPT 구독 API의 공식 경로·originator 값, 외부 ACP 에이전트(codex-acp) 같은 런타임과 무관한 용도다.

### OAuth refresh 거절의 로그아웃 범위 (2026-10-12)

- 앞의 "OAuth 로그인 만료"(2026-09-21)에서 refresh가 400·401·403이거나 응답을 읽지 못하면 로그인을 지우던 규칙을 좁힌다. 저장된 로그인은 refresh가 401이거나, 400이면서 OAuth 오류 코드가 `invalid_grant`일 때만 지운다.
  - 403은 edge proxy·지역 차단·속도 제한도 돌려주는 상태이고, 다른 400은 우리 요청의 결함일 수 있으며, 읽지 못한 성공 응답은 저장된 토큰에 대해 아무것도 알려 주지 않는다. 이 경우 로그인을 보존하고 상태 조회는 실패로 알린다.
- refresh는 잠금 안에서 저장소를 다시 읽는다. 기다리는 동안 다른 refresh가 토큰을 바꿨으면 새 자격 증명을 그대로 쓰고, 그사이 로그아웃됐으면 `not_connected`로 끝낸다. refresh token은 회전하므로, 이전 토큰으로 다시 refresh하면 거절되어 방금 받은 새 로그인을 지우거나 로그아웃한 계정을 되살릴 수 있었다.

### OpenAI 호환 응답 원본 기록 제거 (2026-10-12)

- 2026-10-06에 넣은 `diagnostics/openai-compatible` 응답 원본(`.raw`)·청크 기록(`.jsonl`)을 없앤다. 항상 켜져 있어 호환 모델을 쓸수록 디스크가 늘고 비밀 가리기를 거치지 않은 모델 출력이 대화 DB 밖에 남았지만, 조사 이후 쓰이지 않았다.
- 템플릿 오류(`No user query found in messages`)에 요청 구성을 덧붙이는 진단(2026-10-04)은 본문을 저장하지 않으므로 유지한다. 이미 만들어진 진단 파일은 앱이 지우지 않는다.

### 계정별 구독 쿼터 상태 (2026-10-12)

- 계정별 구독 쿼터는 `GET /api/accounts/quota?provider=`가 `observed`·`stale`·`unavailable` 상태의 서로소 유니온으로 돌려준다. 공급자별 경로는 `subscriptionQuotaRoutes` 정적 표가 정한다. 허용·검증된 경로가 없으므로 OpenAI는 `no_permitted_route`, Anthropic은 `provider_policy_restricted`로 조회 불가를 명시하고 내부 사용량 엔드포인트(`/wham/usage`, `/api/oauth/usage`)는 호출하지 않는다. 로컬 토큰·응답 수로 대신하지 않는다. V1 실계정 검증과 비공식 경로 채택은 사용자 결정 전까지 하지 않는다.
- V1(2026-10-12, 사용자 승인): 앱 코드(`anthropicSubscriptionUsageProbe`, `eval/anthropic-usage-probe.ts`)로 앱 DB를 읽기 전용으로 열어 유일한 Anthropic 프로필을 고르고 `/api/oauth/usage`에 1회 요청했다. `Database.layer`는 열 때 항상 migration 트랜잭션을 시작해 읽기 전용으로 열 수 없으므로, 기존 eval과 같은 `readOnly` `DatabaseSync` + `listOAuthProfiles` 경로를 쓴다. 응답은 200이었지만 증거일 뿐이며 `SubscriptionQuota`는 사용자가 채택을 결정하기 전까지 `unavailable`을 유지한다. 결과는 [subscription-quota-research.md](subscription-quota-research.md)에 있다.
- M5 채택(2026-10-12, 사용자 결정): Anthropic 계정 쿼터는 `/api/oauth/usage`의 `five_hour`·`seven_day` `utilization`과 `resets_at`을 `observed`로 보여 준다. 소비자 로그인 자격 증명의 제3자 사용을 제한하는 약관 위험은 사용자가 감수했다. `subscriptionQuotaRoutes` 표와 `provider_policy_restricted`는 없앴고, OpenAI는 계속 `no_permitted_route`다.
- OpenAI 채택(2026-10-12, 사용자 결정): OpenAI 계정 쿼터는 Codex가 쓰는 ChatGPT 백엔드 `/wham/usage`의 `rate_limit.primary_window`·`secondary_window`(`used_percent`, `limit_window_seconds`, `reset_at`)를 `observed`로 보여 준다. Codex 경로는 OpenAI에만 쓰고 Anthropic은 `/api/oauth/usage`를 그대로 둔다. 만료된 토큰은 갱신하지 않고 재시도하지 않는다. `no_permitted_route`는 없앴다.
  - 조회는 저장된 access token만 쓰고 refresh하지 않는다. refresh token이 회전하므로 모델 요청의 refresh와 겹치면 로그인이 깨질 수 있다. 만료됐으면 요청 없이 실패한다.
  - 계정별 조회는 `Cache`로 1분에 한 번까지만 보내고 동시 조회는 2개로 제한한다. 실패하면 마지막 관측값을 `stale`로 돌려주고, 관측값이 없으면 `credential_expired`·`lookup_failed`로 조회 불가를 명시한다.

### 공급자 전환과 상태 조회의 대기 경계 (2026-10-15)

- 계정·모델 선택 API의 성공은 기다리되, usage·auth·다른 공급자 모델 목록 갱신은 React Query가 별도로 관리한다. 조회 실패는 해당 query에 남으며 계정 저장 실패와 혼동하지 않는다.
- 계정을 바꾸면 이전 계정의 진행 중 모델 조회를 취소하고 새 계정의 목록으로 기본 모델을 선택한다. 모델 저장 성공 응답을 모든 공급자 query의 선택 상태에 반영한 뒤 목록을 갱신하여 늦은 이전 응답이 선택을 되돌리지 않게 한다.
- 전환 중에는 계정 메뉴에서 중복 전환을 막는다. usage 조회의 인증·캐시·실패 계약은 유지한다.

## 대화·실행·기록

### 대화 상태 (2026-09-14)

- 새로고침이나 탭 닫기 뒤 복원은 서버가 권위를 갖는다. TanStack AI의 `@tanstack/ai-persistence`(`withPersistence` + `reconstructChat`)를 쓰고, 저장소는 앱 SQLite에 직접 구현한다.
  - 이유: 승인 대기처럼 클라이언트 메모리에만 있던 상태가 새로고침으로 사라졌다. 브라우저 저장소는 다른 탭, 기기와 어긋나고, TanStack이 run, interrupt 계약과 conformance 테스트를 이미 제공한다.
- TanStack threadId는 세션 id로 고정한다. 한 세션에 대화 하나.
- chat state는 화면 복원용이다. 기억, 근거의 원본은 `nodes`이고, chat state가 없는 세션은 노드에서 대화를 만든다.
- UI가 따로 쓰던 `GET /api/sessions/:session/messages`는 `GET /api/chat` 복원으로 대체해 없앴다.

### 실행 재연결, 취소, 재시작 (2026-09-14)

- run은 HTTP 요청에 묶지 않는다. 새로고침이나 탭 닫기는 run을 멈추지 않고(R10: 재연결은 재실행이 아님), 멈추는 길은 명시적 취소(`POST /api/sessions/:session/cancel`)뿐이다.
  - 모든 chunk를 TanStack delivery durability 로그(`memoryStream`, batch 1)에 먼저 쓰고 보낸다. 새로고침한 페이지는 hydrate가 알려준 진행 중 run에 `joinRun`으로 붙어 처음부터 다시 읽는다.
  - 로그는 프로세스 메모리에 둔다. 앱은 로컬 단일 프로세스이고, 프로세스가 죽으면 codex 턴도 함께 끝나 이어 읽을 대상이 없다.
- 답변이 멈춘 것처럼 보이지 않게, 대화 영역이 run 상태를 직접 보여 준다(2026-09-15). 답변 중 도구와 도구 사이에는 "작업 중…"을 둔다. 페이지가 생성 중이 아닐 때는 run 기록으로 구분해 알린다: 서버에서 아직 답하는 중인데 이 페이지만 끊김(2초마다 확인, "다시 연결"), 승인 요청 없이 중단됨, 도구만 쓰고 답변 글 없이 완료됨, 재시작으로 끊김(기록 상태와 상관없이 오류 코드로), 멈춤, 실패. 입력창 아래 작은 "답변 중" 표시만으로는 다른 기기 사용자가 멈춘 것과 구분하지 못했다.
- 취소는 run 기록에 요청을 남기고(`requestRunCancel`) 같은 프로세스의 run을 `RUN_CANCEL_REASON`으로 abort한다. codex 턴도 `turn/interrupt`한다. 응답은 최대 5초 기다려 실제로 멈췄는지(`stopped`)와 기록 상태를 따로 알려준다(취소 요청과 실제 종료 구분).
  - 승인 대기 중인 run의 취소는 두지 않는다. 그때는 거부로 답한다.
- 한 세션에는 동시에 run 하나만 둔다. 진행 중에 새 요청은 409 `run_in_progress`.
- 서버가 시작할 때 `running`으로 남은 run은 `failed`(`server_restarted`)로 기록한다. 자동으로 다시 실행하지 않고 화면에 알린다. 다시 보낼지는 사용자가 정한다.
- 승인 대기는 재시작 뒤에도 답할 수 있다. 대기 중인 codex 턴은 사라졌으므로 승인 후에는 대화 기록을 넣은 새 codex 스레드로 이어간다.
- 쓰던 답변도 대화에 남긴다: 1초마다 스냅샷, 취소, 실패 시 즉시 저장. 새로고침, 재시작 뒤 화면이 사용자가 이미 본 내용과 같게.

### 세션 소유권 (2026-09-14)

- PRD R03의 "창"은 웹에서 브라우저 탭이다. 탭마다 holder id를 sessionStorage에 두어, 새로고침한 탭은 같은 탭으로 소유권을 유지하고 다른 탭, 창은 다른 holder가 된다.
- 세션을 연 탭은 아무도 쓰지 않으면 소유권(lease)을 얻고, 다른 탭이 쓰고 있으면 읽기 전용으로 연다. 읽기 전용 탭은 3초마다 상태를 확인해 소유 탭의 새 run을 따라 보여준다.
- 소유 탭이 떠나도 읽기 전용 탭은 자동으로 넘겨받지 않는다. "이어서 작업"을 누르면 서버가 다시 확인하고, 아직 다른 탭이 쓰고 있으면 거절해 읽기 전용을 유지한다.
- 서버가 보내기, 승인 답, 취소 요청의 `X-Session-Holder`를 확인해 소유 탭이 아니면 423으로 거절한다. holder 없는 호출(테스트, 스크립트)은 아무도 소유하지 않은 세션에서만 허용한다.
- lease는 서버 메모리에 둔다(90초, 소유 탭이 20초마다 갱신, 탭을 닫으면 beacon으로 바로 해제). 서버 재시작 뒤에는 열려 있던 소유 탭이 다음 갱신에서 다시 얻는다.
- 알려진 한계: 브라우저의 "탭 복제"는 sessionStorage를 복사해 두 탭이 같은 holder가 된다.

#### 자동 인계와 탭 복제 (2026-10-14)

> 위 절의 "읽기 전용 탭은 자동으로 넘겨받지 않는다"와 탭 복제 한계를 대체한다.

- 소유 탭이 떠나거나(beacon 해제) 갱신을 멈춰 lease가 만료되면, 열려 있던 읽기 전용 탭이 바로 넘겨받는다. 여러 탭이 동시에 요청하면 서버가 하나만 승인하고 나머지는 읽기 전용으로 남는다. "이어서 작업"은 아직 다른 탭이 쓰는 중일 때 다시 확인하는 용도로 남긴다.
- 서버는 만료된 lease를 5초마다 정리하고, 정리할 때마다 그 세션에 `run-state` 이벤트를 보낸다. 읽기 전용 탭은 이 이벤트로 빈 세션을 알아챈다. 만료는 해제와 같게 다뤄서, 실행 중이 아니면 스티어링이 아닌 대기 메시지를 `held`로 바꾼다.
- 탭마다 자기 holder 이름으로 Web Locks 잠금을 페이지가 살아 있는 동안 쥔다. 복제된 탭은 원래 탭이 쥔 잠금을 얻지 못하므로 새 holder를 만든다. 새로고침한 탭은 이전 문서의 잠금이 이미 풀려 있어 같은 holder를 유지한다. Web Locks가 없는 환경에서는 전과 같이 동작한다.

### 대기열, 스티어링 (2026-09-14)

- 답변 중에 보낸 메시지는 서버 대기열(`queued_messages`)에 순서대로 둔다. 기본은 다음 도구 호출 경계에서 전달한다: 도구 결과가 돌아올 때 middleware가 codex `turn/steer`로 진행 중인 턴에 넣고, 대화 기록에도 사용자 메시지로 넣는다.
- (2026-10-14 "스티어링 전달 보장"으로 대체) 스티어링은 codex `turn/steer`가 있으므로 제공한다(Ctrl/⌘+Shift+Enter). 바로 턴에 넣고, 대화 기록에는 다음 경계나 run 끝에 넣는다. 지금 넣을 턴이 없으면 거절하고 다른 전달 방식으로 바꾸지 않는다. codex는 스티어링을 쓰고 있던 응답이 끝난 뒤 반영하므로, 화면에는 새 문단으로 이어진다.
- 도구 호출 없이 정상 완료되면 대기 메시지는 소유 탭이 다음 턴으로 보낸다(서버가 몰래 새 run을 시작하지 않는다). 전달 표시는 "전달됨"뿐이며 반영을 보장하지 않는다.
- 전달된 메시지는 곧바로 대기 목록에서 빠지고 대화 안에 보인다(2026-09-17). 저장된 대화가 놓는 자리를 따른다: 바로 전달은 그때 쓰던 답변 앞, 도구 호출 뒤 전달은 그 도구 호출 뒤다. run이 끝나 대화를 다시 읽으면 저장된 메시지로 바뀐다. 스트리밍 중인 TanStack 메시지 목록은 건드리지 않고 화면에서만 끼워 넣는다.
- 편집은 같은 입력창에서 한다. 웹에서는 Ctrl+↑/↓가 macOS Mission Control과 겹쳐 Alt(⌥)+↑/↓로 고른다. 편집 중 Enter는 저장, Esc는 그 메시지 제거이며 실행 취소로 가지 않는다. 편집 중에는 스티어링하지 않는다. 편집 중인 메시지와 그 뒤 메시지는 전달하지 않는다. 저장하지 않은 편집은 draft로 따로 저장한다.
- 취소, 실패 뒤, 소유 탭이 없는 채 run이 끝났을 때, 소유 탭이 떠났을 때, 서버 재시작 뒤에는 대기 메시지를 `held`(확인 필요)로 바꾼다. 사용자가 "보내기"로 확인하기 전에는 보내지 않는다.
- 도구 경계, 스티어링으로 전달된 메시지는 run이 끝나면 페이지가 서버 대화를 다시 받아 맞춘다. 페이지가 모르는 메시지가 빠진 채 다음 요청을 보내면 서버 기록을 덮어쓰기 때문이다.
- 대기 메시지의 이미지는 넣을 때 그대로 보내고, 편집은 글만 바꾼다.

#### 스티어링 전달 보장 (2026-10-14)

> 위 절의 `turn/steer` 스티어링은 codex 런타임을 제거한 뒤로 모든 런타임이 거절해서 Ctrl/⌘+Shift+Enter가 항상 409였다. 아래로 대체한다.

- 스티어링(Ctrl/⌘+Shift+Enter)은 지금 쓰고 있는 답변에 끼어든다. 받고 있던 모델 응답을 그 자리에서 끊고(이미 받은 글은 남긴다), 실행을 완료로 마친 뒤 서버가 곧바로 그 메시지를 다음 턴으로 보낸다. 페이지를 닫아도 전달된다. 끊긴 응답에 쓴 토큰은 버리며, 정확성을 비용보다 앞에 둔다.
- 응답이 도구 호출을 시작했거나 도구가 실행 중이면 끊지 않는다. 그 도구가 끝나는 경계에서 대기 메시지와 똑같이 모델이 막 받을 요청에 들어간다. 셸 같은 도구를 중간에 죽이면 부작용이 남기 때문이다.
- Goal worker 실행은 끊지 않는다. 일찍 멈추면 Goal 단계가 끝난 것으로 처리되기 때문이다. 이때도 경계나 답변 끝에서 서버가 보낸다.
- 끊긴 추론은 암호화 값이 없어서 다음 요청에 다시 보내지 않는다.
- 순서는 그대로다. 스티어링하면 앞에서 기다리던 대기 메시지도 함께 스티어링 상태가 된다. 서버는 한 턴에 한 메시지씩 보낸다.
- 취소, 실패, 서버 재시작 뒤, 서버가 다음 턴을 시작하지 못했을 때는 다른 대기 메시지처럼 `held`로 바꾼다(R03). 편집하면 스티어링 상태가 풀리고 일반 대기 메시지가 된다. 페이지가 떠난 것만으로는 스티어링 메시지를 `held`로 바꾸지 않는다.
- 일반 대기 메시지(Enter)는 끊지 않고 다음 도구 호출 경계에서 들어가며, 그 전에 답변이 끝나면 지금처럼 세션을 가진 페이지가 보낸다. 대기열 스냅샷의 `nextDelivery`가 `server`이면 페이지는 보내지 않는다.
- "전달됨"은 이제 모델이 받은 요청에 그 메시지가 들어갔다는 뜻이다. 모델이 그에 맞게 행동했다는 보장은 아니다.
- 런타임 계약의 `steer`, 서브에이전트의 진행 중 턴 스티어링 분기, 스티어링 메시지를 나중에 대화 기록에 넣던 경로는 모두 쓰이지 않아 지웠다. 예전 행의 `delivered_via = 'steer'`는 읽기 위해 남긴다.

### 대화 보관 (2026-09-15)

- 대화 목록에서 대화를 뺄 수 있다. 첫 단계는 보관이다. 목록(`GET /api/sessions`)에서만 빠지고, 메시지, 기억 노드, 검색, 근거 추적, 정정 edge는 그대로 남는다. 보관함에서 복원하면 목록으로 돌아온다.
  - 완전 삭제(노드, 벡터, FTS, 형태소, edge, 해석, 대화 상태, 안 쓰는 첨부까지)는 다른 대화의 정정 edge와 공유 주제 노드를 어떻게 정리할지 정한 뒤 따로 만든다.
- 답변 중인 대화(409)와 다른 탭이 쓰고 있는 대화(423)는 보관과 복원하지 않는다. 쓰는 사람 모르게 목록에서 사라지지 않게 하기 위해서다.
- 보관한 대화는 목록에서 고를 수 없고, 복원한 뒤 연다. 외부에서 id로 여는 경로(ACP `session/load`)는 막지 않는다.
- 사이드바: 대화 행에 마우스를 올리면 보관 버튼이 보이고, 목록 아래 "보관함 N"을 펼쳐 복원한다. 프로젝트 추가는 설정과 헷갈리지 않게 프로젝트 선택 옆 버튼 → 대화상자로 옮기고, 현재 프로젝트 설정(권한 모드, 다른 프로젝트에서 기억 찾기)은 "<프로젝트> 설정"으로 묶는다.

### 긴 대화 줄이기 (2026-09-17)

> 일부 대체됨: 25% 기준은 "일반 compact 최소 진입 제한 정리"(2026-09-25)에서 없앴다. 도구 결과 포인터와 요약 블록의 현재 규칙은 "요청 구성, compact와 프롬프트 캐시"(2026-09-21)를 따른다.

- 모델에 보내는 대화는 그 모델의 컨텍스트에 대한 비율로 줄인다. 기준은 대화(추정)가 25%를 넘을 때와 55%를 넘을 때 두 가지다.
  - 컨텍스트 크기는 codex가 모델 호출마다 알려 주는 `modelContextWindow`를 모델별로 기억해 쓴다. 이 프로세스에서 아직 호출이 없으면 258,400(272k의 95%, 계정 모델이 모두 같음)으로 본다. `model/list`에는 이 값이 없다.
  - 토큰은 ASCII 4자에 1, 한글과 그 밖의 글자는 1자에 1로 센다. 기본 추정(글자 수 / 4)으로는 한국어 대화가 한참 넘친 뒤에야 줄인다.
- 25%를 넘으면 먼저 이미 답한 도구 출력을 비운다. 도구를 부르지 않은 마지막 assistant 메시지까지의 도구 결과가 대상이고, 진행 중인 run의 도구 결과는 그대로 둔다. 비운 자리에는 그 결과의 노드 id와 read_evidence로 다시 읽으라는 안내만 남긴다.
- 그래도 25%를 넘으면 최근 사용자 턴 4개 앞의 턴을 요약으로 보낸다. 요약이 있는 데까지만 바꾼다.
  - 요약은 run이 끝난 뒤 뒤에서 만든다. 사용자 턴 10개씩 묶어, 선택한 모델을 가장 낮은 추론 강도로 부른다. 대화가 클 때만이 아니라 늘 만들어 두어서, 줄일 때 기다리지 않는다.
  - 한 번 만든 묶음은 바꾸지 않는다. 요약을 매번 새로 쓰면 모델에 보내는 앞부분이 run마다 달라진다.
  - 요약은 저장된 대화가 아니라 세션 노드를 읽고, 각 항목에 근거 노드 id를 붙인다. 모델에는 "근거가 아니라 안내이니 read_evidence로 확인하라"는 머리말과 함께 assistant 메시지로 보낸다.
  - 묶음마다 다음 턴의 사용자 노드를 적어 두고, 대화의 그 턴이 같은 말일 때만 쓴다. 가져온 대화처럼 기록과 맞지 않는 대화에는 요약을 만들지도 쓰지도 않는다.
- 55%를 넘으면 오래된 메시지부터 빼고, 기억에서 find_memory, read_evidence, trace_evidence로 찾으라는 표시를 넣는다.
- 저장하는 대화(화면, 기억)는 줄이지 않는다. 줄이기는 매 모델 호출 전에 저장된 대화에서 다시 계산한다. `@tanstack/ai-compaction`의 체크포인트는 쓰지 않는다. 체크포인트를 이어 쓰면 메시지 위치가 달라져 턴과 요약을 맞출 수 없다. 오래된 메시지 빼기에는 그 패키지의 `evictOldest`를 쓴다.
- `/compact`는 기준과 상관없이 아직 없는 요약을 최근 4턴 앞까지 만들고, 지금까지 답한 도구 출력을 비우고 그 턴들을 요약으로 보낸다. 이후 run에도 그대로 적용한다. 답변 중에는 거절한다(진행 중인 run이 자기 도구 출력을 쓰고 있다). 결과로 비운 도구 출력 수, 요약으로 바꾼 턴 수와 대화의 추정 토큰 변화를 보인다. 요약에 실패해도 도구 출력은 비운다.
  - 이유: 대화 대부분이 도구 출력이고, 원문은 노드로 남아 근거 도구로 다시 읽을 수 있다. 요약도 원문을 가리키기만 하므로 근거 찾기와 함께 쓴다.
- 입력창 아래 상태줄은 이 대화의 마지막 모델 요청이 읽은 토큰(지침과 도구 포함)을 컨텍스트에 대한 비율로 보인다. run 중에는 호출마다 갱신하고(`memory-agent.context` 사용자 정의 이벤트), 60%를 넘으면 경고 색으로 바꾼다. 마우스를 올리면 줄이기 기준과 `/compact`를 알려 준다.

### 요청 구성, compact와 프롬프트 캐시 (2026-09-21)

- 메인 대화는 공통 고정 지침 → 역할 지침 → 스킬·위임 안내와 프로젝트/날짜 문맥 순서로 구성한다. 지침 내용과 권한은 유지하고 지침 자체를 자동 정렬하지 않는다.
- 도구는 이름 순서로 복사 정렬해 등록 순서에 따른 요청 변동을 없앤다. 스키마 내부 순서는 바꾸지 않는다. 지침·메시지·도구 fingerprint에는 원문 대신 SHA-256만 기록한다.
- 완료된 run의 도구 결과는 다음 모델 요청부터 immutable memory node pointer로 바꾼다. 최근 user turns 2개는 원문으로 유지하고, 그 이전은 4턴마다 독립적인 불변 요약 블록으로 단조롭게 누적한다. 새 블록 때문에 이전 요약 메시지를 다시 쓰지 않는다.
- compact가 원문을 생략한 요청에만 현재 질문 기반의 세션 우선 retrieval appendix를 넣는다. 최대 5개·600 estimated tokens이며 최신 user 메시지 바로 앞에 둔다. 결과는 lead일 뿐이므로 답에 쓸 때 `read_evidence`와 `trace_evidence`로 원문과 정정을 확인한다.
- Anthropic 요청은 안정된 system/tool prefix에 ephemeral cache marker를 쓰고, 해당 기능만 거부되면 stream 시작 전에 marker 없이 한 번 재시도한다. ChatGPT Responses는 지원이 확인되지 않은 cache field를 보내지 않고 provider 자동 prefix cache를 사용한다.
- 장기 대화 결정론적 평가에서 현재 기본값은 기존 10턴 결합 요약·최근 4턴 프로파일보다 평균 입력 토큰 39.9% 감소, byte-identical cacheable prefix 2.9%p 증가를 보였다. 대신 summary provider call은 2회에서 6회로 늘었다. 4턴·2턴·600-token 기본값을 유지하고 실제 `cachedTokens`는 운영 context usage로 관측한다. 상세 방법과 재실행 명령은 [긴 대화 compact 평가](./compaction-evaluation.md)에 기록한다.
- 실제 서버 캐시 적중은 provider TTL·라우팅·최소 prefix 길이에 좌우되므로 보장하지 않는다. deterministic 평가는 wire-prefix 안정성을, runtime 지표는 provider가 보고한 `cachedTokens`와 cache ratio를 각각 측정한다.

### 채팅 기록 표시 (2026-09-24)

> 일부 대체됨: `@tanstack/react-virtual` 가상화는 도입 뒤 스트리밍 Markdown(streamdown)과 도구 카드의 높이가 계속 바뀌어 메시지 간격이 어긋나서 제거했다("UI" 절의 2026-09-25 항목). 페이지 크기는 "History pagination의 실제 SDK 저장소 연결"(2026-10-07)에서 20개로 바꿨다.

- 채팅은 서버에 저장된 기록을 처음에 최근 50개만 복원하고, 목록 위쪽으로 스크롤하면 커서로 이전 페이지를 가져온다. 활성 run과 승인 상태는 기록 페이지와 별도로 기존 TanStack AI 복원 계약을 따른다.
- 클라이언트는 `@tanstack/react-virtual`로 화면 근처의 메시지만 렌더링한다. 메시지 높이는 `measureElement`로 측정하고 `anchorTo: "end"`와 안정적인 메시지 ID로 이전 페이지를 앞에 붙여도 보고 있던 위치를 유지한다. `followOnAppend`는 사용자가 아래쪽에 있을 때만 새 응답을 따라 내려간다. 목록 높이와 행 위치는 CSS 변수로 전달한다.
- 첫 진입은 대화 기록이 비동기로 복원되므로 메시지가 들어온 뒤 `scrollToEnd()`를 한 번 호출한다. `initialMeasurementsCache`는 같은 메시지 페이지와 스크롤 오프셋을 함께 복원할 때만 적용할 수 있어 지금은 사용하지 않는다. 이전 페이지의 중복 요청은 TanStack AI 클라이언트가 막고, UI는 실패 여부만 별도 상태로 둔다.
- 채팅 기록의 스크롤·페이지 오류, 승인 batch의 답변 선택, 입력창의 키보드 선택은 각각 해당 컴포넌트가 소유한다. 입력 텍스트는 전송·편집을 결정하는 부모가 controlled 값으로 내려준다. 세션별 미전송 초안만 재시작 뒤에도 남겨야 하므로 기존 `atomWithStorage`에 보관한다. 서버의 이미지 설정은 TanStack Query 캐시에서 읽고, 한 요청의 이미지 생성 진행·결과는 로컬 tagged union으로 표현한다.
- 현재 저장소는 스레드 전체를 JSON 한 행에 저장한다. 페이지 응답 크기와 브라우저 렌더링은 제한하지만 서버가 그 행을 읽는 비용은 남는다. 저장 형식 분할은 실제 조회 측정 뒤에 결정한다.

### 일반 compact 최소 진입 제한 정리 (2026-09-25)

- 위 2026-09-17의 25% 기준 설명은 현행 구현에 더는 적용되지 않는다. 답변이 끝난 도구 출력은 크기에 관계없이 포인터로 전환하고, 검증된 요약 블록은 준비되는 즉시 이전 원문 턴을 대신한다. 최근 2턴은 원문으로 남기며, 55%를 넘는 오래된 메시지 leave-out과 명시적 cache-cold one-shot은 별개로 유지한다.
- 기존 코드의 25% 분기는 이미 검증된 모든 블록의 마지막을 watermark로 먼저 지정한 다음 같은 블록을 거르는 구조였으므로, 준비된 요약의 선택에 영향을 주지 않았다. 분기 제거 자체를 실제 API 토큰 절감으로 주장하지 않는다. 호환 필드 `compactAtTokens`는 0을 보고하며 UI는 더 이상 잘못된 임계값을 안내하지 않는다. 실제 절감은 모든 provider 응답 usage와 요약·재조회 호출을 포함해 별도로 판정한다.

### 저장된 빈 사용자 메시지 정리 (2026-10-04)

- `chat_threads`에서 `role: user`, `content: ""`인 메시지 중 `id`·`role`·`content`·`createdAt`·`metadata` 외의 필드가 없는 항목만 일회성 마이그레이션으로 제거한다. 이미지·parts·첨부·도구 정보나 알 수 없는 payload 필드가 있으면 보존한다. null·배열·공백 content까지 삭제 범위를 확대하지 않는다.
- 남은 메시지의 내용·순서와 thread의 `updated_at`을 보존한다. 불변 기억 evidence와 실패한 run 기록은 수정하지 않는다. 정리 SQL은 반복 적용해도 결과가 같다.
- 실행 중인 구버전 서버의 DB에는 SQLite backup으로 복구본을 만든 뒤 같은 SQL을 트랜잭션으로 직접 적용한다. 새 빌드보다 앞서 DB 버전을 올려 구버전 재시작을 막지 않도록 `user_version`은 유지하며, 새 코드의 다음 시작에서 정규 마이그레이션이 버전을 갱신한다.

### 중단된 과거 도구 호출의 재전송 방지 (2026-10-04)

- 저장된 도구 호출의 `arguments`가 JSON 객체로 해석되지 않으면 다음 모델 요청의 이력에서 해당 호출과 연결된 도구 결과를 제외한다. 중단된 문자열을 `{}`로 바꾸거나 도구를 다시 실행하지 않는다. 같은 메시지의 정상 호출과 본문은 보존한다.
- 이 처리는 기존 이력 compaction 경계에서 수행한다. 저장된 채팅과 기억 evidence는 수정하지 않으며 DB 마이그레이션으로 삭제하지 않는다.
- LM Studio에 같은 짧은 이력을 전송한 대조 실험에서 끊긴 JSON 인수는 HTML HTTP 500, 완성된 JSON 인수는 HTTP 200이었다. 모델 목록 조회나 추론 강도 정보의 부재로 발생한 오류로 분류하지 않는다.

### 빈 사용자 텍스트의 재유입 방지 (2026-10-05)

- 기존 일회성 마이그레이션만으로는 이후 저장된 빈 사용자 메시지를 막지 못한다. `role: user`, `content: ""`이고 id·createdAt·metadata 외의 추가 payload가 없는 메시지는 새 요청에서 거절하고, SQLite 저장과 매 모델 요청의 전송 이력에서도 제외한다.
- 텍스트가 없는 assistant 도구 호출, tool 결과, 이미지·추가 payload가 있는 사용자 메시지는 보존한다. 저장 필터는 TanStack의 전체 이력 교체·메시지 ID·순서 계약을 유지하며, 전송 필터는 canonical 이력과 요약 인덱스를 변경하지 않는다.

### History pagination의 실제 SDK 저장소 연결 (2026-10-07)

- 앱의 `ChatState`는 기존 `Database` 소유자를 받는 `ownedSqliteChatPersistence`로 연결한다. 페이지 요청은 파생 group snapshot을 읽는 `MessagePage`를 반환하고 모델 컨텍스트와 명시적 전체 기록 조회는 원본을 유지한다.
- 원본 upsert와 파생 group 교체는 기존 `Database.atomic`으로 함께 저장한다. UI ID 충돌 때문에 정상 원본 저장을 거부하지 않고 파생 뷰를 not-ready로 유지한다. 다른 SQL 실패는 원본과 파생 뷰를 함께 rollback한다.
- 별도 runtime/SQLite 연결을 만들지 않는다. SDK·동기 SQLite 경계에서만 native 호출을 사용한다. 시작 시 미준비 기록과 실제로 새로 materialize된 import만 명시적으로 backfill하며 일반 초기/과거 페이지의 stale 처리는 전체 JSON fallback으로 바꾸지 않는다.
- SDK의 `pageSize + 1` overscan 및 retained UI ID cursor 교체를 유지한다. legacy 파생 ID는 기존 hydration의 `stored:thread:ordinal`과 맞추고 원본 ID·본문·metadata는 바꾸지 않는다.
- 첫 전달과 과거 페이지는 50개 대신 20개 UI 메시지로 요청한다. 전체 원본과 과거 페이지 접근은 유지한다. 이 응답량 감소를 동일 데이터 조건의 독립 hydration·render 비용 개선으로 계산하지 않는다.
- 실제 SDK 통합 회귀 통과와 전체 목표 완료를 구분한다. 응답 bytes·cold/backfill·writer blocking·릴리즈 전체 migration/opener·UI 비용의 독립 측정은 별도 완료 기준이다.

### History 파생 저장의 증분 갱신과 측정 한계 (2026-10-07)

- 실측에서 발견한 저장 비용 증가를 읽기 개선에 묻어 두지 않는다. SDK가 이미 보유한 typed model snapshot은 원본 직렬화에 쓴 동일 배열을 파생 저장에도 전달해 재파싱을 피한다. startup/import의 외부 JSON 검증·디코딩은 유지한다.
- 파생 group은 ordinal/UI-ID metadata로 이동·tail을 정리한 뒤 동일 JSON은 SQL INSERT 전에 제외하고 변경된 행만 갱신한다. 원본/파생/발행은 기존 transaction 안에 유지한다. full snapshot 직렬화·group 순회 자체는 여전히 수행하므로 O(changed-groups) 알고리즘으로 보고하지 않는다.
- non-STRICT SQLite의 손상된 fractional ordinal이 정상 원본 저장을 막지 않도록 disposable 행을 metadata decode 전에 제거하고 원본에서 복원한다. 조회 중 전체 transcript fallback이나 원본 수정으로 복구하지 않는다.
- 0.0.13의 실제 opener·전체 30 migration으로 만든 임시 DB에서 파생 backfill, 원본과 글로벌 version 보존, projection rollback, 원본 opener 재개방 및 3값 writer를 검증한다. 공유된 현재 Effect 설치본에서의 릴리즈 소스 검증과 출시 binary 실행을 구분한다.

### History pagination의 호환 기준과 UI 경계 (2026-10-07)

- 이번 개선의 릴리즈 하위호환 기준은 사용자가 지정한 `0.0.13`이다. 실험용이며 빌드 실패한 `0.0.14-canary1`은 제외한다. 실제 0.0.13 원본에서 확인한 3컬럼 `chat_threads` 및 writer 계약을 유지하고, 원본 transcript와 모델 컨텍스트를 파생 데이터로 대체하거나 자르지 않는다.
- 저장소 page 단위는 SDK의 UI 변환 경계를 따른다. linked tool result와 assistant segment가 현재 assistant에 병합되므로 raw message 개수만 제한하는 방식은 pagination 완료로 인정하지 않는다. 경계용 `history-groups.ts`를 추가하고 실제 SDK 전체 변환과 각 page split 결과를 대조한다.
- id 없는 legacy 메시지에는 projection에서만 결정적인 thread/index ID를 부여한다. 원본에 ID를 써넣지 않는다. 파생 저장소 연결·동시 쓰기·cursor 및 release backfill/rollback 전체 검증은 helper 테스트와 별개로 수행해야 한다.

### History 파생 저장소 전환 계약 (2026-10-07)

- 원본 `chat_threads`의 컬럼과 글로벌 `user_version`을 바꾸지 않는 disposable projection으로 구현한다. format 버전은 별도 metadata에 둔다. 다른 기능의 migration이나 downgrade를 이 rollback으로 우회하지 않는다.
- projection은 UI group ordinal 및 UI-ID unique index로 조회한다. 최신/과거 page는 해당 group JSON만 읽고, 이전 page 존재 여부는 payload 없는 EXISTS 쿼리로 확인한다.
- reader는 readiness·cursor 유효성·page payload·이전 page 여부를 한 SQLite statement의 동일 snapshot에서 읽는다. 별도 check/read 사이의 쓰기로 상태가 엇갈리지 않도록 한다. 준비되지 않음·알 수 없는 cursor·정상 empty/end page는 payload 없는 state row로 구분하고, adapter 경계에서 검증·처리한다. materialize와 정렬은 요청한 page 범위에만 한정한다.
- reader의 의존성은 Effect Context/Layer로 연결하고 기존 Database 연결을 빌린다. 별도 DB 연결·runtime·백그라운드 작업을 reader에 만들지 않는다. 요청과 DB 행은 Schema로 검증하고 준비 안 됨·알 수 없는 cursor·정상 page를 태그로 구분한다. 저장소 오류나 손상된 행을 빈 기록으로 바꾸지 않으며 오류에는 안전한 단계/reason만 담는다. 선택된 model JSON의 디코딩과 인가는 SDK/HTTP 경계에서 유지한다.
- 이전 릴리즈 writer를 포함해 transcript insert/update가 projection readiness를 무효화하고 delete가 파생 데이터를 정리한다. 준비되지 않은 기록을 page read 중 전체 파싱해 숨겨서 복구하지 않는다. 별도 backfill/준비 경로에서 원본 snapshot과 파생 데이터를 원자적으로 발행하며 오류·충돌을 명시적으로 처리한다.
- backfill은 준비에 사용한 원본 JSON과 현재 원본이 일치할 때만 조건부 발행한다. timestamp만 비교하지 않는다. staging에서 readiness 해제·group 교체·조건부 발행을 한 savepoint에 묶고, 원본 변경/삭제로 발행이 거부되면 staging 전체를 rollback해 더 최신의 ready projection을 보존한다. 원본과 group을 함께 저장하는 modern writer의 무조건 발행 SQL을 backfill에서 재사용하지 않는다.
- 준비된 projection 발행은 기존 Database.atomic을 소유자로 사용한다. 파생 스키마 설치와 발행에 새 transaction manager/DB/runtime를 만들지 않는다. 원본 비교가 거부되면 native 동기 callback 경계에서 typed SourceChanged로 owner rollback을 일으킨 뒤 해당 reason만 명시적인 결과로 회복한다. 다른 SQL 실패는 typed failure로 전파한다. publisher의 JSON-array 검증은 SDK model codec이나 원본/group 동등성 검증을 대체하지 않으므로 검증된 grouping producer에서만 사용한다.
- owner atomic의 COMMIT 실패도 원본 실패와 transaction 상태를 보존해야 한다. outer/nested 구분을 실행 전에 고정하고 depth는 finally에서 한 번만 줄인다. 중첩 callback 실패는 해당 savepoint로 rollback한 뒤 release하여 outer 작업을 보존한다. 지연 FK COMMIT 실패·후속 transaction·중첩 작업 보존을 실제 SQLite로 회귀 검증한다.
- rollback은 projection trigger/table만 제거한다. 운영 adapter 적용 전에 preparation 정책, snapshot consistency, 실제 릴리즈 upgrade/rollback 및 별도 응답량·조회량 검증을 완료해야 한다. 메모리 SQL 테스트만으로 운영 pagination 완료를 주장하지 않는다.

### SDK 실행 Fiber와 응답 연결의 수명 (2026-10-07)

- 채팅의 SDK 스트림 소비와 RRSI 실험 실행은 서비스 Scope에 속한 실제 실행 Fiber가 소유한다. AbortController는 SDK 경계에만 두며, Fiber 중단을 SDK 신호로 전달한 뒤 iterator·평가기 정리를 기다린다.
- HTTP 응답 연결 종료는 실행 취소가 아니다. SDK의 durable producer 계약을 유지하며, 제한된 Queue를 통해 전달한 최종 프레임을 로그에 남겨 재연결할 수 있게 한다. 명시적 취소와 서비스 종료는 실행을 중단한다.
- 워커 실행의 정리 신호와 최종 오류 프레임의 전달 신호를 분리한다. 전달 취소는 실행으로 전파하지만 실행 정리가 전달을 취소하지 않는다. 세션의 실행 점유와 모델 계정은 실제 실행 정리가 끝난 뒤 반납한다.
- RRSI의 이미지 확인·모델·평가기 경계는 주입 가능한 Effect 서비스로 분리하고, 테스트는 모듈 모킹 없이 실제 서비스의 Fiber 수명과 정리 순서를 검증한다.
- 채팅 실행 결과와 실행 점유 추적은 내부에서 Effect Stream으로 합성한다. Stream의 typed error를 유지하고 계정·실행 자원 해제는 `Stream.ensuring`으로 연결한다. SDK SSE 응답을 만드는 지점에서만 AsyncIterable로 변환하며, SDK durable producer의 재연결 계약을 유지한다.

### History projection의 반복 assistant ID (2026-10-08)

- 같은 assistant 그룹에서 반복되는 원본 ID는 projection 뷰에서만 `${assistantId}-segment-history-${modelOrdinal}`로 변환한다. SDK의 segment 합치기를 이용하여 도구 호출·결과·후속 텍스트의 순서와 하나의 UI cursor를 유지한다.
- chat_threads 원본, 모델 컨텍스트와 실시간 스트림 ID는 변경하지 않는다. 명시적 원본 ID가 서로 다른 assistant 그룹이나 사용자 메시지에서 충돌하거나 생성한 segment ID와 명시적 ID가 충돌하면 기존 id-collision 오류를 유지한다.
- ID가 없는 메시지는 기본 `stored:${threadId}:${modelOrdinal}`을 유지하되 명시적 ID와 충돌하면 예약되지 않은 첫 `:fallback:${n}` 접미사를 선택한다. 이미 projection에 발행된 fallback cursor는 재사용하며, 새 명시적 ID가 그 cursor와 충돌하면 cursor를 바꾸거나 서로 다른 답변을 합치지 않고 오류를 유지한다. ID 조회 컬렉션의 키는 문자열 ID와 숫자 ordinal이다.
- 기존 미준비 projection은 수정된 초기화 경로에서 준비한다. 페이지 읽기에 전체 원본 파싱이나 자동 backfill을 추가하지 않는다.
- `stored:` 형식만으로 합성 cursor의 소유자를 판단하지 않는다. assistant에 연결되는 tool 결과는 독립 UI cursor를 갖지 않으므로, 해당 tool의 원본 ordinal을 가리키는 다른 명시적 cursor를 합성 cursor로 재사용하거나 충돌로 거부하지 않는다. 연결된 tool의 fallback은 명시적 ID를 피해서 생성하고 assistant cursor와 toolCallId 연결을 보존한다.

### 직전 답변 run의 도구 결과 유지 (2026-10-12)

- "요청 구성, compact와 프롬프트 캐시"(2026-09-21)에서 완료된 run의 도구 결과를 다음 요청부터 포인터로 바꾸던 규칙을 한 run 늦춘다. 가장 최근에 답한 사용자 턴의 도구 결과는 원문으로 보내고, 그 뒤 run이 답을 마친 다음 요청부터 포인터로 바꾼다.
  - 다음 질문은 대개 방금 run이 읽은 내용에 관한 것이라, 바로 포인터로 바꾸면 모델이 같은 결과를 도구로 다시 읽는 왕복이 생겼다.
  - 바뀌는 시점이 늦어질 뿐 각 도구 결과는 여전히 한 번만 바뀌므로 그 앞의 요청 prefix는 캐시에 남는다. 결과 크기에 따라 원문 유지를 나누지 않는다. 모든 과거 도구 결과에 같은 규칙이 적용돼야 모델이 보는 기록이 일관된다.
- 명시적 `/compact`는 지금처럼 답한 도구 결과를 모두 포인터로 바꾼다.

## Goal·Workflow·Durable 실행

### Work Trace 실행 경계 (2026-09-20)

- TanStack `chat_runs`는 SDK의 run·interrupt·durable-run 계약에 그대로 사용한다. Task의 여러 실행과 재개 계보는 별도 앱 소유 `agent_run_attempts`로 저장하고 `chat_run_id`로 연결한다.
- 연결이 끊겨도 producer가 살아 있으면 같은 run에 다시 붙는다. 서버 재시작 등으로 continuation이 소실되면 원 Task 아래 새 attempt와 child run을 만들어 transcript/checkpoint에서 논리적으로 이어간다. 두 동작을 모두 "resume"으로 숨기지 않는다.
- 완료가 확인된 tool result만 논리적 재개에 재사용한다. 실행 여부가 불명확한 비멱등 tool과 이전 attempt의 pending approval은 자동으로 계속하지 않는다.
- Work Trace는 부모 chat stream과 독립된 session-scoped SSE로 전달한다. SQLite event store를 원본으로 삼고, 기존 SSE offset/rejoin 패턴을 재사용해 프로세스 재시작 뒤에도 replay한다.
- 세부 계약과 구현 불변식은 [Work Trace 런타임 계약](./work-trace-runtime-contract.md)에 기록한다.

### 승인된 Plan의 서버 자동 진행 (2026-10-02)

- Execute의 응답 종료는 Plan 완료와 구분한다. 서버가 미완료 구현과 Verify를 다음 실행으로 이어가며, 브라우저는 검증 턴을 따로 시작하지 않는다. 후속 실행은 이미 승인한 범위 안에서 현재 Goal·Plan 버전과 직전 완료 run을 다시 확인한다. 사용자 발화나 새 승인으로 기록하지 않는다.
- 사용자 결정·권한 대기·외부 의존성·반복 실패는 구체적 이유와 근거를 가진 blocker로 저장하고 화면에 표시한다. 직접 수행할 조사·준비·검토가 남았다는 이유로 멈추지 않는다. 두 턴 연속 새 진행 근거나 완료 단계가 없으면 자동 진행을 중단한다. 중복 근거와 갱신 시각은 진전으로 세지 않는다.
- 사용자 취소·일시 중지·계획 변경·실행 실패·승인 대기는 자동 재실행하지 않는다. 대기 중인 사용자 메시지가 우선한다. 재시작에서는 영속화된 정상 완료 뒤의 후속 실행만 재개하며, 진행 중이거나 결과가 불확실한 run은 재생하지 않는다.
- 검증 실패는 Execute에서 실제로 수정하고 새 근거와 not_run 검증 상태를 기록한 뒤 다시 Verify로 보낸다. 기존 metadata 저장소에 자동 진행 상태를 보관해 별도 DB 마이그레이션은 추가하지 않는다.
- 수정(2026-10-13): 서버 재시작으로 끊긴 Goal run은 다시 켜질 때 정상 종료와 같은 규칙으로 정리한다. durable 실행을 실패로 닫고 자동 진행 상태를 멈춘다. 끊긴 run은 재생하지 않는다.
- 수정(2026-10-13): 도구를 하나도 실행하지 않고 실패·취소된 run은 다음 run을 막지 않는다. 사용자가 이어서 보내면 새 run이 남은 단계부터 진행한다. owner 도구 호출은 실행 전에 장부에 예약되므로 이런 run은 반복될 외부 변경이 없다. middleware·routed persistence는 owner 내부 기록이라 도구 실행으로 세지 않는다. 도구를 실행한 run은 그 도구가 성공했어도 다음 run이 반복할 수 있어 계속 막는다. 이 경우의 사용자 확인 후 계속은 별도로 다룬다.
- 수정(2026-10-13): 도구를 실행한 실패·취소 run도 다음 run이 모르고 반복할 일이 없으면 막지 않는다. 조건은 실행한 도구가 모두 `succeeded`이고, 읽기 전용(`readOnlyToolNames`)이 아닌 도구마다 `tool_result` 노드가 세션 기록에 있는 것이다. 다음 run은 그 기록을 보고 판단하는 새 턴이며 재생하지 않는다. 도구 승인(`toolAuthorize`)만 있고 실행이 없던 호출은 아무것도 하지 않았으므로 막지 않는다. ledger의 `succeeded`만으로는 부족하다. 도구 단계가 끝나 노드를 쓰기 전에 서버가 내려가면 성공한 도구가 기록에 없을 수 있다. 실제로 2026-10-12 재시작에서 마지막 `read_tool_result`가 이렇게 빠졌다. 기록 없는 쓰기 도구, `pending`·`uncertain` 도구, 이름 없는 작업이 남은 run은 계속 막는다. uncertain 읽기는 기존 read recovery로만 푼다. 판정은 입장 시 `nodes_tool_result_call` 인덱스로 한다. owner ledger의 새 side-effect 예약도 같은 run을 미해결로 세지 않는다. 그렇지 않으면 입장은 통과해도 끊긴 run에 남은 middleware 기록 때문에 첫 도구가 거부된다.
- 수정(2026-10-14): 그래도 남는 미해결 run은 사용자가 확인하고 이어갈 수 있다. 이전에는 운영자 API와 백업 확인 절차로만 풀 수 있었고, 화면은 일반 오류만 보여서 Goal 전체가 멈췄다.
  - run state의 `uncertainRuns`가 막고 있는 run과, 결과를 알 수 없는 도구(이름, 비밀을 가린 호출, 상태 `pending`·`uncertain`·`rejected`·`unrecorded`)를 보여준다. 채팅 화면에 "확인했어요, 이어서 진행" 버튼을 둔다.
  - 확인은 `workflow_uncertain_acknowledgements`에 run별로 남는다. 입장(`previous`·`unresolved`), 채팅 요청의 같은 검사, 새 Goal 전환 검사가 확인한 run을 미해결로 세지 않는다. 그 run의 도구는 재생하지 않고, 다음 턴은 기록을 보고 판단하는 새 run이다. 확인한 run은 완료 근거가 되지 않는다(완료된 run만 근거).
  - 사용자가 본 목록과 지금 목록이 다르면 거절하고 새 목록을 보여준다. 세션에서 run이나 durable Goal 실행이 진행 중이거나 백그라운드 작업이 있으면 거절한다. 사용자가 확인한 것보다 많은 것을 넘기지 않기 위해서다.
  - 운영자 read recovery는 그대로 둔다. 바인딩 없는 실패 run이 새 Goal 전환을 막는 경우는 이 확인으로 풀리지 않는다.

### 잘못된 성공 거르기 (2026-10-14)

- Goal 완료 근거는 원래 같은 run의 `ok` `tool_result` 노드를 요구한다. 모델이 근거 없이 "완료"라고 하는 것은 이미 근거가 되지 않는다.
- 셸 명령이 성공하지 않은 결과(`status`가 `failed`·`timed_out`·`cancelled`, 0이 아닌 종료 코드 포함)와 끝나지 못한 외부 에이전트 결과(`failed`·`cancelled`·`disconnected`·`unavailable`)는 `ok: false`로 기록한다. 도구 호출 자체는 돌아왔어도 맡은 일이 성공하지 않았기 때문이다. 다시 불러온 대화에서도 실패로 보인다.
- 백그라운드 접수 응답(`taskId`가 있고 `status`가 `completed`·`succeeded`가 아닌 결과)은 완료 근거로 받지 않는다. 접수는 일이 끝났다는 뜻이 아니다. 끝난 결과는 `get_background_result`나 `get_subagent_report`로 읽은 노드로 제시해야 한다.
- 쓰기 도구는 기대 sha256이 맞아야 바꾸고 프로젝트 범위를 벗어나지 않는다. 성공한 쓰기 결과는 그대로 근거로 쓴다.

### 개발 빌더와 full-loop worker 소스 (2026-10-03)

- Goal 네이티브 artifact 생성에 사용하는 Vite는 checkout의 설치된 패키지에서 필요할 때 로드한다. 서버·SEA 번들에 Vite와 선택적 devtools·tsx·esbuild 의존성을 포함하지 않는다. 네이티브 entry도 번들 위치가 아닌 memory-agent 패키지의 원본 경로로 해석한다. 독립 실행 파일의 네이티브 artifact 생성 지원은 별도 검증 범위다.
- full-loop worker·codec·RPC client 원본은 TypeScript로 관리한다. Node 26의 타입 제거로 실행할 수 있는 문법만 사용하고, Goal 스냅샷과 런타임 패키징은 세 파일 및 형제 import를 그대로 보존한다. codec의 태그·재귀 값과 RPC 요청·응답·대기열을 타입으로 표현한다. SDK의 동적 hook·값 복원 경계는 기존 동작을 유지한다.

### 개발 요청의 백엔드 빌드 고정 (2026-10-03)

- 사용자의 요청에 따라 소스 변경 감지만으로 모든 mutation을 선제 차단하던 개발 프록시 동작을 제거한다. 프록시는 실행 중인 백엔드의 빌드 ID를 사용한다. 백엔드의 새 코드는 빌드·재시작 후 적용하며 진행 중인 Goal의 코드를 강제 교체하지 않는다.
- 5180 직접 접속에서도 클라이언트에 빌드 시 포함된 ID를 같은 origin의 `/api/` 요청에 전달한다. 다른 origin에는 전달하지 않고 거부된 mutation을 자동 재시도하지 않는다. 실제 빌드 불일치의 409, 종료 중 503, owner lock과 인증·인가 gate는 유지한다.
- `backend_restart_required`는 소스 변경을 확인한 결과가 아니므로 배너에서 코드 변경을 단정하지 않는다. 저장된 Goal v2·Plan v13·실행 근거는 기존 세션에서 재사용한다.

### 실행 중 명시적 Goal 변경 동기화 (2026-10-06)

- Execute와 Verify에서도 `update_goal`을 제공한다. 사용자가 명시적으로 변경한 구현 범위·제약·제외 항목은 에이전트가 canonical Goal에 반영하며, 수정 가능한 artifact를 외부 의존성으로 보고하거나 확인되지 않은 Goal 편집 UI를 요구하지 않는다. 단순 재개 요청은 제약 해제 승인이 아니다.
- Execute/Verify에서 Goal을 수정하면 즉시 Plan으로 돌아간다. 기존 Plan과 근거는 보존하되 새 Goal 버전에 맞춰 Plan을 동기화하고 실행 확인을 받기 전에는 이전 실행 턴의 progress를 허용하지 않는다. Goal 변경은 권한·완료 증거·실행 세대 고정을 우회하지 않는다.

### Plan step 의존성 기반 스케줄링 (2026-10-13)

- `PlanStep.dependsOn`을 실행 순서 판단에 쓴다. `update_plan`은 중복 step ID, 존재하지 않는 step 참조, 자기 참조, 순환을 `PlanDependenciesRejected`(문제별 리터럴 태그 목록)로 거부하고 아무것도 저장하지 않는다. 모델은 문제 목록을 받아 Plan을 고쳐 다시 저장한다.
- Ready step은 `pending`이면서 모든 의존 step이 `completed`인 step이다. 검증 전에 저장된 Plan은 읽기 시 거부하지 않는다. 존재하지 않는 참조와 자기 참조는 순서 정보가 없으므로 무시하고, 저장된 순환은 Ready가 되지 않아 교착으로 드러난다. Execute 프롬프트는 각 의존 step의 상태, Ready 목록, 저장된 의존성 문제를 보여 준다.
- blocked step이 있어도 Ready 또는 `in_progress` step이 남으면 서버 자동 진행을 계속한다. 이전에는 blocked step 하나로 이유 기록 없이 멈췄다. 미완료 step이 남았는데 Ready와 `in_progress`가 모두 없으면 run 종료 시 서버가 `dependency_stalled` blocker로 정지하고, 어떤 step이 어떤 blocked·미완료 step을 기다리는지 사슬을 근거로 저장한다. blocked step 자체의 상태와 근거는 그대로 화면에 표시된다.
- `dependency_stalled`는 서버만 기록한다. `record_workflow_blocker` 입력에는 노출하지 않는다. 구조적 교착은 서버가 Plan 상태만으로 결정적으로 판정할 수 있고, 의존 관계가 잘못된 의미상 교착은 모델이 `update_plan`으로 dependsOn을 고쳐 해결해야 하므로 모델에 blocker 출구를 주지 않는다. 다음 턴 프롬프트에는 진행 불가 사슬을 보여 준다.
- 서브에이전트 자동 배정, WIP 제한, 칸반 UI, DurableQueue는 이 단계의 범위가 아니다.

### Configurable dev and Goal settlement boundaries (2026-10-10)

- Dev accepts CLI backend/web ports, storage and manifest paths, with CLI values taking precedence over environment defaults. Readiness requires the matching build ID and `status: ready`; frontend HMR remains enabled and backend changes require an explicit rebuild/restart. Isolated verification uses temporary storage and alternate ports, leaving existing servers and user sessions alone.
- Goal source generation identifies both the Goal and worker build bytes. The separate worker hash verifies bytes; identical worker builds in different Goals must not collide with the database's globally unique generation constraint. Previously saved content-hash pins remain verifiable and are not rewritten.
- New-Goal intent admission excludes only the calling run's pending RPC; uncertain effects remain refused. Applying the intent after termination rechecks all owner receipts without that exclusion.
- Criterion mappings from a running recorder are proposals, not completion snapshots. Only after successful SDK and durable Goal settlement does the owner revalidate versions, node ownership/success, dispatch identity and all operation receipts to publish completion evidence. Failed or uncertain runs cannot complete the Goal.
- Worker approval continuation requires owner persistence. The SDK validates the stored complete interrupt batch and original response schemas; only its owner-validated approval Map authorizes pending calls. A resolved pause is distinct from a crash and does not replay completed tools or fabricate success for the interrupted run.
- A definite read-tool error crosses the RPC as a tagged failed result and retains `ok: false`; it does not become an uncertain side effect. Write/provider failures still use the conservative uncertainty gate.
- Native SQLite read sessions close explicitly before worker teardown. The owner awaits a close acknowledgement before termination, with a bounded fallback for a failed worker. This makes SQLite and N-API resource lifetime explicit across runtime reopen. Scope-owned test runtimes close before temporary storage is removed. Parallel and serial stress runs still produced a SQLite WAL/SHM SIGBUS on macOS; this lifetime change alone is not evidence that the crash is resolved. The same-process Node SQLite/bundled rusqlite boundary requires further review; do not bypass locking or WAL visibility to force a green test.
- Existing Effect diagnostic severity remains unchanged. Approved unstable API use is inventoried separately from ordinary TypeScript errors; it is not reported as a passing configured type check.

### Effect execution admission and safe observability (2026-10-10)

- One process-scoped `ExecutionAdmission` service owns separate workflow, worker, model and tool gates. Each gate uses an active `Semaphore` plus a total-admitted `Semaphore`, so active work and queued waiters are both bounded. Configuration is validated from `CONTEXT_AGENT_{WORKFLOW,WORKER,MODEL,TOOL}_{CONCURRENCY,QUEUE_CAPACITY}`; invalid values fail Layer construction.
- (2026-10-14 대체) 대기열까지 꽉 차도 바로 실패하지 않는다. 호출자는 지터를 둔 지수 백오프(50ms에서 시작해 최대 2초 간격)로 다시 시도한다. 이미 실행 중인 일(worker, 모델 호출, 도구, 실행 중 provider 재시도 대기)은 살아 있는 동안 계속 기다리고, 취소되면 기다림도 끝난다. 사용자의 요청이 기다리는 새 Goal 실행 admission만 30초 뒤에 `ExecutionSaturated`로 실패해 HTTP 503 `goal_workflow_saturated`가 된다. 로컬 동시성 한도 때문에 이미 시작한 실행이 중간에 실패하면 안 되기 때문이다.
- A full queue fails immediately with typed `ExecutionSaturated`. Workflow admission maps this to HTTP 503 before issuing a worker capability; full-loop workers hold a worker permit for their Scope, model `next()` calls hold model permits, and owner tool implementations hold tool permits. Interruption and Scope finalization release both permits exactly once.
- Admission metrics expose only kind-tagged active, queued and saturation counts. Spans/logs contain kind, configured limits, queue depth and outcome; they do not include prompts, records, SQL, endpoints, capability tokens or credentials. Durable workflow execution IDs remain canonical derived hashes rather than raw session/run values.
- The owner workflow engine continues to own live executions in scoped `FiberMap`s, keyed by derived execution ID, which is deterministically bound to session/run/Goal/revision. `onlyIfMissing` rejects duplicate run/timer fibers, and Scope shutdown interrupts and joins them structurally.
- This migration adds no `Schedule` retry around workflow, model, tool, file, remote, or Goal-loop effects. Retrying an uncertain side effect remains forbidden. A future retry may be introduced only at an enumerated idempotent infrastructure boundary (database read/connect or pre-dispatch worker acquisition), with its stable key and exhaustion outcome documented first. (갱신: provider 요청 전 transport 실패 경계를 아래 "Provider 요청 전 transport 실패의 durable 재시도 경계 (2026-10-13)"에 추가했다.)

### Build-time native and Goal-worker artifacts (2026-10-10)

- `memory-agent#build` produces `dist/runtime/native.mjs`, a self-contained `full-loop-worker.mjs`, and a canonical manifest with full SHA-256 hashes. Application packaging schema-decodes that manifest, verifies both files, and copies those exact bytes; startup and first Goal requests do not invoke Vite or transpile TypeScript.
- The native artifact keeps the explicitly shared Effect/TanStack runtime imports and is evaluated from a scoped staging directory adjacent to the checkout/package runtime so those imports resolve to the owner's module identities. Its immutable bytes are copied once into owner storage under the artifact hash before an atomic Goal registration. Existing Goals load only their registered durable bytes, so a new application build cannot silently replace historical execution code.
- The full-loop worker is bundled except for `node:` imports. A new Goal copies the verified build artifact into its durable Goal pin and records a Goal-specific manifest. `sourceGeneration` hashes the Goal ID and worker hash; the worker SHA-256 separately verifies file integrity. Cold adoption validates saved bytes and manifest without reading current build inputs, including earlier content-hash generation pins. Worker leases still prevent registry disposal while an OS worker is active.
- Missing, malformed, corrupt, or mismatched manifests/artifacts are explicit startup or admission failures. There is no source-tree/SDK-tree capture, `.ts` worker fallback, runtime compiler, or legacy artifact fallback on these paths.

### Durable approval, timer, and queue boundary (2026-10-10)

- Relayed subagent/external-agent permission waits are `RelayedApprovalExecution` Effect Workflows keyed by session, run, and random approval ID. The decision is a schema-typed `DurableDeferred`; answers are admitted only after the session/approval payload match, same-value duplicate completion is idempotent, and a conflicting duplicate is rejected.
- Approval timeout is a durable `DurableClock` branch in a persisted `DurableDeferred.raceAll`. The owner engine now resumes pending executions when their workflow registers after restart. Once either approval or timeout completes the workflow, still-scheduled loser clocks are removed and their scoped timer fibers are interrupted.
- Owner cancellation interrupts the bound workflow, removes it from the pending page view, and cancels its timer; it never turns cancellation into a durable denial. A process/layer restart without owner cancellation preserves and resumes the pending approval. No model, tool, file, remote API, or entire Goal loop is replayed to consume an answer automatically.
- No production `DurableQueue` is enabled in this migration step. The installed queue is at-least-once, typed handler failures complete rather than retry, crash after a side effect can redeliver, and dead letters require an explicit requeue operator path. Current candidate work either includes model/remote effects, already has a different owner/recovery contract, or lacks a proven stable idempotency key plus dead-letter procedure. A future post-commit derived task may adopt it only with those proofs, bounded attempts, observation, and manual requeue documented first.

### Provider 요청 전 transport 실패의 durable 재시도 경계 (2026-10-13)

- 2026-10-10 "Effect execution admission and safe observability"의 재시도 허용 경계에 **provider 요청이 전송되기 전이 확정된 transport 실패**를 추가한다. 연결 수립·DNS·TLS 등 요청 본문이 provider에 도달하지 않았음을 어댑터가 확정할 수 있는 실패만 해당한다.
- 요청 전송 이후의 실패, 일부 출력이나 tool call을 받은 뒤의 스트림 중단, 원인이 불명확한 실패는 이 경계에 포함하지 않는다. 이 경우는 기존 Work Trace 계약(2026-09-20)대로 재생하지 않고, 필요하면 새 attempt에서 논리적으로 이어간다. model·tool·Goal-loop 전체를 재실행하는 retry는 계속 금지한다.
- 전제: 현재 `SubscriptionStreamFailed`는 알려지지 않은 오류를 모두 `TransportUnavailable`로 변환하므로 요청 전 실패를 구분할 수 없다. reason을 요청 전 실패와 그 외로 나누기 전에는 재시도를 활성화하지 않는다. (갱신: 아래 "구독 provider 스트림 실패의 전송 단계 분류 (2026-10-13)"에서 나눴다. 재시도 대상은 `RequestNotSent`뿐이다.)
- 안정 키는 run attempt ID와 해당 attempt 안의 재시도 순번으로 구성한다. 현재 시각·랜덤 값·프로세스 로컬 카운터는 키에 쓰지 않는다.
- 대기 간격은 2초에서 시작해 2배씩 늘리고 한 번의 대기는 최대 30분으로 제한한다. jitter를 포함해 계산한 `retryAt`은 한 번만 계산해 영속화하고, replay에서 다시 계산하지 않는다. 대기는 `DurableClock`으로 수행하며 앱 재시작 후에도 복원되도록 `inMemoryThreshold: 0`을 사용한다.
- 소진 결과: 재시도 한도(총 경과 시간 또는 횟수)는 구현 시 이 항목에 수치로 기록한 뒤 활성화한다. 한도를 넘으면 실행 실패로 끝내지 않고 기존 blocker 경로(2026-10-02)로 정지해 이유와 근거를 표시한다. 사용자 취소·일시 중지는 대기 중인 재시도를 중단하며 자동 재개하지 않는다.
- 이 결정은 `DurableQueue` 보류(2026-10-10)를 바꾸지 않는다.
- 구현(2026-10-13): 재시도는 Goal 실행(full-loop worker)의 provider 호출에만 적용한다. 일반 채팅은 이어서 달성할 목적이 없으므로 제외한다. 실패를 바로 표시하고 사용자가 다시 보낸다.
- 구현: 재시도 범위는 owner의 모델 스트림 pull이다. `RequestNotSent`이고 어댑터의 `RUN_STARTED` 외 chunk가 worker에 하나도 가지 않았을 때만 같은 요청을 새 스트림으로 다시 보내고, 새 스트림의 `RUN_STARTED`는 건너뛴다. 그 외 실패, 소진, 취소는 원래 provider 실패로 끝난다. 각 pull은 model 게이트를 거치고, 대기하는 동안에는 model permit을 잡지 않는다. 대기 workflow는 Goal 실행처럼 workflow 게이트를 거쳐 admission한다.
- 구현: Goal run 하나가 attempt 하나다. 상위 Goal run은 `agent_run_attempts`를 만들지 않으므로 키는 bound run ID와 그 run의 대기 순번이다. 순번은 프로세스 카운터가 아니라 그 run에 저장된 대기 workflow 수에서 정한다. 백오프와 한도는 한 provider 요청의 연속 재시도 횟수와 첫 실패 시각으로 센다. `retryAt`은 admission 전에 owner가 한 번 계산해 workflow payload(SQLite)에 저장한다. workflow 본문은 저장된 값으로 `DurableClock`만 다시 건다.
- 구현: 소진되면 `external_dependency` blocker를 기록한다. run이 실패로 끝나도 blocker가 남는다. 취소·일시 중지·중단·phase 변경은 대기 workflow를 interrupt하고 timer를 지운다. 대기 중인 시각은 workflow 패널에 표시한다.
- 소진 한도(2026-10-13 확정): 한 provider 요청의 첫 실패부터 다음 재시도 시각까지 24시간. 횟수 한도는 두지 않는다. 대기 상한이 30분이라 횟수 한도는 경과 시간 한도보다 먼저 끝나 긴 장애를 버티지 못한다. 재시도는 같은 요청을 다시 보낼 뿐 새 작업이나 단계를 만들지 않으므로 순환·무한 작업 감지는 이 경계에 두지 않는다. Plan 의존 순환은 `PlanDependenciesRejected`가 막는다.
- 예외(2026-10-13): 서버 종료로 끊긴 Goal run 중 다음 run이 모르고 반복할 일이 없는 run(`endedWithKnownEffectsSql`)은 재시작 후 자동으로 이어간다. 판정은 다음 run의 입장 fence(승인된 Plan의 서버 자동 진행 2026-10-02의 2026-10-13 수정)와 같은 규칙이다. 도구를 실행하지 않았거나, 실행한 도구가 모두 `succeeded`이고 읽기 전용이 아닌 도구마다 `tool_result`가 세션 기록에 있는 run이다. 그 run에 대기 중이던 재시도가 있으면 저장된 `retryAt`에, 없으면 바로 이어간다. 이는 "요청 후 실패는 재시도하지 않는다"에 대한 명시적 예외다. 근거: owner 도구 호출은 실행 전에 장부에 예약되므로, 장부에 없는 도구는 실행되지 않았다. 기록된 도구 결과는 새 run이 transcript에서 읽으므로 같은 변경을 모르고 반복하지 않는다. 끊긴 run은 재생하지 않는다. 새 continuation run이 Plan과 transcript를 기준으로 남은 단계를 이어간다(Work Trace 2026-09-20). 자동 진행 상태는 `retrying`으로 저장하고, 대기 workflow가 다시 재시작돼도 복원된다. 사용자 취소·일시 중지는 이 이어가기도 멈춘다.
- 예외의 범위 밖: `pending`·`uncertain` 도구, 결과 기록이 없는 쓰기 도구, 이름 없는 작업이 남은 run은 fence를 유지한다. 자동으로 이어가지 않고 `server_restarted` blocker로 이유를 표시한다. 이 blocker는 서버만 기록한다.

### 구독 provider 스트림 실패의 전송 단계 분류 (2026-10-13)

- `SubscriptionStreamFailed.reason`의 `TransportUnavailable`을 다음 넷으로 나눈다. 다른 reason(`ProviderRejected`, `InvalidToolCall` 등)과 로그의 `code: failure._tag`는 그대로다. 이 reason은 영속화하지 않는다.
  - `RequestNotSent { stage: "dns" | "connect" | "tls" }`: 요청 본문이 provider에 도달하지 않았음이 확정된 실패. fetch가 거절한 오류의 `cause.code`가 `ENOTFOUND`·`EAI_AGAIN`(dns), `ECONNREFUSED`·`ENETUNREACH`·`EHOSTUNREACH`·`UND_ERR_CONNECT_TIMEOUT`(connect), 인증서 검증 오류(tls)일 때만 해당한다.
  - `ProviderStatusRejected { statusClass: "client_error" | "server_error" }`: provider가 HTTP 오류 상태로 거절. 상태 범주만 남기고 응답 본문·메시지는 경계 밖으로 내보내지 않는다. Anthropic prompt-cache 거절은 기존대로 `ProviderFeatureRejectedError`로 baseline 요청을 한 번 다시 보낸다.
  - `ResponseInterrupted`: 응답 헤더를 받은 뒤 본문 스트림이 끊기거나, 이벤트를 하나라도 받은 뒤 실패.
  - `RequestOutcomeUnknown`: 그 외 모든 실패. `ETIMEDOUT`·`ECONNRESET`·`UND_ERR_SOCKET`·헤더 timeout·redirect 거절·코드 없는 오류는 요청이 전송됐을 수 있으므로 여기에 둔다. 요청이 전송된 것으로 취급한다.
- 분류는 입출력 경계에서 구조화된 값으로만 한다. OAuth 클라이언트가 fetch 단계(오류 code)·HTTP status·본문 스트림 단계를 `oauth/protocol.ts`의 `ProviderStreamFailed`로 표현하고, 어댑터는 첫 이벤트 수신 여부만 더해 `SubscriptionStreamFailed`로 옮긴다. `Error.message` 키워드로 분류하지 않는다.
- 자격 증명 읽기·토큰 갱신 실패처럼 OAuth 클라이언트가 `ProviderStreamFailed`로 표현하지 않는 오류는 `RequestOutcomeUnknown`으로 보수적으로 둔다.
- 모델 스트림의 HTTP 거절은 더 이상 `OAuthHarnessError`에 provider 오류 문구를 담지 않는다. live 검증 스크립트도 상태 범주만 본다.
- 이 단계는 재시도를 추가하지 않는다.

### Goal full-loop transport: Effect Worker/RPC protocol boundary (2026-10-10)

- The production full-loop uses `@effect/platform-node` `NodeWorker`, `effect/workers` `Worker`/`SerializedWorker`, and `effect/rpc` `Rpc`/`RpcGroup`/`RpcMiddleware`. The old handwritten worker frame parser, pending-Promise resolver, and chunk-ack listener are no longer on this production path.
- `RunFullLoop` is a schema-decoded streaming RPC. Its capability middleware compares the complete session/run/Goal/revision/generation/token tuple before the SDK loop runs. Transferable `MessagePort` schema carries a dedicated reverse owner-RPC channel; the reverse server still executes the existing owner ledger/admission checks, so RPC transport does not become a second authority or source of truth.
- The MessagePort protocol adapter is project-owned and scoped: bounded inbound queue, typed close/message/overflow failures, structured-clone codec, transfer-list support, native RPC acknowledgements, and listener/port cleanup. `streamBufferSize: 0` keeps producer progress tied to consumer acknowledgement rather than adding an unbounded application buffer.
- Worker and reverse-port protocol Layers live for the execution Scope, SDK interruption aborts its `AbortController`, and Scope finalization awaits actual worker termination before releasing owner asset hooks. A dispatched owner operation is never retried by the transport; the existing durable operation ledger reuses only succeeded receipts and stops pending/uncertain effects.
- Goal worker pins copy the build-produced self-contained `.mjs`; its SHA-256 verifies bytes and a Goal/build hash identifies the source generation. They no longer capture protocol source files or SDK dependency trees on first request.

### Owner RPC fingerprint의 bounded evidence와 해시 비교 (2026-10-11)

- 반복 context snapshot을 fingerprint에 저장하지 않고, 기존 canonical request 전체의 SHA-256과 명시적 버전 envelope로 비교한다. 진단·읽기 복구 입력은 16,384자까지, 큰 middleware는 index/hook만 보관한다. 권한·high-water·cached reply·uncertain fence는 유지한다.
- 구형 fingerprint도 동일 digest로 비교하며 명시적 offline 변환만 지원한다. 불변 읽기 복구 receipt에 연결된 원래 fingerprint를 변경하지 않는다. 실제 변환과 공간 회수는 검증된 복구 백업과 전후 비-fingerprint 데이터 일치 확인을 전제로 한다.
- 마이그레이션 백업은 검증·재기동·수용 이후 정리 가능한 일시 복구 자료다. 전체 원본의 영구 보관을 제품 요구사항으로 추가하지 않는다. 현재 완료 snapshot과 모델 context 압축은 참조 대상 원본을 대체하는 완전한 보관본이 아니므로 snapshot 완료만으로 ledger/실패/증거를 자동 삭제하지 않는다. 장기 정리는 독립 복원 검증과 run retirement/tombstone 및 최소 idempotency 증명 정책을 별도로 설계한다.
- 상세 근거: [owner-rpc-fingerprint-remediation-2026-10-11.md](owner-rpc-fingerprint-remediation-2026-10-11.md).

### 칸반 카드 배정에 DurableQueue 채택 (2026-10-18)

- "Durable approval, timer, and queue boundary (2026-10-10)"의 DurableQueue 보류를 칸반 카드 배정에 한해 푼다. 카드 실행 하나가 큐 item 하나다.
- 재전달은 replay가 아니라 이어가기다. 재전달된 카드는 같은 카드 worktree와 이전 transcript를 보고 새 attempt로 남은 일을 한다. 근거는 "Provider 요청 전 transport 실패의 durable 재시도 경계 (2026-10-13)"의 이어가기 예외와 같다.
- 이어가기 fence는 그대로다. `pending`·`uncertain` 도구나 결과 기록이 없는 쓰기 도구가 남은 attempt는 자동으로 이어가지 않고 `human_decision`으로 보낸다. worktree 밖 부작용은 owner ledger receipt로만 판정한다.
- 멱등 키는 `goalId:cardId:attemptNo`이고 attemptNo는 owner가 저장된 값에서 정한다. 시도를 다 쓴 item은 카드를 `blocked`로 표시하고, 보드에서 다시 큐에 넣는 경로를 함께 둔다. 이 경로 없이는 활성화하지 않는다.
- 큐 저장소는 owner Database 연결을 쓰는 프로젝트 소유 `PersistedQueue` store다. 별도 DB를 두지 않는다.
- 동시에 실행하는 카드 수는 기기 사양에 따라 다르므로 사용자 설정으로 둔다.
- 보드·큐 멱등 키·브랜치는 `goalInstanceId` 기준이다. Goal 수정은 instance를 유지하고 버전만 올리므로 key를 다시 매기지 않는다. 카드 attempt는 배정 시 Goal·Plan 버전을 고정하고, 최신 값과는 배정·verify·merge 경계에서만 비교한다. 새 Goal 전환으로 pointer가 바뀐 뒤 재전달된 이전 instance item은 실행하지 않고 `Superseded`로 완료한다.
- 칸반 모드에서 같은 instance의 Goal을 수정하면 일괄 정지하지 않는다. 시작 전 카드 배정만 잠시 멈추고, 오케스트레이터가 카드마다 `Continue`·`Amend`·`Stop`·`Replace`·`NeedsDecision` 중 하나로 판정해 바로 적용한다. 사용자는 어떤 판정이든 보드에서 뒤집을 수 있다. worktree를 남기므로 `Stop`·`Replace`도 되돌릴 수 있다. 이 규칙은 칸반 모드에서 "실행 중 명시적 Goal 변경 동기화 (2026-10-06)"의 즉시 Plan 복귀를 대신한다.
- 통합 검증을 통과한 Goal 브랜치는 Goal을 시작한 사용자 브랜치에 자동으로 merge한다. 대상이 보호 브랜치(프로젝트 설정, 기본 `main`·`staging`)면 자동 merge하지 않고 사용자가 PR이나 수동 merge를 고른다. 같은 대상으로 가는 merge는 대상 브랜치별로 하나씩 처리하고, 충돌은 사용자 판단으로 넘긴다. 대상 브랜치가 checkout된 작업 트리에 커밋하지 않은 변경이 있으면 merge하지 않고 기다린다.
- 카드는 Goal 브랜치에 카드당 squash commit 하나로 통합한다. 저장소의 실제 브랜치 전략과 같다.
- 카드 worktree는 `~/.context-generactive-agent-worktrees/<goalInstanceId>/<cardId>`에 둔다. storage root는 credential directory라 그 아래에 두지 않고, 보호 경계에 예외를 만들지 않는다. 카드 서브에이전트의 도구 루트는 그 worktree다.
- 기본값: 동시 실행 수는 CPU 코어 수의 절반(최소 1, 최대 4), 카드당 최대 시도 수는 3이다. provider 장애 재시도는 시도 수와 따로 센다.
- 여러 Goal을 끝까지 자동으로 돌리려면 Goal 사이 조정이 필요하므로, 프로젝트 스케줄러(LLM 아닌 결정적 서비스)를 첫 범위에 넣는다. round-robin offer, Goal 간 `dependsOn`, 대상 브랜치별 merge queue, upstream 변경 신호, 파일 겹침 알림, 통합 `human_decision` inbox를 맡는다.
- 설계: [kanban-orchestration.md](kanban-orchestration.md).
- 슬라이스 A 세부 결정 (2026-10-18):
  - 카드 상태는 새 저장부터 `CardStatus`로 쓴다. 이전에 저장된 `pending`·`completed`는 읽을 때만 해석하고(의존이 끝났으면 `ready`, 아니면 `backlog`), 저장된 행을 다시 쓰지 않는다.
  - 모델 도구 계약(`update_workflow_progress`의 `pending`·`in_progress`·`completed`·`blocked`)과 실행 프롬프트의 단계 표기는 바꾸지 않는다. 카드 상태는 그 어휘로 매핑한다(`backlog`·`ready`→pending, `verify`→in_progress, `human_decision`→blocked, `done`→completed). Goal 실행 스케줄은 `backlog`와 `ready`를 모두 시작 전으로 보고 의존 충족으로 시작 여부를 정한다.
  - 카드 계약의 Evidence 필드 이름은 `requiredEvidence`다. 이미 있는 `evidence`(실제로 기록된 근거)와 구분한다. Risk는 `low`·`medium`·`high`다. `update_plan`으로 같은 step id를 다시 계획하면 계약 필드를 유지한다.
  - 작성자: 사용자 보드 API는 `User`, Goal 실행 run의 `update_plan`·`update_workflow_progress`는 `Orchestrator(runId)`로 남긴다. phase·Goal·lifecycle 저장과 이전 revision은 작성자를 추측하지 않고 NULL로 둔다.
  - 사용자 보드 변경은 본 Plan의 `planVersion`을 함께 보낸다. 그사이 Plan이 바뀌었으면 `plan_version_conflict`로 거절한다. 적용된 변경은 `plan.version`을 올린다.
  - 카드 취소는 Plan에서 카드를 뺀다. 다른 카드가 그 카드에 의존하면 `PlanDependenciesRejected`로 거절한다. `done` 카드의 수정·취소는 `card_finished`로 거절한다. 순서 변경은 실행 중 카드에도 바로 적용한다.
  - 사용자가 `in_progress` 카드를 수정·취소하면 `board_change_requests`에 `pending`으로만 저장한다. 수정 요청도 저장 전에 의존 규칙을 검사한다. 오케스트레이터 작성자의 변경은 바로 적용한다.
  - 사용자가 추가한 카드의 상태는 의존 충족 여부로 `backlog`·`ready` 중 하나가 된다. 이 슬라이스에서 사용자는 카드 상태를 직접 바꾸지 않는다.

### 칸반 카드 실행기와 큐 저장소 구현 경계 (2026-10-18)

- Goal 브랜치는 사용자 HEAD에서 ref만 만든다(`git branch`). 카드 worktree는 `CardWorktrees.lease`(acquireRelease)로 attempt 동안 잡고, lease 중에는 정리하지 않는다.
- 정리 규칙: `Done`은 worktree와 카드 브랜치를 지운다(깨끗한 worktree만). 취소(`Cancelled`)는 남은 변경을 카드 브랜치에 스냅샷 커밋한 뒤 worktree만 지우고 브랜치는 남긴다. `Blocked`·`HumanDecision`은 그대로 둔다.
- squash 통합은 Goal별로 직렬화하고, 사용자 작업 트리 없이 `commit-tree` + `update-ref <new> <old>`(CAS)로 Goal 브랜치를 옮긴다. 커밋 메시지에 `Ctx-Card: <goal>/<card>` trailer를 남겨 같은 카드의 재통합을 `AlreadyIntegrated`로 판정한다. Goal이 앞서 있으면 `GoalAdvanced`로 멈추고, 호출자가 `syncWithGoal`(merge) 후 다시 verify한다. merge 충돌은 abort하고 파일 목록과 함께 실패한다.
- 내부 카드 브랜치 커밋은 `--no-verify`로 hook을 건너뛴다. 저장소 hook은 Goal이 사용자 브랜치에 들어갈 때 적용된다. 사용자 git identity와 설정은 그대로 쓴다.
- ref를 바꾸는 git 호출은 uninterruptible로 끝까지 실행해 결과를 항상 관찰한다. 실패한 git 호출은 자동으로 다시 하지 않는다.
- git이 없거나, git 저장소가 아니거나, 커밋이 없으면 `SequentialRequired`로 알리고 카드를 순차로 실행한다.
- 카드 도구 루트: `cardToolProject`가 project root를 카드 worktree(저장소 안 프로젝트 하위 경로 포함)로 바꾸고, outside 도구에 fence(사용자 작업 트리, 프로젝트 root, worktree base)를 붙인다. fence는 대상이 그 아래이거나 위(상위 폴더 listing)여도 `outside_tool_root`로 거부한다. credential·storage root 규칙은 바꾸지 않는다.
- PersistedQueue store는 owner 연결 위 `effect/sql` 어댑터로 `persisted_queue_items`에 저장하고, 시각은 Effect `Clock` 밀리초다. owner 프로세스만 store를 만든다. 시작할 때 이전 owner가 잡은 행을 풀어 재전달한다(시도 수는 유지). 실패 기록(`last_failure`)에는 오류 태그만 남기고 provider 본문은 남기지 않는다. requeue는 failed 행만 attempts 0으로 되돌리고 id(멱등 키)는 유지한다. `PersistedQueue.layerCleanup`은 같은 store로 `memoryAgentLayer`에서 돈다.
- 동시 실행 수 사용자 값은 1~32이고, 비우면 기본값(CPU 코어 절반, 1~4)을 쓴다.

### 칸반 human_decision 대기와 통합 inbox (2026-10-18)

- 카드 상태 이동은 `Workflows.transitionCard(sessionId, { cardId, from, to }, author)` 하나로 한다. 허용 전이 표(`cardTransitions`)를 두고, `done`은 끝 상태다. 카드가 `from`에서 이미 바뀌었으면 `card_status_changed`로 거절해 두 작성자가 같은 카드를 동시에 옮기지 못한다. `backlog`·`ready`로 옮기면 의존 충족 여부로 둘 중 하나가 되고, 이동 뒤 시작 전 카드 전체를 다시 계산한다. 상태 이동은 진행이므로 `plan.version`을 올리지 않는다(사용자 보드 편집의 버전 충돌을 만들지 않는다).
- `HumanDecisions.request`가 카드를 `human_decision`으로 옮기고 대기를 시작한다. 카드가 먼저 움직이므로 오케스트레이터가 아직 실행하는 카드에 대기가 생기지 않는다. 요청 ID는 `(sessionId, goalInstanceId, cardId, key)`에서 나온 workflow execution ID다. 같은 key의 재요청은 상태와 관계없이 기존 요청을 돌려주고 카드를 다시 옮기지 않는다.
- 요청 종류와 선택지, 응답 후 카드 상태: `UncertainSideEffect`(continue·retry→ready, stop→blocked), `IntegrationConflict`(resolved→verify, rework→ready, stop→blocked), `ImpactUnclear`(continue→ready, replace·stop→blocked), `RetryExhausted`(requeue→ready, stop→blocked), `ProtectedBranchMerge`(create_pr→ready, manual_merge→done; 슬라이스 F에서 Goal 단위 판단으로 바뀌어 카드를 옮기지 않음). 오케스트레이터는 보드를 다시 읽고 `forCard`/`get`으로 답을 읽어 다음 일을 정한다. 요청에는 자유 텍스트를 두지 않고 도구 이름·파일·버전·브랜치 같은 메타데이터만 둔다.
- 답에 따른 카드 이동은 workflow 안의 Activity로 `User` 작성자가 한다. 답이 저장된 뒤 재시작해도 Activity가 이어서 실행된다. 그사이 카드가 `human_decision`을 떠났거나 Goal이 바뀌었으면 답은 남기고 카드는 옮기지 않는다.
- 다른 두 답이 동시에 오면 저장된 답이 이긴다. 진 쪽은 저장된 값을 다시 읽어 `answer_conflict`로 거절한다.
- 닫기는 사유(`orchestrator_cancelled`·`goal_replaced`·`card_stopped`)를 `human_decision_closures`에 먼저 쓰고 workflow를 interrupt한다. 시작할 때 사유 행이 있는데 아직 대기 중인 workflow는 interrupt를 마저 하고, Goal pointer가 바뀐 세션의 대기는 `goal_replaced`로 닫는다. Goal 교체를 직접 알리는 hook은 두지 않았다. 응답 시 pointer가 다르면 그 요청을 닫고 `goal_superseded`로 거절하며, 보드·inbox 조회는 현재 Goal의 요청만 보여 준다. pointer를 바꾸는 쪽(C·F)은 `closeSuperseded(sessionId)`를 부를 수 있다.
- 사용자가 보드에서 `human_decision` 카드를 취소하면 그 카드의 대기를 `card_stopped`로 닫는다. 닫힌 요청에 대한 답은 `request_closed`로 거절한다. 닫기는 답이 아니다.
- 통합 inbox는 사이드바의 "판단 대기"다. 프로젝트의 모든 세션에서 현재 Goal의 미응답 요청을 오래된 순으로 보여 주고, 거기서 바로 답하거나 `card` 쿼리로 그 대화의 보드를 열어 카드를 표시한다. 응답은 대상 세션의 lease를 확인한다(다른 창이 쓰는 세션이면 423). 요청·응답·닫기는 `run-state` 세션 이벤트를 보내 보드와 inbox를 다시 읽게 한다.

### 칸반 오케스트레이터 루프와 카드 큐 (2026-10-18)

- 셸 샌드박스 안의 git은 주 저장소의 `.git/worktrees/*/index.lock`과 ref를 쓰지 못한다(`Operation not permitted`, 실측). 그래서 worktree 생성, 카드 커밋, squash·sync는 owner가 한다. 카드 에이전트에게는 커밋하지 말라고 지시하고, owner가 attempt가 끝난 뒤 `commitWork`로 카드 브랜치에 커밋한다.
- 동시 실행 수는 큐 worker 수가 아니라 `take` 앞의 Semaphore로 제한한다. worker는 상한(32)만큼 띄우고, 설정이 바뀌면 `CardQueueGate.reconfigure`가 permit 수를 바로 바꾼다. 실행 중인 카드는 끊지 않는다. 동시 실행 수를 저장하는 경로는 저장 뒤 `reconfigure`를 불러야 한다.
- DurableQueue는 handler 실패를 item 완료로 처리하므로, 전달 한도 3은 owner가 실행 도중 죽어 같은 item이 다시 전달되는 경우에만 쓰인다. 카드 실패(에이전트 실패, 검증 실패, 통합 실패)는 오케스트레이터의 실패 사다리로 다룬다: 첫 실패는 바로 다시, 두 번째는 backoff 뒤 다시, 세 번째는 replan 요청과 함께 `blocked`, replan 뒤 다시 세 번 실패하면 `human_decision`.
- 한도를 다 쓴 item은 dead-letter가 되고, 루프가 카드를 `blocked`(사유 `DeadLettered`)로 옮긴다. 보드의 "다시 대기열에"는 같은 item을 attempts 0으로 되살리고 attempt 기록을 다시 연다. 새 attempt 번호를 만들지 않으므로 이어가기다. requeue와 루프의 한 번 보기는 같은 Semaphore로 순서를 지킨다.
- attempt 결과는 handler가 `kanban_card_attempts`에 먼저 기록하고(첫 기록만 유효), 오케스트레이터는 workflow를 기다리지 않고 기록을 읽어 처리한다. 재시작한 owner는 저장된 보드와 기록에서 이어가고, 아무것도 replay하지 않는다.
- 카드 run은 `kanban_card_runs`에 남고, fence는 결과가 불확실한 run이 있으면 에이전트를 부르지 않고 `Fenced`로 끝낸다. 사람이 판단한 뒤 이어가게 하려면 `acknowledged_at`을 채운다(슬라이스 D의 몫).
- 통합: verify 통과 → squash. Goal 브랜치가 앞서 있으면 sync 후 같은 카드를 다시 verify한다(최대 3회). sync 충돌이면 그 카드를 해결 카드로 대체한다. 해결 카드는 원래 카드 브랜치를 읽기 전용으로 참고해 현재 Goal 브랜치에 같은 변경을 다시 적용한다. 해결 카드가 다시 충돌하면 `human_decision`이다.
- `dependsOn`은 필수 순서, `boundaries` 겹침은 힌트다. 실행 중이거나 verify 중인 카드와 경계가 겹치는 카드는 그 카드가 끝날 때까지 배정을 미룬다. `human_decision`·`blocked` 카드는 슬롯을 쓰지 않는다.
- 사용자 변경 요청: `Apply`는 카드를 바꾸고 실행 중이면 멈춘 뒤 같은 대화에서 변경 메모와 함께 이어가게 한다. `Reassign`은 같고 새 대화(generation+1)에서 시작한다. 취소 요청은 `Apply`만 받는다. `Reject`는 이유와 함께 `rejected`로 남긴다.
- Goal 버전이 올라가면 루프가 hold를 걸어 새 배정과, 이전 Goal로 끝난 카드의 결과 처리를 멈춘다. 모델이 `apply_goal_change`로 카드마다 판정을 적용하면 hold를 풀고 Goal 버전을 따라간다.
- 칸반 보드인 Goal은 `updateGoal`이 Plan 단계로 돌아가지 않는다(execute·verify 유지). 칸반이 아닌 Goal의 동작은 그대로다.
- 칸반 세션의 채팅 모델은 카드를 직접 실행하지 않는다. 자동 이어가기(workflow follow-up)를 하지 않고, 루프가 replan·변경 요청·Goal 변경·전체 완료를 알릴 때만 kanban follow-up으로 깨운다. 같은 상황은 한 번만 알린다. 보드 도구는 부모 run에만 주고 카드 에이전트에게는 주지 않는다.
- 카드 에이전트와 검증자는 카드·세대별 이름을 가진 세션 서브에이전트로 돈다(`Subagents.runAttempt`). 부모 run 없이 시작하고, 시작 전에 chat run id를 등록한 뒤에만 도구를 부를 수 있다. 검증자는 읽기 도구와 `run_skill`만 받고 `record_card_verdict`로 판정을 남긴다.

### 칸반 오케스트레이터와 human_decision 연결 (2026-10-18)

- 오케스트레이터는 카드를 `transitionCard`로 `human_decision`에 직접 옮기지 않는다. 모든 경로가 `HumanDecisions.request`를 부르고, request가 카드를 옮긴다. 경로와 요청 종류: 재계획 뒤 반복 실패는 `RetryExhausted`(시도 수 = 마지막 attempt 번호), 해결 카드의 재충돌은 `IntegrationConflict`(충돌 파일), 결과가 불확실한 run fence는 `UncertainSideEffect`, `apply_goal_change`의 `NeedsDecision`은 `ImpactUnclear`(Goal 버전 쌍)다. 실행 중 카드는 request로 옮긴 뒤 attempt를 멈춘다.
- `UncertainSideEffect`에 fence를 건 `runId`를 넣는다. 사람의 답이 그 run의 fence를 푸는 근거다. run 기록에서 도구 이름을 알 수 없으면 `toolNames`는 빈 배열이고, 화면은 일반 문구를 보여 준다.
- 요청 key는 occasion마다 정한다: `retry_exhausted:<attemptNo>`, `uncertain_side_effect:<runId>:<attemptNo>`, `integration_conflict:<attemptNo>:<이 카드의 답한 충돌 요청 수>`, `impact_unclear:<from>:<to>`. 같은 결과를 다시 처리해도(예: 처리 표시 전 crash) 같은 요청을 돌려받아 두 번 묻지 않는다. 답한 뒤 다시 생긴 상황은 새 attempt나 답 수 때문에 새 key가 된다. 루프가 본 상태에서 카드가 이미 다른 곳으로 옮겨졌으면 묻지 않는다.
- 답에 따른 카드 이동은 D가 한다. 루프는 매 look에서 보드를 읽은 뒤, 배정 전에 아직 따르지 않은 답을 한 번씩 따른다(`kanban_decision_followups`). 답은 카드를 옮기기 전에 저장되므로, 루프가 ready로 본 카드의 답은 이미 읽힌다. 따르는 일: `requeue`는 실패 streak·backoff·사유를 지운다. `continue`·`retry`는 해당 run을 acknowledge하고 다음 attempt에 메모를 남긴다(`retry`는 사람이 반영 안 됨을 확인한 경우라 자동 재실행이 아니다). 충돌 `resolved`는 사유만 지우고 verify 카드를 다시 검증·통합하며, `rework`는 메모를 남긴다. `ImpactUnclear`의 `replace`는 카드를 replan 요청으로 표시해 모델이 대체하게 한다. `stop`은 카드를 `blocked`에 둔다.
- 답하는 API는 답 뒤에 그 Goal의 루프를 poke한다. 다른 경로는 다음 poll에서 이어진다.
- 닫기: 모델의 `Stop`·`Replace` 판정, 카드 취소(직접 취소, 변경 요청 취소), split·merge로 빠지는 카드는 `card_stopped`로 닫는다. 모델이 `human_decision` 카드를 다른 상태로 옮기면 사람 대신 정한 것이므로 `orchestrator_cancelled`로 닫는다. 새 Goal이 적용되면(`settleNewGoalRequest`가 `applied`) 채팅 쪽에서, 그리고 루프가 pointer 변경을 발견해 멈출 때 `closeSuperseded(sessionId)`를 부른다. 닫기는 답이 아니므로 카드를 옮기지 않는다.
- 동시 실행 수: `KanbanSettings`가 저장한 값을 구독자에게 알리고, `CardQueueGate`가 layer를 만들 때 구독해 바로 permit 수를 바꾼다. 설정을 저장하는 어떤 경로도 따로 `reconfigure`를 부를 필요가 없다. 설정 화면·API는 슬라이스 F에서 추가했다(아래 프로젝트 스케줄러 항목).

### 칸반 프로젝트 스케줄러 (2026-10-18)

- 공정성: 동시 실행 슬롯은 같은 기기의 모든 활성 Goal이 함께 쓴다. Goal 우선순위(high·normal·low)는 가중치 4·2·1이다. 슬롯은 가중치에 비례한 몫으로 나누고, 몫이 같으면 가장 오래전에 슬롯을 받은 Goal부터 돌아가며(round-robin) 준다. 아직 수요를 알리지 않은 활성 Goal은 상한만큼 원한다고 본다. 그래서 먼저 깨어난 Goal이 슬롯을 독차지하지 않는다. 쓰지 않는 몫은 원하는 다른 Goal이 쓴다.
- Goal 간 `dependsOn`: 같은 프로젝트의 Goal만 지정할 수 있다. 자기 자신, 다른 프로젝트, 순환은 `GoalScheduleRefused`(reason `self_dependency`·`other_project`·`dependency_cycle`)로 거절한다. 선행 Goal의 merge 상태가 `Merged` 또는 `ManualMerge`가 되면 풀린다. 기다리는 Goal은 새 카드를 시작하지 않고 슬롯을 쓰지 않으며, 선행 Goal이 풀리면 스케줄러가 루프를 깨운다. 의존은 보드에서 켜고 끈다.
- Goal 대상 브랜치: kanban을 시작할 때 사용자 checkout의 현재 브랜치를 대상으로 저장한다(`kanban_goal_schedules`). 브랜치가 없으면(detached) `Stopped(no_target)`로 자동 merge하지 않는다.
- Merge queue(`GoalMerges`): 카드가 모두 done이면 오케스트레이터가 `offer`한다. 대상 브랜치마다 하나씩 직렬로 처리한다.
  - 대상이 Goal 브랜치보다 앞서 있으면 `merge-tree`로 대상을 Goal 브랜치에 먼저 합치고(`commit-tree` + `update-ref` CAS), 다시 검증한다.
  - 검증은 Goal head마다 한 번이다. Goal 단위 검증자(`GoalVerifier`, 에이전트 `goal-verify`)가 분리된 `.goal` worktree에서 돈다. 통과한 head는 `verified_head`에 남겨 같은 head를 다시 검증하지 않는다. 실패는 `goal_unverified` attention이다.
  - 대상 전진: 사용자 checkout이 대상 브랜치에 있으면 그 안에서 `merge --ff-only`, 아니면 `update-ref` CAS다. 사용자 checkout에 추적 파일의 미커밋 변경이 있으면 `WaitingWorktree`로 기다리고 덮어쓰지 않는다. 추적되지 않는 파일은 막지 않는다.
  - 대상과 충돌하면 `MergeConflict`(충돌 파일, 선택지 resolved·stop)를 묻는다. key는 `merge_conflict:<goalHead>:<targetHead>`다.
  - 보호 브랜치(프로젝트 설정, 기본 `main`·`staging`)는 `ProtectedBranchMerge`를 묻는다. key는 `protected_branch:<goalHead>`다. `create_pr`는 `gh`가 PATH에 있을 때만 선택지로 주고, 고르지 않으면 push하지 않는다. `manual_merge`는 사용자가 직접 merge한 것으로 보고 의존을 푼다.
  - PR 생성은 push 뒤 `gh pr create`다. 시작 전에 `PullRequestPending`을 기록한다. owner가 다시 시작할 때 이 상태가 남아 있으면 `PullRequestUncertain`으로 바꾸고 다시 실행하지 않는다.
- Goal 단위 판단: 카드가 아니라 Goal에 대한 판단은 cardId `@goal`로 기록하고 카드를 옮기지 않는다. 그래서 슬라이스 D의 `ProtectedBranchMerge` 응답 매핑(create_pr→ready, manual_merge→done)은 카드 이동 없음으로 바꿨다.
- Upstream 반영: Goal이 merge되면 같은 대상 브랜치의 진행 중인 다른 Goal에 `upstream_pending`을 표시한다. 그 Goal의 루프가 대상을 Goal 브랜치에 합치고, 바뀐 파일과 `boundaries`가 겹치는 done 카드만 다시 검증한다. `boundaries`가 없는 done 카드는 영향받은 것으로 본다. 다시 검증에 실패하면 `upstream_regressed` attention이다. 합치기가 충돌하면 지금 묻지 않고 그 Goal의 merge 때 `MergeConflict`로 다룬다.
- 파일 겹침: 카드를 배정하기 전에 `boundaries`를 다른 Goal의 카드와 비교한다. 다른 Goal에서 실행·검증 중인 카드와 겹치면 그 카드가 먼저다. 이 카드는 미루고, 두 보드에 알림을 남긴다. 아직 merge되지 않은 다른 Goal의 done 카드와 겹치면 순서를 정할 수 없으므로 `FileOverlap`(선택지 wait·proceed, 둘 다 카드를 ready로)을 묻는다. key는 `file_overlap:<otherGoal>`다.
- 모든 카드가 끝났을 때의 채팅 알림은 "merge queue에 넘겼다"는 내용으로 바꿨다. 모델이 직접 merge하지 않는다.
- `closeSuperseded`: 채팅 도구의 직접 `startNewGoal` 경로에서도 부른다. 새 Goal 요청 승인 경로, 루프가 pointer 변경을 발견하는 경로와 함께, Goal pointer가 새 instance로 바뀌는 모든 경로에서 이전 Goal의 대기 판단을 닫는다.
- 설정: `GET/POST /api/settings/kanban`(동시 실행 수 1~32, null이면 기기 기본값), `GET/POST /api/projects/:project/kanban`(보호 브랜치 목록, 빈 목록이면 모든 브랜치에 자동 merge). 우선순위·의존은 세션 칸반 API의 `SetPriority`·`SetDependencies` 액션이다. 설정 화면은 "실행 › 칸반 실행", 보드는 Goal 스케줄 패널에서 바꾼다.
- 칸반이 아닌 Goal은 스케줄러·merge queue에 등록하지 않으므로 동작이 그대로다.

### 칸반 전체 흐름 검증에서 정한 것 (2026-10-18)

- verify 판정은 판정을 시작할 때의 카드에 대한 것이다. 판정이 끝났을 때 카드가 verify를 떠났거나(Amend·변경 요청 Apply) Goal 변경 hold가 걸렸으면 통합하지 않는다. 카드는 다시 실행되거나 hold가 풀린 뒤 다시 검증된다.
- 카드 메모(사람의 답, Amend·변경 요청)는 attempt workflow를 시작한 뒤에 ladder에서 지운다. 지울 때는 payload로 보낸 만큼만 지워 그사이 더해진 메모를 남긴다. 재시작 recover는 시작하지 못한 attempt를 저장된 메모와 함께 제출하고 메모를 지우지 않는다. 메모가 두 번 전달될 수는 있어도 잃지 않는다.
- 상세 검증 범위와 알려진 한계: [kanban-orchestration.md](kanban-orchestration.md) "전체 흐름 검증", "알려진 한계".

### 드래그는 의도, 상태는 서버 (2026-10-18)

- 화면의 카드 이동과 백엔드의 상태 전이는 다른 개념이다. 보드는 드롭을 사용자 의도 하나로 바꿔 보내고, 카드 상태는 owner만 정한다. 의도: `Reorder(cardId, at)`·`Requeue`·`Hold`·`Release`·`ChangeRequest(cardId, patch)`·`Cancel`(`BoardIntent`, `POST /api/sessions/:session/kanban`). 처리(`KanbanBoardActions.applyIntent`)는 기존 `editBoard`·`transitionCard`·`requeue`·`moveCard` 경로를 재사용한다. 의도가 카드 상태에 맞지 않으면 리터럴 reason으로 거절한다(`card_not_blocked`·`card_not_running`·`card_not_waiting`·`card_held`·`card_not_held`·`reorder_across_columns` 등, 409).
- 드롭 → 의도 매핑은 UI가 한다. 같은 열 = Reorder(카드 순위 = Plan 순서 = Goal 안 배정 순서, Goal 사이 round-robin은 그대로). 준비→백로그 = Hold, 보류 카드→준비 = Release, 막힘→준비 = Requeue(dead-letter면 같은 큐 item을 다시 열고, 아니면 실패 기록을 지우고 ready로). 진행 중 카드를 다른 열에 놓으면 이동하지 않고 수정 요청 작성을 묻는다. 진행 중·검증·판단 필요·완료·막힘 열로 놓는 것, 판단 필요·검증·완료 카드를 끄는 것은 매핑이 없어 드래그 중 비활성과 이유를 보인다. 판단 필요 카드는 판단 응답으로 처리한다.
- Reorder·ChangeRequest·Cancel은 어느 보드에서나, Requeue·Hold·Release는 카드를 배정하는 칸반 루프가 있을 때만 받는다(`not_kanban`).
- 낙관적 표시는 "요청 중" 표시일 뿐이다. 카드를 예상 위치에 요청 중 배지와 함께 두고, 응답 뒤 서버 보드로 다시 그린다. 거절되면 원위치와 알림.
- 보류: 카드 속성 `PlanStep.hold { by: BoardAuthor, at }`. 보류 카드는 의존이 끝나도 backlog에 남고(`notStartedStatus`), 루프는 ready 카드만 배정하므로 큐에 들어가지 않는다. Release하면 의존을 다시 따른다. 시작하지 않은 카드(backlog·ready)만 보류한다. 상태 이동처럼 Plan 버전은 그대로 두고, board revision에 작성자와 함께 남는다. 같은 id로 replan하면 계약 필드처럼 유지되고, Plan과 함께 저장되므로 재시작 뒤에도 유지된다. 상태 값이나 ladder 속성 대신 Plan 속성으로 둔 이유: backlog/ready를 정하는 곳(`notStartedStatus`)과 루프의 배정 기준(ready)이 이미 Plan이라 한 곳에서 판단되고, 보드·모델 텍스트·이력에 같은 값이 보인다.
- 사용자 전이 표(`userCardTransitions`)는 두지 않는다. 내부 전이는 `cardTransitions`가 계속 강제한다.

### 칸반 보드 화면 (2026-10-18)

- 채팅 안에는 요약(완료 진행률·열별 카드 수·판단/변경 요청 대기)만 두고, 보드는 전체 폭 Sheet로 연다(`?board=1`, btw 패널과 같은 query 상태 방식). 카드 상세·편집·판단 응답은 오른쪽 peek Sheet(`?card=…`, inbox 링크와 같은 키)에서 하고 Esc로 닫는다.
- Linear 이슈 보드와 비슷하게 동작한다: 7개 열을 한 화면에(좁은 화면은 열 단위 가로 스냅), 열 헤더(상태 아이콘·이름·수) 고정과 열별 세로 스크롤, 열 접기(브라우저별 저장), 간결한 카드(식별자·제목·상태 아이콘·위험·보류·대기·의존 수·작성자 아바타), 드래그 오버레이와 열 하이라이트, 놓을 수 없는 열은 흐리게 하고 이유 표시, 오케스트레이터 이동은 애니메이션 없이 반영.
- 드래그는 dnd-kit(core 6.3.1·sortable 10.0.0·utilities 3.2.2). 마우스(5px)·터치(250ms 누름)·키보드(카드 손잡이에서 Space/Enter로 집고 화살표로 옮김)를 지원하고 스크린 리더 안내를 한국어로 낸다. 카드 자체의 Enter/Space는 peek를 열고, j/k/h/l·화살표는 카드 사이 포커스를 옮긴다. Base UI Dialog popup이 화살표 키 전파를 막으므로 키보드 드래그 중 화살표는 보드가 document로 넘긴다. 드래그 중 Esc는 카드만 되돌리고 보드는 닫지 않는다.

### 칸반을 SqlClient 전환 뒤의 main 위로 옮김 (2026-10-18)

- 사용자 결정: 슬라이스 커밋을 하나씩 rebase하지 않고 칸반 변경 전체를 main(SQL·worker·node:* 전환 완료) 위로 한 번에 옮긴다. 칸반 동작·결정은 바꾸지 않는다.
- 칸반 저장소(보드 조회 `Boards`, `human_decision` 닫힘 기록·inbox, Workflow의 작성자 기록·보드 변경 요청·보류·전이)는 공유 `SqlClient`로 쓴다. 한 세션의 보드 쓰기는 `Workflows`의 세션별 직렬화와 `withTransaction` 하나로 커밋되고, 변경 요청 id는 `RETURNING id`로 받는다.
- 저장소 실패는 오류 채널에 남긴다. `Boards.view`와 `Workflows`의 칸반 경로는 `WorkflowStorageError`, `HumanDecisions`의 저장소 실패는 `KanbanStorageFailed("decision")`다. 카드 큐 handler는 `WorkflowStorageError`를 `KanbanStorageFailed("card")`로 바꿔 큐 오류 스키마에 맞춘다. 답을 카드에 반영하는 durable activity와 `HumanDecisionExecution`은 `WorkflowStorageError`를 오류 스키마로 가진다(전에는 동기 throw로 defect였다).
- 기기 코어 수와 기본 worktree 위치의 홈 폴더는 `runtime/host-system.ts`의 Effect 값(`availableCores`, `homeDirectory`)으로 읽는다.

### 칸반 typed error와 오류 코드 (2026-10-18)

- 칸반 Effect의 예상 실패는 오류 채널에 남긴다. 저장소 오류(`KanbanStorageFailed`, `GoalScheduleStorageFailed`)는 리터럴 reason `Storage`(SQL·행 디코드, cause 보존)·`Encode`(owner가 만든 값의 인코딩)·`Missing`(방금 저장하거나 읽은 기록이 없음)을 가진다. 예전 `orDie`·`Effect.die`가 이 reason으로 바뀌었다. 판단 답의 카드 이동이 실패하면 `Effect.ignore`로 삼키지 않고 `WorkflowStorageError`로 돌려준다(답은 저장돼 있고 카드는 `human_decision`에 남는다). 보호 브랜치 이름이 틀리면 `GoalScheduleRefused("invalid_branch")`, 동시 실행 수가 범위 밖이면 `KanbanSettingsRefused("concurrency_out_of_range")`다.
- `die`로 남기는 기준: 오류 채널이 없는 곳만 남긴다. 큐 item 정산(`persisted-queue-store.ts`의 `settle`)은 store 계약상 실패할 수 없는 Scope finalizer라 로그를 남긴 뒤 `orDie`한다. 행은 이 owner가 잡은 채로 남고 다음 시작 때 풀린다.
- 백그라운드 단계(보드 한 번 보기, 카드 통합, merge queue 단계)는 typed 실패만 끝내고 다음 보기에서 다시 한다(`stopLogged`). 결함과 interruption은 덮지 않는다. 결함은 로그를 남기고 그 fiber의 exit에 남으므로, 결함이 난 보드 루프는 멈추고 owner 재시작이나 `Start`로 다시 돈다. 로그에는 오류 태그만 남기고 cause(경로·명령 출력·SQL)는 남기지 않는다.
- 카드 보류 사유(`kanban_cards.reason`)와 실패는 닫힌 태그 유니온이다(`kanban/failures.ts`): `CardHoldReason`(RetryBackoff·ReplanRequested·RepeatedFailure·MergeConflict·UncertainEffect·DeadLettered·GoalChanged·UpstreamRegressed), `CardFailure`(Agent{code}·Worktree{reason}·Verification{verdict}·GoalBranchKeptMoving·Defect), `VerdictFailure`(Rejected{note}·NoVerdict·NotFinished·ModelSelectionRequired·Unavailable). 알 수 없는 원인은 `Defect` 하나로 모은다. 모델이 쓴 문장(검증 의견, Goal 변경 판단)은 `note`에만 두고 분기에 쓰지 않는다. 보드는 태그로 문구를 고르고 note는 "검증 의견"으로 따로 보인다. `reason.startsWith(...)` 분기는 태그 비교로 바꿨다. 칸반은 GitHub 릴리즈 전이라 컬럼 의미만 바꾸고 마이그레이션은 두지 않는다. `GoalMergeState.VerifyFailed`도 `verdict: VerdictFailure`를 가진다.
- 칸반 route(`/api/sessions/:session/{kanban,board,decisions}`, `/api/projects/:project/{kanban,decisions}`, `/api/settings/kanban`)는 `.server/kanban-failures.ts`의 표 하나로 태그·reason을 HTTP 상태와 코드로 바꾼다. 표에 없는 오류 타입이 오류 채널에 있으면 타입 오류다. 응답에는 코드만 싣고 cause는 싣지 않는다.

| 오류(태그·reason)                                                    | 상태        | 코드                                      |
| -------------------------------------------------------------------- | ----------- | ----------------------------------------- |
| `SessionNotFound`, `ProjectNotFound`                                 | 404         | `session_not_found`, `project_not_found`  |
| `KanbanActionRefused`, `BoardEditRefused`, `KanbanStartRefused`      | 409         | 각 reason                                 |
| `GoalScheduleRefused` (`invalid_branch`)                             | 400         | `invalid_kanban_settings`                 |
| `GoalScheduleRefused` (그 밖)                                        | 409         | 각 reason                                 |
| `HumanDecisionRefused`                                               | 404·400·409 | 각 reason (전과 같음)                     |
| `PlanDependenciesRejected`                                           | 422         | `plan_dependencies_rejected`              |
| `PersistedQueueItemsFailed` (`NotFound`·`NotDeadLettered`)           | 409         | `queue_item_changed`                      |
| `CardWorktreeFailed` (`InUse`)                                       | 409         | `worktree_in_use`                         |
| `KanbanSettingsRefused`, 요청 본문 읽기 실패                         | 400         | `invalid_kanban_settings`, `invalid_json` |
| `CardWorktreeFailed` (그 밖)                                         | 500         | `worktree_failed`                         |
| `KanbanStorageFailed`, `PersistedQueueItemsFailed` (`StorageFailed`) | 500         | `kanban_storage_failed`                   |
| `WorkflowStorageError`                                               | 500         | `workflow_storage_failed`                 |
| `GoalScheduleStorageFailed`                                          | 500         | `schedule_storage_failed`                 |
| `GlobalConfigFailed`                                                 | 500         | `settings_failed`                         |
| `SqlError`·`SchemaError`(세션·프로젝트 조회)                         | 500         | `storage_failed`                          |
| `PlatformError`(카드 id 생성)                                        | 500         | `platform_failed`                         |

- 보드·판단·설정 화면은 응답 코드(`ApiError.code`)로 문구를 고르고, 오류를 문자열로 바꿔 보이지 않는다.

## 기억·검색·평가

### 기억 보강: llm-interpret (2026-09-14)

- 사용자, assistant 발언만 해석한다. 도구 결과, 문서는 증거일 뿐 주장이 아니다.
- 해석은 답변이 끝난 뒤 백그라운드에서 한다(인덱싱 다음). 가장 최근에 대기 중인 발언이 있는 세션부터(그 안에서는 오래된 순) 처리해, 밀린 옛 발언보다 방금 대화가 먼저 반영되게 한다. 사용자가 고른 모델을 가장 낮은 추론 강도로, 도구 없는 일회용 스레드에서 부른다. 한 번에 세션 하나의 발언 최대 8개, 실행당 5묶음까지만 해서 밀린 작업이 모델을 오래 쓰지 않게 한다. 로그인, 모델 선택 전에는 기다리고, 실패는 3번까지 다시 한 뒤 `failed`로 둔다. 검색은 해석과 무관하게 동작한다.
- 결과: 주제(프로젝트마다 이름이 같은 `topic` 노드 하나, `about` edge), `corrects`, `retracts`, `related` edge. 모델은 코드가 건넨 후보 발언(같은 세션 최근 발언 + 같은 프로젝트 검색 결과, 해당 발언보다 앞선 것만) 안에서만 연결할 수 있다.
- 권위: 정정과 취소는 사용자 발언에서만 만든다. assistant가 "사실은 이렇다"고 해도 사용자 결정을 바꾸지 않는다.
- 모호한 대상은 확인(R07): 대상이 분명하면 edge로 반영하고, 분명하지 않으면 edge를 만들지 않고 `interpretations`에 `unconfirmed`로 남긴다. `find_memory`(`unconfirmedChallenges`)와 `trace_evidence`(`unconfirmed`)가 보여주고, 모델은 사용자에게 묻는다.
- 자동 해석과 확정을 구분한다: 모든 해석은 이유, 모델과 함께 `interpretations`에 남고 edge의 origin은 `llm`이다. 원문만 증거이며, 아직 해석되지 않은 발언 수(`uninterpreted`)를 검색 결과에 함께 준다. 정정이 없다는 것이 정정 부재의 증거가 아니다.
- (2026-10-14 "기억 범위"로 대체: 기본 끔) 교차 프로젝트 회상(R08): 기본 켬. 사이드바의 "다른 프로젝트에서 이 기억 찾기" 스위치로 프로젝트마다 끈다(끄면 다른 프로젝트 대화에서 이 프로젝트 기억을 검색하지 않음). 결과에는 출처 프로젝트 이름을 붙이고, 다른 프로젝트 기억은 여기서의 승인, 권한이 되지 않는다고 모델 지침에 적는다.
- PRD의 TopicModelRevision(주제 모델 개정 이력)은 두지 않는다. 주제는 이름으로만 합쳐지고, 잘못 붙은 주제는 원문 증거보다 약한 단서로만 쓰인다.

### 기억 (2026-09-15)

- 근거를 추적할 수 있도록 사용자, assistant, tool call, tool result를 모두 수정 불가 노드로 저장한다.
- 채팅은 그래프 구조를 가진다: 저장 시 구조 edge(`next`, `reply`, `calls`, `returns`, `touches`), 이후 LLM 해석(`llm-interpret`)으로 의미 edge(about, corrects, retracts, related)를 보강한다.
- 검색은 turbovec 벡터 순위 + SQLite FTS trigram 순위 + Kiwi 형태소 순위(아래 "Kiwi 형태소 검색")를 RRF(k=60)로 합친 뒤 그래프를 탐색한다.
- 벡터 검색은 허용된 프로젝트의 인덱싱된 노드 ID만 turbovec 후보로 넘겨 순위를 매긴다(2026-09-25). 전체 인덱스의 상위 k개를 뽑은 뒤 프로젝트를 걸러내면 다른 프로젝트의 벡터가 결과 자리를 차지해 허용된 기억을 놓친다.
- 임베딩은 로컬 모델 `ibm-granite/granite-embedding-97m-multilingual-r2`의 quint8 파일(CLS pooling)이다. 한 노드는 앞 2048토큰까지 임베딩하고, 배치는 토큰 길이로 나눈다(아래 "메모리"). 모델 파일은 `~/.context-generactive-agent/models`.

### Kiwi 형태소 검색 (2026-09-15)

- 기억 검색에 세 번째 순위를 더한다: Kiwi(kiwi-nlp 0.24.0 WASM, cong base 모델)로 뽑은 검색어를 `nodes_morph`(FTS5 unicode61)에 넣고 BM25로 순위를 매겨, 벡터, trigram 순위와 함께 RRF로 합친다. 조사와 어미가 달라도("로그 형식을 정했었지" ↔ "로그 포맷은 … 정했습니다") 같은 명사와 어간으로 만난다.
- 검색어: 일반명사와 고유명사, 수사, 동사와 형용사 어간, 어근, 한자. `하`, `되`, `있`, `없`, `어떻` 같은 거의 모든 문장에 나오는 어간은 뺀다. 띄어 쓰지 않은 명사 연속은 합친 말도 넣는다("데이터 베이스" → "데이터베이스"). 라틴 문자와 숫자는 Kiwi가 가끔 이상하게 자르므로("Grafana" → "Gr"+"afana") 원문에서 직접 뽑는다.
- 모델(압축 해제 104 MB)은 처음 필요할 때 GitHub 릴리스에서 받아 sha256을 확인하고, 경로 검사 후 임시 디렉터리에 풀어 `<저장 루트>/models/kiwi-0.24.0`으로 옮긴다.
- Kiwi는 worker thread에서 돌고, 처음 쓸 때 띄운 뒤 계속 둔다. 모델을 만드는 순간 약 900 MB까지 오르고 약 240 MB로 내려앉는다(macOS physical footprint). 요청이 없는 worker는 프로세스를 붙잡지 않는다. 쉬는 worker를 끝내는 방식은 메모리가 줄지 않아 뺐다(아래 "메모리").
- 검색은 Kiwi 적재를 기다리지 않는다. 아직 준비되지 않았으면 적재를 시작하고 형태소 순위 없이 검색하며 `degraded`에 `morph`를 넣는다. 분석은 답변이 끝난 뒤 임베딩 인덱싱 다음에 백그라운드로 하고, 노드마다 분석기 identity를 기록해 한 번만 한다.
- 평가: `packages/memory-agent/eval/recall.ts`(`vp run eval:recall`). 한국어 발언 45개(9개 대화, 겹치는 낱말이 있는 방해 발언 포함)와 조사와 어미, 낱말을 바꾼 질문 32개. 실제 granite 임베딩 + 실제 Kiwi:

  | 구성                  | top-1 | top-3 | top-5 |   MRR |
  | --------------------- | ----: | ----: | ----: | ----: |
  | 벡터 + trigram        | 24/32 | 29/32 | 31/32 | 0.832 |
  | 벡터 + trigram + Kiwi | 25/32 | 29/32 | 30/32 | 0.852 |
  | trigram               | 14/32 | 19/32 | 20/32 | 0.526 |
  | trigram + Kiwi        | 21/32 | 27/32 | 29/32 | 0.760 |

- 해석: 임베딩이 있으면 이 세트에서 이득은 작다(질문 1개 차이). 임베딩 모델을 아직 받지 못했거나 적재 중이거나 적재에 실패한 동안에는 크게 좋아진다. 뜻이 같고 낱말이 다른 질문("주 DB" ↔ "메인 데이터베이스", "되돌리는 방법" ↔ "롤백")은 여전히 임베딩 몫이다.
- 형태소 순위가 있을 때 trigram 순위를 빼는 안(MRR 0.857)도 쟀지만 차이가 질문 하나 수준이고, trigram은 코드 식별자, 경로의 부분 문자열을 찾으므로 셋을 모두 쓴다.
- Kiwi 색인을 유지한다(2026-09-15). 메모리(약 240 MB)를 줄이려고 검토한 대안은 모두 색인보다 낮았다. quint8 임베딩 기준으로는 Kiwi 없이 0.814, 있으면 0.831이다.
  - 벡터가 빠질 때만 켜기: 그 순간 색인이 없어 모든 발언을 분석해야 하고, 벡터가 통째로 빠지는 경우(모델을 받거나 올리지 못함)는 Kiwi 모델도 받지 못하기 쉬우며, worker를 끝내도 메모리가 돌아오지 않아 택하지 않았다.
  - 벡터 없이 잰 대안: 질문만 Kiwi 검색어로 바꿔 trigram에 넘기기 MRR 0.703, 모델 없이 규칙으로 조사만 떼기 0.665(색인 0.760, trigram만 0.526).
  - WASM SIMD: kiwi-nlp 0.24.0이 최신이고, Kiwi의 WASM 빌드는 SIMD 없는 `ArchType::none`만 넣는다. 양자화 커널은 SSE4.1 이상, NEON에만 있어 cong 모델은 불러올 때 실수형으로 풀린다(시작 때 "Quantization is not supported" 경고, 결과는 같음).

### 메모리 (2026-09-15)

- 측정은 `packages/memory-agent/eval/memory.ts`(`node --expose-gc --no-warnings eval/memory.ts`)로 한다. 시나리오마다 새 프로세스를 띄워 macOS physical footprint(`footprint`)를 잰다. RSS는 해제된 메모리가 남아 보이고, 메모리가 부족할 때 수백 MB씩 흔들려 쓰지 않는다.
- 임베딩 순간 최대치를 막는다. 배치는 가장 긴 텍스트 길이로 채워지고, 어텐션 메모리는 길이의 제곱으로 는다. 예전 설정(최대 8192토큰, 16개씩)에서는 긴 도구 결과 하나가 16 × 8192토큰 계산을 만들 수 있었다(4096토큰 하나가 이미 +650 MB).
  - 한 노드는 앞 2048토큰까지만 임베딩한다. 원문 전체는 노드, trigram 검색, Kiwi 검색에 그대로 남는다.
  - 텍스트를 길이순으로 정렬하고, 배치를 개수 16 이하, 개수 × 가장 긴 길이² ≤ 2048²로 나눈다. 짧은 글 16개는 한 배치, 긴 글은 혼자다. 결과는 원래 순서로 돌려준다.
  - ONNX CPU 메모리 arena를 끈다. 한 배치의 최대 할당을 다음 배치까지 붙잡지 않게 하기 위해서다.
  - 측정: 긴 글 1개 + 짧은 글 15개가 fp32 기준 최대 약 2.1 GB, quint8 기준 약 1.3 GB로 묶인다.
- quint8을 기본 임베딩 모델로 쓴다. 같은 모델이 공개한 `onnx/model_quint8_avx2.onnx`다.

  |                                   |    fp32 | quint8 |
  | --------------------------------- | ------: | -----: |
  | 짧은 글 16개 최대 footprint       | 1787 MB | 756 MB |
  | 회상 평가 MRR (벡터+trigram+Kiwi) |   0.852 |  0.831 |
  | 회상 평가 top-3                   |   29/32 |  29/32 |
  | 인덱싱 시간(45문장)               |   3.5초 |  2.7초 |
  - 받는 파일도 390 MB에서 98 MB로 준다. 임베더 identity가 바뀌어 기존 벡터는 다시 인덱싱된다.
  - quint8은 활성값 양자화 범위를 배치마다 정한다. 그래서 같은 문장도 함께 묶인 문장에 따라 벡터가 조금 달라진다(코사인 약 0.986). 검색 순위에는 영향이 작다.

- 쉬는 동안 모델을 내리는 방식은 쓰지 않는다. 측정 결과 메모리 회수 효과가 작거나 없었다.
  - 같은 프로세스에서 세션을 해제하면 quint8 기준 약 40 MB만 돌아왔다. 다시 로드할 때마다 약 12 MB씩 늘었다.
  - worker thread에서 돌리고 끝내도 fp32 1726 → 1170 MB, quint8 702 → 621 MB였다. onnxruntime의 네이티브 메모리가 프로세스에 남는다. Kiwi worker는 끝내도 줄지 않았다(234 → 234 MB).
  - 그래서 임베딩 모델과 Kiwi는 한 번 띄우면 계속 둔다. 쉬는 동안 메모리를 실제로 돌려받으려면 모델을 별도 프로세스로 띄워야 한다. 후속 과제로 둔다(시작 1-2초와 IPC가 늘어난다).

### 임베딩 worker thread (2026-09-16)

- 임베딩 모델(transformers.js)은 Kiwi처럼 서버 프로세스 안의 worker thread(`embed-worker.ts`)에서 돌린다. 처음 임베딩할 때 띄우고 계속 둔다. 별도 프로세스로 옮기지는 않는다.
  - onnxruntime-node(1.24.3)의 `run`은 `setImmediate` 안에서 네이티브 추론을 동기로 부른다. 메인 스레드에서 돌리면 배치 하나가 도는 동안 HTTP 요청이 모두 기다린다.
  - 실측: 가져오기가 켜진 서버를 시작하자 밀린 노드 약 1,140개를 한 번에 임베딩했고, 그동안 메인 스레드가 약 74초 동안 추론에 묶였다. 설정 API가 6-21초 걸렸고, 임베딩이 끝난 뒤에는 3-50ms였다.
  - 같은 300개(약 2,000토큰짜리 30개 포함)를 임베딩할 때 이벤트 루프 지연 p99가 637ms에서 13ms로 줄었다. 걸린 시간은 같다(약 20초).
  - worker는 토큰 수 세기와 배치 임베딩(정규화 전 CLS 행)만 맡는다. 배치 나누기와 정규화는 메인 스레드의 `planBatches`, `normalize`가 한다. 모델 적재가 실패하면 worker를 끝내고, 다음 요청이 새 worker로 다시 시도한다.
  - worker 스크립트 위치는 `runtimeWorker`가 정한다. 저장소에서는 package exports(`memory-agent/embed-worker`, `memory-agent/kiwi-worker`), 실행 파일에서는 runtime 폴더다. `scripts/package.ts`가 두 스크립트를 runtime 폴더에 복사한다.

### 임베딩 실행 방식 고르기 (2026-09-16)

- 메모리 여유에 따라 임베딩 장치를 고른다. 실행 방식은 `자동`(기본), `CPU`, `GPU` 중 하나로, 전역 설정(`config.json`의 `embeddingDevice`)에 둔다.
  - CPU 모드: quint8 모델을 CPU에서 돌린다(전과 같음).
  - GPU 모드: fp32 원본 모델을 WebGPU에서 돌리고, WebGPU가 안 되면 같은 fp32를 CPU에서 돌린다. 벡터는 어느 쪽이든 같다(코사인 0.9999 이상).
  - 자동: 물리 메모리가 16GB 이상이고 WebGPU 확인에 성공했으면 GPU 모드, 아니면 CPU 모드다.
- WebGPU 확인은 한 번만 하고 기억한다(`gpuCheck`: 성공/실패, 시각, 실패 이유). fp32 모델을 따로 worker에 올려 짧은 텍스트를 한 번 돌려 본다. 처음이면 모델(약 390MB)을 내려받는다. 이 기기에서 약 5초 걸렸다.
  - 시작할 때 확인하는 경우: 확인 결과가 없고, `GPU`를 골랐거나 `자동`이면서 메모리가 16GB 이상일 때. 백그라운드에서 돌아 시작을 막지 않는다.
  - 설정의 "다시 확인"으로 드라이버나 하드웨어가 바뀐 기기에서 다시 볼 수 있다.
  - 로컬 모델이 아닌 임베더(테스트, 평가)에서는 확인하지 않는다.
- 바꾼 방식은 다음 시작부터 적용한다. 실행 중인 worker와 벡터 인덱스를 갈아 끼우지 않는다.
  - 두 모드는 모델이 달라 임베더 식별자(`…@quint8/…`, `…@fp32/…`)가 다르고, 벡터 인덱스와 `node_vectors`도 식별자별로 따로다. 새 모드로 처음 시작하면 벡터를 처음부터 만들고(그동안 글자 검색과 형태소 검색은 된다), 되돌리면 전에 만든 것을 이어 쓴다.
  - worker는 처음 적재가 끝나면 실제로 쓴 장치를 알려 준다(`loaded`). 설정 화면은 이것으로 "GPU 모드지만 CPU에서 도는 중"을 구분한다.
- 설정의 "기억" 탭에 보이는 것: 고른 방식, 지금 도는 방식과 장치, 다음 시작 때의 방식(다르면 안내), 메모리와 기준, WebGPU 확인 결과, 아직 임베딩하지 않은 노드 수. 확인 중이거나 남은 노드가 있으면 3초마다 다시 묻는다. API는 `GET/POST /api/settings/embedding`(`choose`, `check`)이다.
- 실제 앱에서 확인(2026-09-17): 메모리 16GB 기기에서 자동으로 두고 다시 시작하자 GPU(WebGPU) 모드로 임베딩했다.

### 대량 쓰기와 FTS trigram 색인 (2026-09-17)

- SQLite 연결마다 페이지 캐시를 64MiB까지 쓴다(`PRAGMA cache_size = -65536`, 기본 2MiB). 대량 쓰기의 대부분은 FTS trigram 색인 갱신이고, 이 갱신이 색인 페이지를 많이 읽고 다시 쓴다. 캐시는 상한이라 쓰는 만큼만 메모리를 차지한다.
  - 실측(이 기기의 실제 노드 텍스트로 새 DB에 200개씩 쓰기, 노드 입력, edge, 가져오기 표시 포함):

    | 노드  | 텍스트 | 기본(2MiB) | 16MiB  | 64MiB  |
    | ----- | ------ | ---------- | ------ | ------ |
    | 1.2만 | 16.5MB | 8.96초     | 7.35초 | 7.27초 |
    | 4만   | 54.3MB | 32.1초     | 26.9초 | 25.9초 |

  - 같은 조건에서 FTS를 빼면 쓰기는 노드 6000개에 0.3초(FTS 포함 5.1초)다. 쓰기 비용의 94%가 trigram 색인이다.
- 살펴보고 바꾸지 않은 것(노드 6000개, 텍스트 12.9MB 기준):
  - `detail=none`/`detail=column`: 쓰기 −30-36%, DB 크기 −40-54%. 대신 구문 검색(3글자 넘는 검색어)이 안 된다. LIKE로 찾으면 결과 집합은 같지만, 순위를 매기려고 전부 모으면 검색이 20-40ms로 지금(1.5-2.5ms)보다 10-25배 느리고, bm25를 못 써서 상위 20개가 지금과 32%만 겹친다.
  - FTS5 `automerge=0`(−17%, 병합을 미룰 뿐이고 조각이 쌓임), `hashsize` 16MiB(−8%), `crisismerge` 64(−6%), `pgsz` 8000(−7%): 효과가 작거나 측정 잡음 수준이다.
- 색인할 텍스트 길이 상한(검토 후 보류, 아래 "글자 검색이 맡는 일"). 앞 2만 자만 색인하면 쓰기 −35%(DB 크기 −24%), 8천 자면 −44%(−31%)다. 실제 DB에서 2만 자를 넘는 노드는 147개(대부분 도구 결과, 최대 50만 자)이고, 넘는 부분이 텍스트의 24%(8천 자 기준 366개, 39%)다. 그 뒷부분은 글자 검색으로 찾을 수 없게 된다(임베딩은 이미 앞 2048토큰만 본다).

### 글자 검색(trigram)이 맡는 일 (2026-09-17)

- trigram 색인을 빼거나 줄이기 전에, 벡터만 쓰는 구성과 코드 작업 기록을 묻는 질문을 평가에 더해 쟀다. `MemorySearch.withoutText`는 글자 순위(trigram, 2글자 부분 문자열)를 끈 검색으로, 평가에서만 쓴다.
- 회상 평가(`vp run eval:recall`, MRR). 기술 세트(`eval/recall-technical.ts`)는 도구 결과, 파일 내용, 명령 28개와 질문 27개다. 식별자를 그대로 묻는 질문, 한국어로 풀어 묻는 질문, 임베딩이 읽는 앞 2048토큰 뒤에 답이 있는 긴 로그를 섞었다.

  | 구성                          | 결정 문장 | 기술 기록 |
  | ----------------------------- | --------: | --------: |
  | 벡터 + trigram + Kiwi         |     0.852 |     0.938 |
  | 벡터 + Kiwi                   |     0.857 |     0.898 |
  | 벡터                          |     0.870 |     0.898 |
  | 벡터(quint8) + trigram + Kiwi |     0.836 |     0.943 |
  | 벡터(quint8) + Kiwi           |     0.833 |     0.900 |
  | trigram + Kiwi                |     0.760 |     0.790 |
  | Kiwi                          |     0.794 |     0.741 |
  - 뜻으로 묻는 결정 문장은 벡터만으로 가장 높다. 기술 세트에서 trigram이 보탠 것은 주로 긴 로그 뒷부분이다(벡터만으로는 찾지 못하거나 4위).
  - 두 세트 모두 발언이 28-45개라 식별자가 겹치는 방해물이 적다.

- 실제 기억에서 식별자로 찾기(이 기기의 DB 복사본, 노드 1.35만 개, quint8 벡터와 Kiwi 색인 그대로). 도구 결과, 도구 호출, 답변에서 식별자 모양의 문자열(글자로 시작, 숫자, `_`, `-`, `/` 포함, 6-40자)을 골라, 그 문자열이 든 노드가 3개 이하인 것만 그대로 검색했다. 문자열과 원문은 출력하지 않았다.

  | 구성                  | 앞 4천 자 안 (50개) | 1만 2천 자 뒤 (28개) |
  | --------------------- | ------------------: | -------------------: |
  | 벡터 + trigram + Kiwi |  0.960 (top1 47/50) |    0.589 (top1 8/28) |
  | 벡터 + Kiwi           |               0.403 |                0.134 |
  | 벡터                  |               0.157 |                    0 |
  | trigram + Kiwi        |               0.990 |   1.000 (top1 28/28) |
  | Kiwi                  |               0.781 |                0.232 |
  - 임베딩은 비슷한 도구 출력 수천 개 사이에서 식별자 하나를 거의 가려내지 못한다. 문자열을 기억해서 찾는 검색은 trigram이 맡고, 임베딩이 읽지 않는 긴 출력 뒷부분은 trigram만 찾는다.

- trigram 색인을 유지하고, 길이 상한은 두지 않는 쪽을 권한다. 앞 8천 자나 2만 자만 색인하면 위 "1만 2천 자 뒤" 경우를 대부분 잃는다(벡터, Kiwi로는 MRR 0.13-0.23). 쓰기 비용은 페이지 캐시(위)와 가져오기 worker로 다룬다.
- 드러난 개선 여지: 뒷부분 식별자는 trigram만으로 28개 모두 1위인데, 벡터 순위와 RRF로 합치면 1위가 8개로 줄어든다(top5는 25개). 식별자 모양의 검색어에서 글자 순위를 더 믿게 하는 방안은 따로 잰 뒤 정한다.

### 발언만 임베딩 (2026-09-17)

- 벡터 색인에는 user, assistant, topic 노드만 넣는다(`embeddedKinds`). 도구 호출과 결과는 trigram, 형태소 순위로 찾고, 발언에서 `calls`, `returns` edge를 따라 닿는다(근거 추적은 `trace_evidence`, `read_evidence`).
  - 도구 노드는 이 기기 기억의 85%(1.15만 개)이고, 임베딩 입력(노드당 앞 약 6천 자 기준)의 95%다. 가져오기 뒤 임베딩 대기열이 대부분 사라진다.
  - 실제 기억 복사본 두 벌 비교(검색은 벡터 + trigram + Kiwi, MRR): 식별자로 찾기(앞 4천 자) 0.960 → 0.954, (1만 2천 자 뒤) 0.589 → 0.571, 기억에 섞은 결정 질문 0.639 → 0.673(top5 22 → 25/32), 기억에 섞은 기술 질문 0.741 → 0.722. 이 조건에서 trigram까지 빼면 기술 질문이 0.349로 떨어진다.
- 업그레이드: 마이그레이션이 도구 노드의 `node_vectors` 기록을 지우고, 벡터 색인을 열 때 기록 없는 노드의 벡터를 뺀다. 색인이 DB보다 앞선 경우(저장 뒤 커밋 전에 죽은 경우 포함)는 다시 만들지 않고 빼기만 한다. 실제 DB 복사본: 1.35만 개 → 1983개, 여는 데 0.2초, 재임베딩 없음(전부 다시 만들면 CPU quint8로 57초).
- 격리된 회상 평가(`vp run eval:recall`)에서 결정 세트는 그대로다. 기술 세트(발언 5개, 도구 노드 23개)는 벡터 + trigram + Kiwi가 0.938 → 0.730, 벡터 + trigram이 0.944 → 0.438로 떨어졌다.
  - 원인은 RRF 동점이다. 벡터 목록은 관련이 없어도 늘 k개를 채우므로, 글자 검색 1위인 도구 노드와 벡터 1위인 엉뚱한 발언이 같은 점수가 되고, 합칠 때 먼저 넣은 벡터 쪽이 앞선다(실패 대부분이 "정답 2위, 1위는 무관한 발언").
  - 실제 기억에서는 형태소 순위가 같은 도구 노드를 함께 올려 영향이 작았다(위 0.741 → 0.722). 벡터 순위의 유사도 하한이나 동점 처리를 따로 재서 정한다.

### 무언가를 정확히 가리키는 검색어 (2026-09-17)

- 검색어가 에러 코드, 경로, 파일 이름, 식별자, 버전, 해시, 포트를 담으면 trigram 순위를 앞에 두고 가중치 2로 합친다(`namesSomethingExactly`, `searchTuning.exactTextWeight`). 다른 검색어는 전처럼 벡터, trigram, 형태소를 같은 비중으로 합친다.
  - 벡터 순위는 관련이 없어도 k개를 채운다. 발언만 임베딩한 뒤로는 도구 출력이 벡터 순위에 없어서, 식별자로 찾은 도구 출력(글자 1위)이 가까운 발언(벡터 1위)과 동점이 되거나 밀렸다.
  - 판별: 공백으로 나눈 낱말 중 하나라도 글자나 숫자 사이에 `_`, `-`, `.`, `/`, `:`, `@`가 있거나, camelCase이거나, 글자와 숫자가 섞였거나, 5자 이상 대문자이거나, 3자리 이상 숫자면 해당한다. 평가의 결정 질문 32개는 하나도 해당하지 않고, 기술 질문은 식별자 질문 19개만 해당한다.
- 같은 실제 기억 복사본에서 한 번에 비교했다(quint8, Kiwi 포함, MRR과 1위 수). 기억에 섞은 결정 질문과 기술 질문은 모든 조합에서 같거나 거의 같았다.

  | 구성                      | 식별자, 앞 4천 자 | 식별자, 1만 2천 자 뒤 | 격리 기술 세트 |
  | ------------------------- | ----------------: | --------------------: | -------------: |
  | 전(벡터 먼저, 같은 비중)  |        0.960 (46) |            0.663 (14) |          0.711 |
  | 글자 먼저, 가중치 1       |        1.000 (50) |            0.982 (40) |          0.731 |
  | 글자 먼저, 가중치 2(채택) |        1.000 (50) |            0.988 (40) |          0.741 |
  | 글자 먼저, 가중치 3       |        1.000 (50) |            0.988 (40) |          0.741 |
  - 식별자 항목은 앞 4천 자 50개, 1만 2천 자 뒤 41개다. 기억이 늘어서 앞선 측정과 개수가 다르다.
  - 모든 검색어에서 글자를 앞에 두면 기억에 섞은 결정 질문이 0.673에서 0.536으로 떨어져서(다른 실행), 식별자 검색어로 한정했다. 가중치 3은 기억에 섞은 기술 질문이 0.704에서 0.698로 조금 낮았다.

- 벡터 유사도 하한은 두지 않는다. 맞는 발언의 코사인(중앙값 0.85, 하위 10% 0.76-0.78)과 관계없는 1위(중앙값 0.78-0.83, 상위 10% 0.82-0.86)가 크게 겹친다. 하한 0.82는 격리 세트를 조금 올렸지만(결정 0.799 → 0.820, 기술 0.711 → 0.772) 기억에 섞은 결정 질문을 0.549에서 0.500으로 떨어뜨렸다.
- 회상 평가(`vp run eval:recall`, 세트별 격리): 결정 세트는 그대로다(벡터 + trigram + Kiwi 0.852, quint8 0.836). 기술 세트는 0.730 → 0.759다. 남은 실패 대부분은 도구 출력에만 있는 내용을 뜻으로 묻는 질문 5개로, 발언만 임베딩한 대가다. 실제 대화에서는 보통 답변이 결과를 설명하고, 그 답변에서 edge로 닿는다.

### 임베딩 동의 사용자의 기억 그래프 자동 정리 (2026-10-02)

> 2026-10-14 대체: 아래 "기억 그래프 자동 정리를 모든 저장소에서"를 본다. 첫째 항목(임베딩 선택을 동의로 간주)과 넷째 항목(세션 간 정정을 `unconfirmed`로 내림)은 더 이상 적용하지 않는다.

- 임베딩 실행 방식을 직접 선택한 기록(`embeddingDevice`가 설정됨)을 자동 정리 동의로 간주한다. 명시적인 `auto` 선택도 포함하며, 기본값을 사용 중인 저장소에서는 실행하지 않는다. 설정 선택 직후와 앱 시작 시 저장소별로 실행한다.
- 기존 데이터는 최초 실행 시점의 `seq` 상한까지 한 번 순회한다. 버전과 커서를 저장하고 64개씩 처리하므로 중단 후 재개하며, 완료된 버전은 반복해서 전체를 읽지 않는다. 사용자의 그래프 상태에 맞춰 해당하는 항목만 수정한다.
- 역방향으로 가져온 도구 결과 근거 연결을 바로잡고, 빈 발화의 의미 연결을 제외한다. 빈 발화 때문에 생긴 토픽 중 다른 근거·사용자 기억·참조가 없는 토픽만 검색에서 제외한다. 원문 노드와 변경 전 연결·해석 상태는 보존한다.
- 기존 세션 간 `corrects`·`retracts` 해석은 동일한 결정임을 확인할 근거가 없어 `unconfirmed`로 내린다. 새 해석은 같은 프로젝트의 지속적인 결정을 명확하게 변경한 경우에만 세션 간 수정으로 적용한다.
- 정상 벡터는 재임베딩하지 않는다. 제외한 토픽의 벡터만 모델별 삭제 큐에 넣고, 현재 모델은 즉시 처리하고 다른 모델은 해당 인덱스를 열 때 처리한다. 파일 저장 후 DB 반영 전에 중단되어도 큐를 먼저 재개해 전체 인덱스 초기화를 피한다.
- 정리는 서비스 scope에 속한 fiber로 실행한다. 중복 실행은 semaphore로 직렬화하고, 인덱싱과 형태소 분석의 잠금은 배치 동안만 공유한다. 배치 사이에는 `Effect.yieldNow`로 다른 작업에 실행 기회를 준다.
- 검색은 의미 없는 노드를 후보 단계에서 제외한다. 빈 도구 호출 등은 그래프 탐색의 연결점으로 통과할 수 있지만 검색 결과에는 포함하지 않고, 탐색 예산에는 포함한다.

### 기억 그래프 자동 정리를 모든 저장소에서 (2026-10-14)

- 자동 정리는 동의 없이 모든 저장소에서 돈다. 남는 정리는 거꾸로 저장된 근거 연결 바로잡기, 빈 발화의 의미 연결 제외, 빈 발화 때문에만 생긴 토픽을 검색에서 빼기뿐이다. 모두 쓸모없는 것만 고치고 원문은 바꾸지 않아서, 끌 이유가 없다.
- 세션 간 `corrects`·`retracts`를 `unconfirmed`로 내리는 일은 하지 않는다. 사용자가 예상하기 어렵고 정정 기록을 숨기는 결과였기 때문이다. 버전 2는 시작할 때 버전 1이 이 이유만으로 내린 해석과 연결을 되돌린다. 출처나 대상이 빈 발화라서 내린 것은 그대로 둔다.
- 새 해석이 세션 간 수정을 적용하는 기준(같은 프로젝트의 지속적인 결정을 명확히 바꾼 경우)은 그대로다.
- 정리는 처음 실행할 때까지 저장된 기억만 한 번 순회한다. 그 뒤에 쓰는 기억은 현재 코드가 이런 결함 없이 쓴다.

### 대체된 파일 읽기를 검색에서 빼기 (2026-10-14)

- 노드 가지치기는 원문 삭제와 검색 제외를 나눈다. 원문은 근거라서 지우지 않고, 쓸모가 끝난 노드를 규칙으로 골라 검색에서만 뺀다. laya는 "이번 턴에 회상이 필요한가"를 판정하는 센서라서 노드별 가치 판정에 쓰지 않는다.
- 첫 규칙: 같은 프로젝트에서 같은 파일을 나중에 다시 읽었는데 sha256이 다르면, 이전 `read_file`·`read_outside_file` 결과를 `memory_graph_suppressed_nodes`(reason `superseded_read`)에 넣는다. 이제 없는 파일 내용이 검색과 그래프 확장에 섞이지 않는다. 내용이 같은 재읽기는 빼지 않는다.
  - 파일은 호출 인자의 ref로 맞추고, sha256은 결과 JSON에서 읽는다. 다른 에이전트에서 가져온 읽기는 sha256이 없어 대상이 아니다.
  - 기록할 때 같은 트랜잭션에서 적용하고, 그 전에 쌓인 기억은 그래프 정리 버전 3이 한 번 순회하며 적용한다.
  - 원문, `read_evidence`, 대화 기록은 그대로다. trigram·Kiwi 행은 물리적으로 지우지 않는다. 검색이 이미 `memory_graph_suppressed_nodes`로 거르고, 행을 지우면 세션 삭제의 FTS `delete`와 겹쳐 색인이 깨질 수 있다. 세션을 지울 때는 이 표의 행도 함께 지운다.
- 다음 후보(아직 하지 않음): 한 번도 조회되지 않았고 의미 연결이 없으며 오래된 노드, 보관한 대화의 사용자 주도 완전 삭제.

### RRSI local experiments (2026-10-05)

- Develop in the independent `context-generactive-agent-rrsi` clone on `feat/rrsi-local`; web 5174, backend 5181 and `.rrsi-local/runtime` are isolated from the original checkout.
- Reuse only the explicitly authorized local model connection and its endpoint-bound key. Do not copy conversation DBs or OAuth accounts. Experiments use the explicitly selected provider/model (OpenAI, Anthropic or any configured OpenAI-compatible endpoint), with no provider fallback. Subscription credentials remain in the host and are pinned for the experiment.
- Profile candidates are automatically adopted only after repeated baseline, cost/quality selection, validation and a once-used sealed suite. Existing Goals keep immutable pins. Code candidates require normal Git/PR review and a restart before adoption; Goal pins version profile configuration, not executable code.
- Evaluation runs the actual chat/memory path with deterministic embedding/morph fixtures in a network-disabled, credential-free Docker container. Host gateway pins the model/account, enforces the execution deadline and records token usage. This does not prove production embedding quality.
- Default automatic budget: 10 min idle, one run/day, 2 rounds with 2 candidates each, 30 minutes with no total token cap. Token usage remains an efficiency metric. Missing usage or incomplete evaluation prevents adoption.

### RRSI 평가 실패와 취소 기록 (2026-10-05)

- 원본 작업 감지·시간 제한·수동 중단·설정 변경·앱 종료에 따른 취소는 구체적인 취소 사유로 기록한다. 컨테이너 종료 오류가 이미 발생한 취소나 모델 요청 실패를 덮어쓰지 않게 한다.
- 공급자 응답에 유효한 `estimated_bytes`와 `limit_bytes`가 있고 추정치가 한도를 넘으면 메모리 제한으로 분류한다. 일반 HTTP 거절이나 알 수 없는 응답은 메모리 부족으로 추측하지 않는다. 원본 오류 본문·모델 ID·endpoint·자격증명은 실패 사유에 저장하지 않는다.
- 로컬 모델의 메모리 제한을 확인한 뒤 진단 개선을 먼저 진행했다. 사용자가 병렬 요청 없이 재평가를 요청해 원본 실행 작업이 비어 있는 상태에서 한 번 더 평가한다. 모델·서버 한도는 자동 변경하지 않으며, 측정되지 않은 품질 개선이나 코드 후보 채택을 주장하지 않는다.

### RRSI 설정 조회와 Effect 리팩터링 범위 (2026-10-05)

- 설정 조회가 진행 중이거나 실패해도 하네스 개선 페이지의 제목을 유지한다. 조회 오류와 재시도 버튼을 표시하며, 구버전 백엔드의 API 404에는 서버 재시작 안내를 제공한다. 기존 데이터의 갱신 실패도 숨기지 않는다.
- RRSI 전체 실행 흐름을 Effect·typed error로 리팩터링한다. 작업 소유권·동시성·취소·반복 감지·자원 종료를 실제 Scope와 Fiber로 구성하고 Promise나 타이머 비즈니스 로직을 겉으로 감싼 전환으로 끝내지 않는다. Effect와 typed error 지침은 `packages/memory-agent/AGENTS.md`에서 관리한다.
- 사용자 화면에서는 ‘동작 개선 실험’으로 표시한다. 활성 프로젝트·진행 중인 Goal의 직접 수정이 아니라 공통 작업 지침과 기억 검색 설정을 별도 과제로 비교해 새 Goal에 적용하는 과정임을 설명한다. 평가 비용, 단계, 적용된 변경을 구분하며 토큰 사용량을 개선의 증거로 표시하지 않는다.
- 유휴 감지·실행 작업·대기 메시지·최근 활동의 조회에서 `projects.hidden_at`이 있는 보관된 프로젝트를 제외한다. 기록과 기억은 유지한다. 소유 프로젝트를 확인할 수 없는 실행은 보수적으로 보호한다.

### 개선 실험의 결과와 실제 실행 검증 (2026-10-05)

- 사용자에게는 하네스라는 용어 대신 작업 지침과 기억 검색 설정을 설명한다. 현재 적용된 값, 이전 값, 평가 비용, 과제별 진행, 이번 평가에서 채택된 변경을 구분한다. 적용 대상은 새 Goal이며 진행 중인 Goal의 핀과 일반 채팅의 기본 설정은 유지한다.
- 활성 프로젝트는 실험의 입력 코퍼스가 아니라 실행 작업과 대기 메시지를 감지하는 대상이다. 보관된 프로젝트는 SQL 감지와 직접 채팅의 취소 알림 모두에서 제외한다.
- 과제 HTTP 실패, RUN_ERROR, 미완료 스트림과 인프라 오류는 정상 평가의 0점으로 취급하지 않는다. typed suite failure로 전파해 채택을 막고, 완료된 코드 검증 실패만 과제 점수로 남긴다.
- 모델을 호출했다는 사실과 평가를 통해 설정을 개선했다는 사실을 구분한다. 실평가가 후보 생성에 도달하지 못한 경우 모의 제어 흐름 검증을 실제 품질 향상으로 보고하지 않는다.

- 정상 평가의 영역별 0점은 개선 대상이므로 후보 생성 전에 중단하지 않는다. 기존 채택 기준과 코딩·기억 회귀 방어는 유지한다. 실제 실행 오류는 typed failure로 중단시켜 정상적인 낮은 성능과 구분한다.

### 로컬 multilingual recall sensor S4 판정 (2026-10-06)

- 승인한 활성화 게이트를 적용한 현재 FP32/cold-process 평가에서는 S5 자동 검색을 진행하지 않는다. 측정 결과와 한계는 [docs/laya-recall-s4.md](laya-recall-s4.md)에 기록한다.
- validation 선택 threshold의 전체 필요한 근거 회수는 4/5, 작은 holdout에서는 0/1이다. 검색을 실행하면 기존 project-only 검색은 gold를 회수하지만 센서가 정정 질문의 검색을 생략한다. 작은 합성 표본과 사후 작성 heuristic으로 일반적인 모델 우열을 확정하지 않는다.
- cold 전체 p95 약 4.92초, 단독 warm 긴 입력 p95 약 1.12초로 예산을 초과한다. 단독 warm 짧은 입력만 약 174ms이며 이것으로 production turn 비용 충족을 주장하지 않는다. 답변 출처 정확도·전력·완전한 자원 모니터링은 미확인이다.
- 모델은 앱 외부 실험 경로에 두고 eval adapter는 기본 비활성으로 유지한다. Clef로 후보를 변경하거나 기준을 완화하지 않는다. 새 활성화 시도는 별도 설계·평가 Plan 확인이 필요하다.

### 로컬 multilingual recall sensor 평가 (2026-10-06)

- 우선 실험 후보는 Node/TypeScript `@receptron/laya`의 `subfolder: "multilingual"` 경로다. README의 옵션 지원과 사용자 머신에서의 실제 번들 로딩 성공은 구분한다.
- Python–ONNX 출력 일치는 필수 활성화 게이트에서 제외한다. 이상 출력이 관찰될 때만 비교를 진단 수단으로 검토한다.
- 한국어 과거 결정·정정·지시어 및 검색 불필요 턴에서 필요한 원본 evidence 회수, 과잉 검색·출처 오류, cold/warm·p95 지연, 메모리·embedding 경합·전력 비용과 fallback을 평가한다.
- 자동 검색은 shadow 평가 통과 전 비활성으로 유지한다. 모델 점수는 사용자 승인이나 evidence 정정 관계가 아니며 기존 검색·compaction·수동 evidence 도구를 변경하지 않는다.
- 외부 모델 다운로드는 별도 동의 또는 명시적 설정으로만 수행하며, 로컬 입력의 원격 전송과 cloud fallback은 허용하지 않는다.

### Local API: minimum FTS sort repair (2026-10-07)

- During a bounded direct-health/native sample, backend main-thread FTS/BM25 work coincided with 2.15/4.22-second health delays. This is a supported lead, not proof of the earlier fifteen-second episode's sole cause.
- Use FTS5's default BM25 hidden `rank` ordering for the two existing MemorySearch FTS queries, retaining meaning/project filters and result limits. A 30-row isolated plan comparison preserves ordered results and removes the external temporary ORDER BY B-tree. Do not claim it bounds all internal FTS matching work or proves a live latency improvement.
- No schema change, original/model-context truncation, custom rank configuration, blanket proxy timeout or SQL integration-suite expansion. Code rollback restores the two prior ORDER BY expressions. Keep owner/run/approval/session contracts and parallel refactoring unchanged.
- Changed-source static checks and existing search/maintenance 22/22 plus subscription/error/restoration 21/21 pass. The no-HMR backend still serves the prior fingerprint after this edit; rebuild/restart must be coordinated with its owner before live recurrence verification and final completion.

### RRSI 기억 평가의 원본 근거 채점 (2026-10-07)

- 기억 과제의 최종 응답은 `decision`과 `evidenceIds` 두 필드만 가진 JSON으로 받는다. 현재 결정의 정확한 일치와 원본 정정 노드 하나의 인용을 함께 요구한다.
- 정정 턴 직후 실제 사용자 노드 ID를 별도로 고정한다. 채점 시 원본의 존재, 종류, 프로젝트, 세션, 정정 텍스트를 확인한다. 원본을 고정할 수 없는 실행은 `evaluation_incomplete`이며, 잘못된 답변은 실패 점수다.
- 기존 문구·UUID 패턴 채점의 점수와 새 점수는 직접 비교하지 않는다. 평가 이미지를 다시 빌드해 같은 채점기로 기준과 후보를 평가하며, 이미 소비한 sealed corpus 영수증은 초기화하지 않는다.
- Effect 4.0의 `Schema.decodeEffect`, `Effect.fn`, `Nodes` 서비스 의존성으로 채점 흐름을 합성한다. 답변의 `SchemaError`만 실패 점수로 복구하며 원본 조회 실패는 `EvaluationFailed`로 전파한다. 턴별 상태는 순차 `Effect.reduce`가 누적한다.

### Async native memory search: Rust-owned request control safety repair (2026-10-08)

- The old SAB-brand validator could be bypassed by mutable JS intrinsics. Ordinary-path/GC/paired results below are historical, not proof of that unsafe boundary. Remove raw backing-store atomics, pointer-as-usize callbacks and all search-time run_script/JS clock dependency before public integration.
- Register a Rust-owned request Arc with AtomicBool cancellation and Instant deadline before large host input validation/copy/queueing. Only bounded identity/budget conversion precedes registration. Native search and SQLite's progress callback consult the same Arc after transport/N-API conversion. Cancellation is a direct main-thread native atomic store; no second index/lease/writer and no same-worker cancel-message substitution.
- A private host UUID seed plus a never-recycled native serial issues each capability. Bound owner/epoch/request and claim once. Reject duplicate active seeds, and a reissued seed cannot revive an old token. Cap registry at 4,096 live controls without an unbounded tombstone set. Effect acquireUseRelease and owner failure cleanup close every admitted control; callback-held Arc remains alive after host close. Keep active transport slots until actual completion.
- Reject snapshot ID duplicates/noncanonical IDs. Duplicate [1,1] must not stand in for the omitted ID in index [1,2]; membership plus input length alone is insufficient. This verifies ID composition, not vector/text generation identity.
- Explicitly clear SQLite progress hooks, rollback and confirm autocommit before a successful return. Cleanup failure permanently poisons that read connection and terminates the owner with read-failed; Drop only performs best-effort fallback. Original records/schema/persistent vector format remain unchanged.
- Preserve nonpreemptible CPP admission and default-off. Native eight tests/release build and current ABI/worker/read/lifecycle tests pass. Actual cross-worker Rust-owned control: five cancel calls timestamped inside N-API windows all returned cancelled, 15 after-call writes returned success, with main GC in all 20 calls. This includes FFI conversion, not a scoring-midpoint/preemption proof.
- Same WAL fixture and 13 alternating pairs matched channels/IDs/scores/coverage; warm medians: wall 34.424→25.704ms, main CPU 30.577→0.744ms, boundary worker CPU 1.163→24.658ms, SQL 55→10, input logical bytes 40,802→1,620. Raw evidence/source/addon fingerprints: native-search-rust-control-2026-10-08.json. Isolated boundary comparison, not production concurrent API/RSS/default qualification.
- Read-only review found a source-derived host queue ABA: an old request's delayed finalizer could remove a newer job with the same request ID. Final cleanup now removes only the exact job reference, preserving caller ID reuse. Measurement samples precede only that host finalizer repair; native binary is unchanged and post-review host regression/fingerprint is separate. No experimental reproduction of that interleaving is claimed.

### Historical pre-safety-repair boundary evidence (2026-10-08)

- A read-only review identified zero-content term arrays bypassing logical-byte admission and dispatch-to-native time missing from the read budget. Charge eight bytes per entry before host Schema decoding/copying; compute the absolute same-process hrtime deadline from invocation, overwrite caller deadline at dispatch, and sample Node hrtime inside the trusted N-API realm after argument conversion. Retain duration-only compatibility for direct ABI calls without that optional deadline. No wall-clock/Instant epoch comparison or CPP hard-preemption claim.
- Failure envelopes are a separately fixed, empty-channel response; tiny requested output budgets bound successful payloads, not that error envelope or exact serialization bytes. Do not return partial success on budget failure.
- Current repaired build passed seven-file TS format/lint/type, four TS files/seven tests, four native tests and release build. A deterministic SQLite interrupt exercised the actual ReadGuard, hook removal/rollback, writer update and a fresh subsequent snapshot. It does not replace a future in-flight SAB/whole search integration test.
- One worker/index and a fixed temporary WAL fixture (10,002 candidates, 384dim/4bit/k48) produced exact IDs/scores/text/morph/coverage equality across 13 alternating pairs. Twelve warm pairs: wall median 33.805→25.981ms; main-thread CPU 30.551→0.533ms; SQL executions 55→10; reported logical request contents 40,802→1,620 bytes. Worker boundary CPU rises 1.183→24.954ms because SQL moves there; this is offload plus boundary elimination, not a pure engine speed claim.
- Raw current-build evidence/fingerprints: `native-search-read-paired-2026-10-08.json`. This comparison deliberately keeps vector scoring in the same worker in both arms, so it isolates the candidate/SQL boundary and is not the old production main-thread/full-service baseline. First calls share caches; no OS-cold, concurrent API, RSS or default-activation conclusion. Native output logical bytes 1,291 remain bounded but use a different accounting than old JSON result bytes (902); do not compare them as exact wire-size gains. Broad FTS match work remains unbounded by top-k.
- Step 04 boundary implementation/verification is ready; generation/publication and public MemorySearch policy integration remain step 05, full regression/activation remain steps 06–07. Existing default runtime, production storage and server are unchanged.

### Async native memory search: read-only high-level primitive (2026-10-08)

- Added `MemoryReadSession` to the existing native extension, borrowing the same worker-owned index. Pin rusqlite 0.37.0 bundled/hooks; connection is read-only/query-only, one snapshot per call, no schema/persistent-format change and no independent writer.
- Enumerate filtered candidate u64 IDs and call the original engine inside native; map bounded hits with one batch SQL query. Execute trigram/short-term/morph rankings and asymmetrically scoped coverage in the same read snapshot. Preserve exact meaningful/suppression predicates and project filtering before k.
- Expose one memory-search/result DTO via existing bounded owner transport, not all candidates or arbitrary SQL/paths. Trusted database path is setup-only. Keep root/cancellation/progress hook lifetime and conservative vector admission, never silently clip scope/candidates.
- Actual parent old/new fixture matched IDs/scores/order/coverage; growing candidates 2→52 held input logical bytes and SQL execution count constant with output <512 bytes. Empty scope/cancel/output-budget outcomes and existing owner/lease tests passed. Native three tests plus release build and final TS seven-file check/four-file seven tests passed.
- This is an additive private boundary, not production default/public MemorySearch integration. Wall-stage timings are not pure CPU; no paired CPU/performance improvement, fully bounded FTS match work or publication/generation correctness is claimed. These remain subsequent integration/qualification work.

### Async native memory search: concurrent control visibility (2026-10-08)

- Timestamp shared flag writes against actual synchronous N-API call windows; do not infer in-flight behavior from a delay or from pre-aborted cells alone. A finite direct-ABI observation (ephemeral 50k/384/4bit worker, fresh flags, temporary typed-array views) ran 40 calls across early/varied offsets with main-isolate GC.
- Every observed in-window write returned cancelled: 20 in the early run and six in the varied run. Fourteen writes after completion returned success, as expected. Early Rust-body times were near zero and mainly exercised FFI/pre-engine cancellation; two varied-offset cases had longer bodies but no midpoint hook. None of these observations proves mid-scan preemption, hard deadlines, forced worker-isolate GC or adversarial-realm safety.
- Retain bounded admission/pre-post checks and default-off policy. Safe raw observations and source/addon fingerprints are in `native-search-control-visibility-2026-10-08.json`; the approved high-level SQLite integration must preserve these explicit limits rather than convert them into a hard-cancel claim.

### Async native memory search: additive controlled primitive (2026-10-08)

- Pinned turbovec's allowlist search builds a full index-sized mask and calls synchronous cache preparation/scoring without a cancellation hook. Do not change engine revision, split candidates/merge rankings, or claim a Promise timeout interrupts that engine.
- Added a native searchControlled primitive and typed worker command/result. A callback-local strong N-API reference roots one fixed four-byte SharedArrayBuffer Int32 cell; raw aligned pointer atomic loads avoid concurrent non-atomic Rust slices. Trust the owning worker's standard realm intrinsics for SAB brand/fixed-storage validation and explicitly retain this ABI limitation.
- Current measured admission envelope is ≤50k index, 384 dimensions, 4-bit, k≤48, ≤50k allowlist, remaining ≥12ms. Other work returns budget-exceeded without clipping. Checks before/after the exact engine call discard cancelled/late results; cold preparation/scoring remains non-preemptible. This is not a hard deadline guarantee, and does not justify enabling the new default.
- Host decrements queue/worker-validation time, raises the shared flag on interruption, and masks admission/cleanup registration to prevent a cancellation race leaking a queued job. Existing low-level API/format/writer and the application's default path remain unchanged.
- Actual worker round trip matched legacy IDs/scores, accepted shared cancellation, rejected a 1ms budget without scoring, and remained usable afterward. Final TS check and three-file six-test regression passed; Rust controlled-envelope unit test/release addon build passed. Concurrent in-flight shared visibility/GC stress, arbitrary-size budget and high-level SQLite are still remaining work, not proven by pre-aborted tests.

### Async native memory search: observed worker responsiveness (2026-10-08)

- Add safe monotonic native-call windows to vector-hit responses and expose the host owner as a Context service with a scoped Layer. Runtime consumers yield that service; test constructors are not a production composition pattern.
- The actual production client/worker, with 50,000 synthetic 384-dimensional vectors, ran ten k=48 searches. Each synchronous N-API span lasted 5.39–5.85 ms and contained 4–5 independent main-thread heartbeats. This confirms main-thread progress during actual native execution for that fixture, not just before or after an asynchronous wrapper.
- Preserve the limitations: these windows include N-API conversion, not pure turbovec CPU; they exclude allowlist marshaling/fixture preparation and do not prove SQLite/graph offload, cancellation, worst-case deadlines, or production API improvement. Do not enable the default path based on this observation alone. Raw source/addon fingerprints and intervals: `native-search-worker-responsiveness-2026-10-08.json`.

### Async native memory search: worker transport foundation (2026-10-08)

- Added an actual Node worker owning one low-level turbovec index and CacheLease, with Schema-decoded commands, safe protocol failures, existing `.tmp` save/rename, and Scope-based port/lease cleanup. A mismatched saved layout fails closed; rebuilding requires explicit host recovery.
- Host transport uses Deferred for responses, Ref for admission and removable queued jobs, and a capacity-one Queue as a dispatcher wake signal. Only one job is posted at a time. Queued interruption frees admission immediately; interrupted active callers do not release the native resource slot before its actual completion. Worker exit fails all outstanding Deferreds and preserves the first failure reason.
- Source Worker export/checkout resolver and packaged `.mjs` entry were registered. The deployment-style bundle built in temporary storage and its native bootstrap/close succeeded; the first CLI smoke used an incompatible inherited `--input-type` flag and was invalid, then was rerun with file-compatible worker arguments. No app server or operational cache was restarted/modified.
- Minimal real-worker tests cover native add/search/save, competing lease rejection, explicit close/snapshot reopen, and host Scope shutdown/reacquisition. A gated transport test covers 32-request saturation, queued Fiber interruption freeing capacity, and worker exit settling all remaining waiters; the gate uses Deferred rather than sleeps.
- This remains a transport foundation, not completed high-level memory search. Rust read-only SQLite, active native cancellation/progress hooks, publication integration, packaged-current-build performance comparison and default activation are still later work. The app's existing search path is unchanged.

### Async native memory search: API and ownership contract (2026-10-08)

- Keep host services/policies in TypeScript and add a separate read-session module to the existing turbovec Rust crate; retain the low-level API and persisted index format. The owning Node worker alone holds the existing index and CacheLease. Its SQLite search connection is read-only and uses one transaction per ranked seed request.
- A host publication gate must cover index mutation, existing atomic snapshot save, and existing SQLite mapping/journal commit as one unpublished interval. Only then publish an ephemeral epoch/generation. Failed publication poisons reads until existing reconciliation succeeds; it does not create a new Rust writer or silently fall back to synchronous main-thread search.
- Preserve TypeScript rank fusion/graph/correction/provenance policies and project checks. Native returns bounded channel rankings/IDs/coverage, not a raw-score replacement for the public memory contract. All allowed-project filtering occurs before channel top-k. DTO byte budgets are 1 MiB each, with explicit budget errors rather than silent project/rank truncation.
- Effect adaptation is lazy and scoped over real worker messages. Individual Fiber interruption cancels only its request. An atomic shared cancellation flag and SQLite progress hook are necessary because a worker cancel message cannot interrupt an executing synchronous native call. The current turbovec primitive has no verified cooperative mid-scan hook; measure its residual span and do not enable the new default if cancellation/deadline bounds fail.
- No additional SQLite migration/user_version change, original/model-context alteration, second lease, or index-format change. Operator startup switch chooses exactly one owner and rollback drains it before legacy acquisition. Same-build legacy rollback is distinct from original 0.0.13 binary downgrade: existing newer migrations already prevent opening the current migrated DB with that binary. Verify 0.0.13 fixtures/backups on copies; no in-place schema downgrade promise or new downgrade tooling.
- Contract review found rank/publication edge cases and they were corrected: text results may exceed per-query k because each two-character term appends its own top-k before dedupe; keep that order and host UTF-16 term classification. Gate covers maintenance's initial durable suppression/intent commit and late embedding/purge revalidation, not just native RPCs. Recheck generation when the owner actually executes a job. Global cancel/stale/budget/worker errors cannot be swallowed as vector-only degradation.
- Distinguish host cancel acceptance, native observation and completed termination. Validate shared atomic storage/lifetime, progress-hook coverage and deadline-bounded busy wait; queued/caller Promise settlement alone does not prove resource release. Detailed DTO/outcome/publication/lifetime invariants: `native-search-contract.md`.

### Async native memory search: ownership and baseline (2026-10-08)

- Trace actual service ownership before adding a worker. Current source executes SQLite ranking and synchronous turbovec through the central owner runtime; Goal/full-loop worker tools proxy back to that owner. The Rust owning-worker comment is not evidence of an implemented search worker.
- Preserve one VectorIndex handle/CacheLease and its add→save→mapping publication/removal recovery ordering. Existing import workers already have separate SQLite connections; the proposed search connection is read-only and must not introduce another vector-cache writer.
- A finite synthetic SQLite/N-API boundary benchmark passed targeted format/lint/type and three independent runs. For 50,000 candidates, warm search p95 is 80.51–83.20 ms; a twenty-search saturation burst delays an independent loopback control by 1.53–1.60 seconds. These are not production MemorySearch/API measurements or proof about the earlier residual API delay.
- Prioritize both off-main-thread SQL execution and removal of full allowlist/per-hit mapping bridges. In this fixture FTS work is larger than vector-call CPU; moving only string conversion cannot solve event-loop blocking. Keep graph/authorization/provenance policies in TypeScript.
- Raw synthetic results and source/addon fingerprints are in `native-search-baseline-2026-10-08.json`; methodology is in `performance-native-search.md`. The initial boundary-only measurements were insufficient to complete step 01. Subsequent real-service temporary file/WAL measurements add 185/186 actual SQL executions per search, new-process startup, and four-client HTTP during a fixed twenty-search burst. Preserve the older in-memory results as historical, not a paired baseline.
- Freeze old/new comparisons against the three file/WAL runs in `native-search-service-file-baseline-2026-10-08.json`: 15%/5 ms warm-search allowance, ≥50% event-loop/control-HTTP improvement with control p95 ≤20 ms, ≤64 MiB additional observed RSS, ≤500 ms additional scoped startup. Runtime design bounds are 32 admitted searches, one active index-owner search, 2-second work budget and finite cancellation acknowledgement. Keep all quality/authorization/provenance criteria independent of these speed targets. Native-boundary CPU still includes N-API conversion; production cold startup and controlled live API attribution are not inferred.

### Laya eval 프로세스 경계 (2026-10-08)

- Laya eval은 Effect의 experimental process API 대신 `LayaWorkerProcess`로 stdout·exit·kill 계약만 주입한다. Node spawn 구현은 Scope가 소유하며, stdin에 한 번의 제한된 요청을 보내고 환경변수 상속과 stderr 수집을 하지 않는다.
- timeout·취소·sensor close는 SIGKILL 요청 뒤 실제 close 이벤트까지 기다린다. bounded output 검사, 단일 turn memo, network deny sandbox 명령과 production 비활성화는 유지한다.
- 경계 테스트는 kill과 exit를 독립적으로 제어하여 종료 대기를 검증하고, native transport 테스트는 실제 자식 프로세스의 stdin 전달과 Scope 종료 후 reaping을 검증한다. experimental API 진단을 억제하는 주석은 사용하지 않는다.

### 동작 개선 실험의 기본 비활성 (2026-10-12)

- RRSI 유휴 자동 실행의 기본값을 끔으로 바꾼다. 사용자가 요청하지 않은 모델 시간과 구독 사용량을 쓰므로, 실험 결과로 유지·삭제를 정하기 전까지는 설정에서 켠 경우에만 돈다.
- 설정 행이 이미 있는 저장소는 그 값을 유지한다. RRSI는 정식 릴리스(0.0.13) 이후에 들어와 기존 릴리스 사용자에게 저장된 값이 없다.

### Laya recall sensor 코드 제거 (2026-10-12)

- S4 판정(2026-10-06)에서 자동 검색을 진행하지 않기로 한 Laya recall sensor의 코드를 지운다. `recall-sensor`·`recall-sensor-local`, 채팅의 shadow 전용 sensor 인자, `eval/laya-*`, `eval/recall-shadow-search.ts`와 그 fixture·테스트다. 운영 경로는 sensor를 넘기지 않았으므로 동작은 바뀌지 않는다.
- 측정과 판단은 `docs/laya-recall-*.md`에 결과로 남긴다. 그 문서의 재실행 명령은 이 코드가 있던 커밋에서만 돈다.
- 코드 제거와 같은 날 진행한 I1–I3 평가(총토큰 예산·질문 선별)도 사전 등록 기준을 통과한 후보가 없어 I4 이후를 진행하지 않았다. 결과만 [laya-recall-i1-i3.md](laya-recall-i1-i3.md)에 남기고, 평가 코드와 데이터 집합은 main에 넣지 않았다.
- 이 센서는 "이번 턴에 회상이 필요한가"를 판정했고, 기억 노드의 가치를 매기는 도구가 아니었다. 쓸모없는 노드 정리는 원문 삭제와 색인 제외를 나누고 규칙 기반 신호부터 쓰는 별도 설계로 다룬다.

### 벡터 목록 컷과 Kiwi의 회상 기여 측정 (2026-10-12)

- `vp run eval:recall`로 같은 날 다시 쟀다(결정 32문항, 기술 27문항, MRR).

  | 구성                          |  결정 |  기술 |
  | ----------------------------- | ----: | ----: |
  | 벡터                          | 0.870 | 0.119 |
  | trigram                       | 0.526 | 0.796 |
  | 벡터 + trigram                | 0.832 | 0.759 |
  | 벡터 + trigram + Kiwi         | 0.852 | 0.759 |
  | 벡터(quint8) + trigram        | 0.819 | 0.759 |
  | 벡터(quint8) + trigram + Kiwi | 0.836 | 0.759 |
  | trigram + Kiwi                | 0.760 | 0.796 |

- 결합이 각 세트의 단독 최고(결정은 벡터, 기술은 trigram)보다 낮다. 벡터 목록이 관련 없어도 k개를 채워 동점을 가져가는 문제다. 1위 벡터 점수에서 일정 차이(0.02/0.05/0.1) 밖의 벡터 결과를 빼는 컷을 시험했다. 결정 세트는 margin에 따라 0.836→0.872/0.841/0.836(Kiwi 포함), 0.819→0.844/0.855/0.841(Kiwi 없음)으로 1-2문항 안에서 들쭉날쭉했고 기술 세트는 모두 그대로였다. 근거가 약해 채택하지 않는다. 기술 세트의 남은 실패는 도구 출력에만 있는 내용을 뜻으로 묻는 질문 5개와 결합 순서 문제다.
- Kiwi는 벡터가 있을 때 결정 세트에서 1문항(+0.017~0.020), 기술 세트에서 0을 더하고, 색인 시간을 약 2.5초(73개 노드) 늘린다. 벡터가 없을 때만 큰 차이(0.526→0.760)를 낸다. fp32는 quint8보다 결정 세트에서 0.016 높고 기술 세트는 같다. 두 세트 모두 작은 합성 집합이라 Kiwi 제거 결정에는 실제 기억 사본에서의 같은 비교를 함께 본다.

### 실제 기억에서의 Kiwi와 도구 출력 색인 측정 (2026-10-12)

- 운영 DB를 `backup()`으로 뜬 사본(노드 15만, 벡터 2.7만)에서 같은 검색 경로로 쟀다. 질문은 사본에서 정해진 seed로 뽑았다. 도구 출력에만 있는 식별자(앞부분 60개, 12000자 뒤 12개), 발언에 있는 식별자 60개, 3000자 넘는 발언의 2500자 뒤에서 뽑은 문장 60개다. 부하가 없을 때의 MRR이다.

  | 구성                            | 도구(앞) | 도구(뒤) |  발언 | 긴 발언 꼬리 |
  | ------------------------------- | -------: | -------: | ----: | -----------: |
  | 운영(fp32 + trigram + Kiwi)     |    0.872 |    0.392 | 0.833 |        0.501 |
  | Kiwi 끔                         |    0.824 |    0.375 | 0.796 |        0.453 |
  | 도구 출력을 trigram·Kiwi에서 뺌 |    0.000 |    0.000 | 0.802 |        0.432 |

- Kiwi는 실제 기억에서 모든 묶음을 0.02~0.05 올린다. 남긴다.
- 도구 출력은 계속 trigram·Kiwi에 색인한다. 빼면 도구 출력에만 있는 내용은 찾을 수 없고, 발언 검색도 나아지지 않는다. 비운 자리를 `tool_call` 노드가 채워 발언 결과를 밀어냈다. `yes`·`Y` 같은 짧은 출력은 trigram이 생기지 않아 trigram 결과에 끼지 않는다. 임베딩은 지금처럼 발언과 주제에만 한다.
- 긴 발언의 꼬리(0.501)와 긴 도구 출력의 뒷부분(0.392)이 약하다. 임베딩이 앞 2048 토큰만 보고, 긴 문서는 trigram 순위에서 밀린다.
- 측정 중 부하가 높을 때 검색 전체가 `budget-exceeded`나 `VectorIndexError`로 실패했다. 시작 직후 첫 검색도 같은 이유로 실패했다. native read 한 번에 2초 예산을 두고, 넘으면 텍스트 결과까지 버린다.
- 실패 원인은 벡터 검색이 아니었다. turbovec 검색은 0~~1ms였고, 벡터와 텍스트를 모두 끈 빈 read도 약 2초 걸렸다. 매 검색의 고정 SQL 세 개가 원문을 읽었다. 색인 안 된 발언 수는 노드 전체를, 해석 안 된 발언 수는 프로젝트의 모든 노드를, 벡터 후보는 프로젝트 벡터 노드 전체의 원문을 훑었다. 캐시가 빈 시작 직후에는 첫 쿼리만 2~~5초였다.
  - 임베딩 대상 종류이면서 빈 글이 아닌 노드에 partial index `nodes_embeddable(project_id, seq)`를 둔다. 두 개수와 후보 쿼리가 원문 없이 이 색인으로 답한다. 색인의 WHERE는 `embeddedKindFilter`·`nonBlankTextSql`과 같은 식이어야 쓰인다.
  - 해석 안 된 발언 수는 `CROSS JOIN`으로 열린 작업부터 돈다. 통계가 없는 SQLite가 프로젝트 노드부터 도는 계획을 골랐다.
  - 같은 사본(load 60~140)에서 빈 read 2004→17ms, 벡터 read 2211→30ms, 검색 전체 평균 2258→155ms(최대 315ms)다. 개수와 결과는 같다. 남은 큰 단계는 trigram과 짧은 단어 검색(평균 142ms)이다.
  - 시간 초과 때 벡터 없이 다시 읽는 대체 경로는 넣지 않는다. 원인을 고쳤고, 대체 경로는 실패를 가린다.
- 세션을 지울 때 `nodes_morph` 행을 남기던 문제를 고쳤다. 사본에는 노드 없는 형태소 행 434개와 trigram 문서 2개가 남아 있었다. 검색은 `nodes`와 join해서 결과에는 영향이 없다.

### 해석 대상을 사용자 발언으로 좁힘 (2026-10-12)

- llm-interpret(2026-09-14)는 사용자 발언만 해석한다. 정정과 취소는 원래 사용자 발언에서만 만들었고, assistant 발언의 해석은 주제와 `related` edge만 남겼다. assistant 발언은 후보로는 계속 쓰인다. 새 assistant 노드와 가져온 assistant 줄에는 해석 작업을 만들지 않고, 이전 빌드가 쌓은 대기 중인 assistant 작업은 시작할 때 지운다.
- 같은 세션 최근 발언과 같은 프로젝트 검색에서 앞선 후보를 하나도 찾지 못한 발언은 모델에 보내지 않고 완료로 둔다. 연결할 대상이 없으면 edge가 생길 수 없다. 이런 발언에는 주제가 붙지 않는다. 주제는 원문보다 약한 단서로만 쓰인다.
- 모델 호출이 실패해도, 후보가 없어 이미 완료한 발언은 다시 대기열로 돌리지 않는다.
- 턴 요약을 대화가 일정 크기를 넘을 때부터 만든다(아래 "요약 시작 기준 측정과 leave-out 판정 수정").

### 요약 시작 기준 측정과 leave-out 판정 수정 (2026-10-13)

- 실제 기억 사본의 대화 558개 중 7턴 이상인 62개를 재생했다. 각 사용자 턴의 첫 모델 호출을 지금의 `compactEffect`로 만들고, 요약 블록은 실제 블록 평균 크기(1600자)로 채웠다. 창은 272k, leave-out 기준은 55%다. 요약은 다음 요청 전에 준비된다고 가정했고, 실행 중 도구 호출 사이의 요청은 빠졌다.

  | 요약 사용 시작         | 평균 입력 | 캐시 안 된 입력 | 요약을 쓴 호출 | leave-out 호출 | 요약 호출 |
  | ---------------------- | --------: | --------------: | -------------: | -------------: | --------: |
  | 항상(지금)             |    33,690 |          18,989 |          80.3% |           4.7% |       407 |
  | 창의 10%부터           |    34,184 |          18,954 |          70.3% |           4.7% |       359 |
  | 창의 25%부터           |    36,381 |          19,084 |          60.7% |           4.7% |       338 |
  | 창의 40%부터           |    40,064 |          18,980 |          52.8% |           4.8% |       314 |
  | 요약 없음(leave-out만) |    55,358 |          28,710 |           0.0% |          36.6% |         0 |

- 캐시 안 된 입력은 기준과 관계없이 거의 같다. 기준을 올리면 원문으로 보내는 호출이 늘고 요약 호출이 준다. 요약 없이 leave-out만 두면 셋 중 한 호출이 앞부분을 통째로 잃는다.
- 요약은 대화가 모델 컨텍스트 창의 일정 비율을 채운 뒤에 시작한다. 기본 25%이고, 설정의 "긴 대화"에서 0~50%로 바꾼다(`config.json`의 `summaryStartPercent`). 퍼센트라 창 크기 차이는 반영되고, 설정은 모델이 긴 원문을 얼마나 버티는지에 대한 사용자 판단을 받는다. 0이면 처음부터 요약하고, 상한은 leave-out 기준(55%)보다 아래라 밀린 요약을 만들 여유가 남는다. 모델별 값은 두지 않는다.
  - 판정은 실행이 끝난 뒤 요약을 만들 때 하고, 요약 없이 보낼 크기를 잰다. 요약 블록이 생긴 대화는 그 뒤로 계속 요약을 쓴다. 블록이 있다는 것 자체가 시작했다는 기록이라 따로 상태를 두지 않는다. `/compact`는 크기와 관계없이 요약한다.
- 측정 중 leave-out 판정 버그를 고쳤다. 크기를 잴 때 재생할 수 없는 도구 호출(인자가 JSON이 아닌 부분 호출)의 결과까지 셌다. 그 결과는 마지막에 어차피 빠진다. 그래서 실제로는 8.9k 토큰인 요청이 보낼 수 있는 메시지 261개 중 176개를 버렸다. 이제 짝을 먼저 맞춘 뒤 크기를 재고, leave-out 뒤에 한 번 더 맞춘다. 지금 방식의 leave-out 호출이 7.1%에서 4.7%로 줄었다.

## 도구·권한·외부 연동

### 로컬 도구 (2026-09-14)

- 파일, 셸 도구는 codex 내장 도구(셸, apply_patch, 샌드박스)가 아니라 TanStack 도구로 직접 구현한다(방식 A).
  - 이유: PRD 권한 규칙(밖 읽기는 허용, 자격 증명 거부, 셸은 승인)을 그대로 지키고, 모든 호출이 같은 기록 경로로 기억에 들어가며, 백엔드(ACP 등)가 바뀌어도 도구가 남는다.
  - 대가: 셸은 호스트에서 격리 없이 실행된다.
- 프로젝트 파일 변경은 승인 없이 하되, 읽을 때 받은 sha256과 현재 내용이 같을 때만 쓴다(사용자 편집 보존).
- 숨김 파일은 허용하고 `.git` 내부와 자격 증명으로 보이는 경로만 막는다(`tokens.ts`, `password-reset.tsx` 같은 코드는 허용).
- 밖 읽기 도구는 PRD의 `read_outside_file`, `search_outside_file`에 더해 `list_outside_files`를 둔다. 파일 이름을 모르면 읽을 수 없어서.
- 셸 명령에는 비밀로 보이는 환경 변수(`TOKEN`, `API_KEY` 등)를 넘기지 않는다.

### 권한 모드 (2026-09-14)

- PRD R05의 "지속 승인"(프로젝트+정확한 명령 저장) 대신 auto 권한 모드를 만든다. Claude Code의 auto 모드와 같은 방식.
  - 프로젝트마다 `ask`(호출마다 사용자 승인, 기본)와 `auto`(분류 모델 판정)를 고른다.
  - auto: 승인이 필요한 호출마다 선택한 모델의 가장 낮은 추론 강도로 `allow`/`ask`/`block`을 받는다. 입력은 호출 내용, 실제 사용자 발언, 프로젝트 경로뿐이고 도구 결과는 넣지 않는다(프롬프트 인젝션 방지). 실패, timeout은 `ask`.
  - 판정과 사용자 답은 기록하고 도구 결과 노드에 근거로 남긴다.
  - 한 번에 여러 호출 중 하나라도 `ask`면 묶음 전체를 한 번에 묻는다(TanStack 재개 단위).
- PRD R05 변경: 사용자가 프로젝트에서 auto 모드를 켠 것은 그 프로젝트의 셸, 밖 쓰기를 분류 모델 판정에 맡긴다는 명시적 상시 동의로 본다. 자격 증명, `.git` 규칙과 문서, 도구 출력으로 권한이 생기지 않는 원칙은 그대로다.
- 명령 단위 지속 승인은 보류한다.

### 이미지 첨부 (2026-09-14)

- Claude식 `#1`, `#2` 참조와 Slack식 첨부 목록을 합친다. 붙여넣기, 끌어놓기, 첨부 버튼으로 넣고, 입력창 위 카드(shadcn `attachment`)에 번호, 상태, 제거를 보여준다.
  - 번호는 작성 중인 초안 안에서만 매기며(PRD), 이미지를 빼도 초안 번호는 그대로 두고 보낼 때 실제 순서로 다시 매긴다.
  - 보낸 메시지는 본문의 `#N` 칩(hover 미리보기)과 이미지 그리드로 보여준다.
- 첨부하는 즉시 올린다(`POST /api/attachments`). 서버는 바이트 서명으로 형식(png/jpeg/gif/webp, 20 MiB 이하)을 확인해 sha256 이름으로 한 번만 저장한다. 메시지에는 첨부 URL만 싣는다(TanStack이 요청마다 대화 전체를 다시 보내므로).
- codex에는 이번 턴 이미지를 `localImage`, 이전 턴 이미지를 `input_image`(data URL)로 넘긴다. 우리 첨부가 아닌 이미지 URL은 넘기지 않는다.
- 모델에는 원본 대신 줄인 사본을 보낸다(2026-09-15). 긴 변 2048px 안으로 줄이고 WebP로 인코딩한 `<id>.model.webp`를 처음 보낼 때 한 번 만든다. 원본은 화면 표시와 기록에 그대로 둔다.
  - PNG, WebP는 무손실, JPEG는 품질 100이다. 스크린샷에서는 무손실이 품질 90과 비슷하거나 더 작았다: 1784×1332 PNG 98 KB → 38 KB, 3024×1964 PNG 718 KB → 278 KB(2048px). 사진은 무손실이면 커진다.
  - GIF(움직일 수 있음), 사본이 원본보다 작지 않은 이미지, 인코딩 실패는 원본을 보낸다. 2048px은 API가 고해상도 이미지를 어차피 줄이는 크기다.
  - sharp는 실행 파일 런타임 패키지로 불러온다(`requireRuntime`).
- 선택한 모델의 `inputModalities`에 이미지가 없으면 첨부를 막고 서버도 거부한다(R06: 읽지 못한 이미지를 읽은 것처럼 보이지 않게).
- 끌어놓기는 브라우저 기본 drop 이벤트로 받는다. dnd-kit은 페이지 안 요소 정렬용이라 OS 파일 drop에는 맞지 않고, 첨부 순서 바꾸기가 필요해지면 그때 쓴다.

### Kagi 웹 검색 (2026-09-15)

- PRD R19대로 `kagi_search`, `kagi_extract` 두 도구를 둔다. 키를 등록하고 사용자가 켜기 전에는 도구가 모델에 보이지 않고 Kagi에 요청하지 않는다. 등록만으로는 켜지지 않는다.
- 키는 OS 키체인(`@napi-rs/keyring`, macOS와 Windows, Linux 지원)에만 둔다. 서비스 이름 `context-generactive-agent`, 계정 `kagi-api-key`. 키체인이 실패하면 오류로 알리고 파일 등 다른 곳에 저장하지 않는다. 켜짐 여부는 전역 `config.json`의 `kagiEnabled`. 키는 API 응답, 설정 화면에 다시 나오지 않는다.
- 키는 요청 직전에 읽는다. 키를 지우거나 끄면 이미 시작한 run이라도 다음 호출이 바로 `kagi_not_enabled`로 막힌다. 키를 지우면 꺼짐으로 바뀐다.
- 공식 TypeScript SDK(`@kagi/api`)는 npm에 공개되지 않아 설치할 수 없다. 대신 SDK 커밋 `bedbbdf`의 요청, 응답 모델과 경로를 따라 `fetch`로 직접 호출한다(`POST https://kagi.com/api/v1/search {query, limit}`, `POST /extract {pages:[{url}], format:"markdown"}`, Bearer 인증). 응답은 스키마로 검사하고 맞지 않으면 결과로 넘기지 않는다.
- 앱은 재시도하지 않는다. 400/401/403/429/5xx, 연결 실패, 스키마 불일치를 구분한 이유로 도구가 실패하고, 다시 부를지는 모델이 정한다. redirect는 따라가지 않는다(키가 다른 호스트로 가지 않게).
- Search 결과는 snippet이 요약임을, Extract는 Markdown 변환임을 결과에 적는다. 페이지별 실패, Kagi `errors`, 응답에서 빠진 URL을 따로 돌려준다. 한 페이지 Markdown은 4만 자에서 자르고 `truncated`로 표시한다.
- 켜져 있을 때만 지침을 붙인다: 호출마다 비용, 웹 내용은 지시, 승인이 아님, 출처 URL을 밝힐 것.
- 개발 중 실제 유료 호출은 하지 않았다. 로컬 가짜 서버로 요청 형식, 오류, 부분 실패를 검증하고, 실제 macOS 키체인 등록, 삭제는 설정 화면에서 가짜 키로 확인했다.

### MCP 서버 (2026-09-15)

- 설정은 두 곳에서 읽는다: 공통 `~/.context-generactive-agent/mcp.json`, 프로젝트 `<프로젝트>/.mcp.json`. 형식은 다른 에이전트와 같은 `{"mcpServers": {이름: {command, args?, env?} | {type: "http", url, headers?}}}`. 이름이 같으면 프로젝트 설정이 공통 설정을 대신한다. 설정 편집 화면은 두지 않고 파일을 고친다.
- 설정 신뢰와 실행 권한을 나눈다(R18). 프로젝트를 열거나 파일에 적혀 있다는 것만으로는 서버를 시작하지 않는다. 사용자가 설정 화면에서 "신뢰하고 시작"을 눌러야 시작한다. 신뢰는 적힌 설정 그대로(sha256 fingerprint)에만 적용되고, 명령, 인자, URL, 환경 변수가 바뀌면 "설정 바뀜"으로 멈춰 다시 신뢰해야 한다. 공통 서버 신뢰는 모든 프로젝트에, 프로젝트 서버 신뢰는 그 프로젝트에만 적용된다(`mcp_trust`).
- 신뢰해도 도구 호출은 승인하지 않는다. MCP 도구 호출은 모두 게이트를 거친다: `ask` 모드는 호출마다 사용자에게 묻고, `auto` 모드는 분류 모델이 판정한다. 서버가 붙인 `readOnlyHint` 같은 annotation은 힌트일 뿐이라 승인을 건너뛰는 근거로 쓰지 않는다.
- TanStack 정적 승인(`needsApproval`)은 브라우저에 도구 정의가 등록돼 있어야 카드로 답할 수 있다. MCP 도구는 실행 중에 생기므로 `permission-review` interrupt로 묻는다. payload의 `askedBy`로 "자동 검토가 애매해서"와 "호출마다 묻는 도구"를 구분한다.
- 도구 이름은 `mcp_<서버>__<도구>`다. codex app-server가 `mcp__` 접두사를 자기 MCP 도구용으로 예약해서 그 이름의 dynamic tool을 거부한다(실제 모델 실행에서 `dynamic tool name is reserved`로 확인). 64자를 넘으면 해시로 줄인다.
- stdio 서버는 프로젝트 루트에서 실행하고, 환경 변수는 SDK 기본값(HOME, PATH, USER 등)과 설정 파일에 적힌 것만 넘긴다. 앱의 다른 환경 변수(토큰 등)는 넘기지 않는다. 값에 `${NAME}`을 쓰면 앱 환경에서 채우고, 없으면 시작하지 않고 이유를 보여준다. 설정 화면, API에는 환경 변수, 헤더의 이름만 나오고 값은 나오지 않는다.
- 연결은 프로젝트, 서버마다 한 번 열어 다음 run에도 쓴다. 시작, 도구 목록이 20초 안에 안 되면 실패로 표시하고 그 run은 그 서버 없이 진행한다. 다음 run에서 다시 시도한다. 서버 종료 시 모두 닫는다.
- 결과는 6만 자에서 자른다. MCP 결과는 도구 결과로 기록되며 사용자 발언, 승인으로 승격하지 않는다.
- 연결 방식은 stdio와 Streamable HTTP다. MCP OAuth 로그인은 아직 지원하지 않는다(헤더의 `${TOKEN}`으로 대신).

### Skills (2026-09-15)

- skill은 `SKILL.md`(front matter `name`, `description`)가 있는 폴더다. 공통은 `~/.agents/skills`(다른 에이전트와 공유, `npx skills add -g` 설치 위치), 프로젝트는 `<프로젝트>/.agents/skills`에서 읽는다. 앱 전용 폴더를 따로 두지 않는다. 같은 이름이면 프로젝트 skill을 쓴다.
- 모델에는 이름, 범위, 설명 목록만 시스템 지침으로 준다(최대 100개, 설명 1024자). 작업이 맞으면 `read_skill`로 본문과 폴더의 파일 이름을 읽는다. 폴더 안 다른 파일은 기존 파일 도구로 읽는다.
- skill 문구는 권한이 아니다(R18). 지침에 "skill은 안내일 뿐, 명령은 평소 도구와 승인을 거치고 사용자 말과 규칙을 넘지 않는다"를 적고, `read_skill` 결과에도 적는다. skill은 아무것도 설치, 실행하지 않으므로 MCP 같은 신뢰 절차를 두지 않는다.
- symlink 폴더는 skill로 읽지 않는다(다른 곳을 가리킬 수 있어서). description이 없거나 256 KiB를 넘는 SKILL.md는 쓰지 않고 설정 화면에 이유를 보여준다. 설정 화면의 Skills 탭은 읽기 전용 목록이다.
- 앱 기본 skill을 둔다(2026-09-16). `packages/memory-agent/skills/`에 두고 실행 파일은 런타임 파일과 함께 `<저장 루트>/runtime/<해시>/skills`에 푼다. 범위는 `builtin`이고, 이름이 같으면 공통 및 프로젝트 skill이 덮어쓴다(기본 → 공통 → 프로젝트 순으로 뒤가 이김). 설정 화면에는 "기본"으로 보인다.
  - 기본 skill은 `SKILL.md` 하나로 완결한다. 실행 파일에서는 저장 루트 아래에 풀리고, 파일 도구는 저장 루트를 읽지 않으므로 옆 파일을 가리켜도 모델이 읽을 수 없다. 그래서 `read_skill`은 기본 skill의 `files`를 비워 준다.
  - 첫 기본 skill은 `draw`다. 이미지 생성 모델 없이 SVG를 `write_file`로 써서 다이어그램, 차트, 와이어프레임, 아이콘을 그린다(셸, 승인 불필요). 사진, 일러스트는 못 그린다고 말하게 하고, API 키 설정을 권하지 않게 한다(셸이 비밀처럼 보이는 환경 변수를 지우므로 그 길은 막혀 있다).
  - 측정(gpt-5.6-luna, 시퀀스, 아키텍처, 막대 차트 각 1회): skill 없이 그린 3개는 모두 viewBox 밖으로 내용이 잘렸다(참여자 하나가 통째로 안 보이거나, 마지막 막대, 제목이 잘림). skill로 그린 3개는 잘리지 않았다. 그래서 skill의 첫 규칙이 "viewBox를 내용에 맞추고 가장 큰 x, y를 확인"이다. 시간은 41-47초로 skill 없을 때(28-58초)와 비슷하거나 짧고 SVG도 더 작았다.
- 모델이 그린 SVG는 대화에 그림으로 보여 준다(2026-09-16). `write_file`/`edit_file`이 `.svg`를 쓰면 그 순간의 모습을 PNG로 떠서 첨부로 저장하고, 결과에 `preview { attachmentId, mimeType }`를 붙인다. 페이지는 도구 카드 아래에 그림을 보이고 누르면 크게 연다.
  - 파일을 그대로 보여 주지 않고 스냅샷을 남긴다. 결과를 기록한 노드는 바뀌지 않으니, 파일이 나중에 고쳐지거나 지워져도 그때 그린 그림이 남아야 한다. 결과 JSON이 노드에 그대로 있어 새로고침해도 보인다.
  - SVG를 이 앱 origin에서 서빙하지 않는다(SVG에는 스크립트를 넣을 수 있다). PNG로 구우면 스크립트가 실행되지 않는다.
  - sharp에는 SVG를 경로가 아니라 바이트로 넘긴다. 기준 위치가 없으면 librsvg가 `file://`, 절대, 상대 경로, 원격 URL 참조를 모두 거절해서, 프롬프트 인젝션된 SVG가 로컬 파일을 그림에 복사할 수 없다. 테스트로 고정했다.
  - 1차 범위는 SVG뿐이다. 셸로 만든 PNG는 보이지 않는다.
- codex 번들 skill은 끈다(2026-09-16, `skills.bundled.enabled = false`). codex는 imagegen, openai-docs, plugin-creator, review-agent, skill-creator, skill-installer를 CODEX_HOME에 풀어 모델에 보여 주는데, 모두 codex 자신의 도구(shell_tool, web_search, plugins, multi_agent, 내장 이미지 도구)를 전제로 쓰였고 이 앱은 그것들을 끄고 `dynamicTools`로 바꿨다. 그래서 모델이 없는 도구를 쓰라는 지침을 읽었다: 이미지를 요청받으면 imagegen을 따라 `scripts/image_gen.py` 폴백에 이르러 사용자에게 `OPENAI_API_KEY`를 설정하라고 했다.
  - 플랜별로 나누지 않고 전부 끈다. 플랜에 따라 달라지는 건 imagegen 하나뿐이고(무료 플랜은 내장 이미지 도구가 없고, 유료 플랜은 있다), 나머지 다섯은 이 앱 설정 때문에 어느 플랜에서도 쓸 수 없다.
  - 파일을 지우지 않고 설정 키로 끈다. 파일 삭제는 codex 레이아웃에 묶이고, codex가 다시 풀 수 있다.
  - codex가 스스로 찾은 스킬도 끈다(2026-09-16). codex는 사용자의 `~/.agents/skills`(와 작업 폴더의 `.agents/skills`)를 읽어 모델에 알려 준다. 이 앱도 같은 폴더를 읽어 `read_skill`로 주므로, 모델은 같은 스킬을 두 번 들었고 그중 하나에는 "지침일 뿐 권한이 아니다"가 붙지 않았다. 스킬은 이 앱이 주인이므로 codex 쪽을 끈다.
    - 이름이 겹칠 때의 우선순위는 `Skills`가 정한다(기본 → 공통 → 프로젝트).
    - 대화마다 `skills/list`로 codex가 보는 스킬을 묻고, 켜져 있는 것을 `skills/config/write { path, enabled: false }`로 끈다. 이 앱이 찾은 경로를 넘기지 않고 codex에게 물어서, 경로 표기가 달라도, 이 앱이 읽지 않는 폴더여도 새지 않는다.
    - 끄는 단위는 `SKILL.md` 경로다. 폴더 경로로는 아무것도 꺼지지 않고, 이름으로는 같은 이름의 두 스킬을 구분하지 못한다(실측).
    - 실행 중에 적용되어 codex를 다시 띄우지 않아도 된다. 앱이 도는 동안 추가한 스킬도 다음 대화에서 꺼진다. 기동 설정(`-c skills.config=…`)으로 넘기면 재시작 전까지 새 스킬이 두 번 보였을 것이다.
    - 설정은 앱 전용 `CODEX_HOME/config.toml`에 쌓이고 사용자의 `~/.codex`는 쓰지 않는다. 지운 스킬의 경로가 남아도 영향은 없다. 실패해도 대화는 막지 않는다(스킬이 두 번 보일 뿐이다).
    - 지금 겹치는 것은 사용자 스킬뿐이다. codex는 앱 전용 CODEX_HOME에서 돌고 스레드에 작업 폴더를 넘기지 않아서 프로젝트 스킬은 찾지 않는다. Linux에서는 codex의 HOME이 CODEX_HOME이라 사용자 스킬도 찾지 않는다.
    - 검토하고 쓰지 않은 것: `thread/start.selectedCapabilityRoots`는 `id`가 필요한 실험 API이고 스킬보다 플러그인 루트 쪽이었다.
  - 키 이름과 요청 모양은 실제 codex로 확인한다(`tests/codex-config.test.ts`). 다른 codex 테스트는 가짜 app-server라 어떤 `-c` 줄이든 받아들인다. 처음 넣은 `skills.bundled = false`는 codex가 설정 오류로 거절해 앱이 기동하지 않는 키였고, 가짜 서버 테스트는 모두 통과했다.

### 서브에이전트 (2026-09-15)

- fx 방식을 따른다: `run_subagent {task, instructions?}`는 일회 자식, `message_subagent {agent, message, instructions?}`는 부모 세션 안에서 이름으로 이어지는 자식이다. codex dynamic tool 스키마가 최상위 union을 받지 않을 수 있어 fx의 한 도구, 두 action 대신 두 도구로 나눈다. `instructions`를 생략하면 이전 지침을 유지한다.
- 자식은 같은 프로세스에서 TanStack `chat()`으로 돈다. 모델과 추론 강도는 부모 선택 그대로, workspace는 같은 프로젝트다. 부모 대화는 넘기지 않고 과제와 지침만 준다(필요하면 기억 도구로 찾는다).
- 자식 도구는 부모 도구와 같거나 그 이하다. 서브에이전트 도구는 없어서 중첩이 안 된다. 권한 모드, MCP 신뢰도 부모 그대로다.
- 자식의 승인 요청은 사용자에게 간다. 자식은 부모 run을 interrupt로 멈출 수 없으므로, 셸, 밖 쓰기, MCP 호출은 도구 실행 직전에 기다린다: `auto` 모드는 분류 모델이 먼저 판단하고, 남은 것은 페이지의 승인 카드("일회 서브에이전트: …")로 묻는다. 페이지는 run 중 1.5초마다 `GET /api/sessions/:session/approvals`로 확인하고, 답은 소유 탭만 보낸다. 이 중계(`RelayedApprovals`)는 외부 에이전트의 권한 요청에도 쓴다. 판정, 답은 부모 세션의 `permission_reviews`에 `subagent-<id>:<call id>`로 남는다.
- 한 단계에서 부른 여러 서브에이전트는 동시에 시작하고 결과는 호출 순서로 돌려준다. TanStack은 한 단계의 도구 호출을 차례로 실행하므로, middleware가 첫 호출 직전에 그 단계의 서브에이전트 호출을 모두 시작하고 각 호출은 자기 결과를 기다린다.
- 실행 중인 이름 있는 자식에게 온 메시지는 codex `turn/steer`로 그 턴에 넣고(`status: steered`), 넣을 턴이 없으면 앞 작업이 끝난 뒤 다음 메시지로 이어 실행한다.
- 부모 run을 취소하면 자식 run과 승인 대기가 함께 멈춘다(대기는 거부로 끝남). 서버가 다시 시작하면 `running` 자식은 `interrupted`가 되고 자동으로 다시 실행하지 않는다.
- 기록: 자식 대화 전체는 chat state(thread `subagent-<id>`)에, 상태, 마지막 과제, 답은 `subagents` 테이블에 남는다(일회 자식 포함). 부모 기억에는 서브에이전트 tool call(과제)과 tool result(자식 보고)가 남는다. 자식 내부의 도구 호출은 이번 버전에서 기억 노드로 만들지 않는다: 노드의 `user` 종류는 사용자 발언만 뜻하는데 자식의 과제는 부모 에이전트의 말이라 권위 규칙과 맞지 않기 때문이다. 자식 대화는 `GET /api/sessions/:session/subagents/:subagent`로 볼 수 있고, 화면에서 따로 펼쳐 보는 UI는 아직 없다.
- 이름 있는 자식을 이어 쓰는 것은 사용자의 세션 resume과 다르다: 이름은 부모 세션 안에서만 뜻이 있고, 다른 세션에서는 새 자식이 된다.

### ACP: 에디터가 이 에이전트를 부를 때 (2026-09-15)

- ACP 에이전트는 실행 파일의 `context-agent acp [--port 5173]`이다(저장소에서는 `packages/memory-agent/bin/context-agent-acp.ts`, `CONTEXT_AGENT_URL`, 기본 `http://127.0.0.1:5173`). 에디터(Zed 등)가 stdio로 실행하면, 이 프로세스는 실행 중인 앱의 HTTP API에 붙는 다리로만 일한다. 저장소를 직접 열지 않는 이유: turbovec 인덱스는 저장 루트마다 한 프로세스만 쓸 수 있고, 같은 대화, lease, 승인, 기억을 웹 화면과 함께 써야 해서다. 앱이 꺼져 있으면 "앱을 먼저 실행하세요"로 실패한다.
- ACP 세션 = 앱 대화. `session/new`는 `cwd`가 이미 등록된 프로젝트일 때만 새 대화를 만든다. 프로젝트 등록은 파일 도구 범위를 넓히므로 앱 화면에서만 한다. `session/load`는 저장된 대화를 update로 다시 보낸다.
- 에디터 연결마다 lease holder를 따로 가진다(탭 하나처럼). 다른 탭이 쓰고 있는 대화는 열지 않는다. 연결이 끊기면 lease를 놓는다.
- 답변은 AG-UI 이벤트를 ACP `agent_message_chunk`, `tool_call`, `tool_call_update`로 바꿔 보낸다. 승인(ask 모드 도구 승인, auto 모드 확인 요청, 서브에이전트 요청)은 에디터의 `session/request_permission`으로 묻고, "이번 한 번 허용"만 승인으로 본다. 항상 허용 옵션은 주지 않는다.
- `session/cancel`은 앱의 취소 API를 불러 run을 실제로 멈춘다.
- 에디터가 `session/new`에 넘기는 MCP 서버는 쓰지 않는다. 앱에서 신뢰한 MCP 설정만 적용된다.
- ChatGPT 로그인과 모델 선택은 앱에서 한다(`authMethods` 없음). 토큰은 다리에 오지 않는다.
- 검증: SDK 클라이언트로 다리를 실제 프로세스로 띄워 실행 중인 앱과 실제 모델(gpt-5.6-luna)로 셸 승인→결과까지 확인했다. Zed 앱 자체에서의 연결은 사용자 Zed 설정을 바꿔야 해서 아직 확인하지 않았다.

### ACP: 이 앱이 외부 에이전트를 부를 때 (2026-09-15)

- 외부 에이전트는 공통 `~/.context-generactive-agent/agents.json`, 프로젝트 `<프로젝트>/.agents/agents.json`에 Zed `agent_servers`와 같은 모양(`{"agents": {이름: {command, args?, env?}}}`)으로 적는다. 같은 이름이면 프로젝트 설정을 쓴다.
- 등록과 실행 승인을 나눈다(R17). 설정 화면에서 "신뢰"해야 쓸 수 있고, 신뢰는 적힌 명령, 인자, 환경 그대로(fingerprint, `agent_trust`)에만 적용된다. 신뢰해도 모델이 맡길 때마다(`delegate_to_agent`) 게이트를 거친다: ask 모드는 사용자, auto 모드는 분류 모델. 에이전트가 스스로 보내는 `session/request_permission`은 모드와 상관없이 페이지 승인 카드("외부 에이전트 codex: …")로 사용자에게 묻고, "이번 한 번 허용"만 고른다. 항상 허용(`allow_always`)은 고르지 않는다.
- 인증은 에이전트의 공식 방식이다. 프로세스에는 기본 환경(HOME, PATH, USER 등)과 설정에 적힌 env만 넘기고, 이 앱의 codex 홈, ChatGPT 토큰, Kagi 키는 넘기지 않는다. 앱은 파일, 터미널 capability를 빌려주지 않아서 에이전트는 자기 도구로 일한다.
- 맡길 때는 모델이 작업과 필요한 근거만 적어 보낸다(대화 전체, 기억 전체를 자동으로 보내지 않음). 같은 대화에서 같은 에이전트에 다시 맡기면 그 에이전트 세션을 이어 쓴다. 답과 에이전트가 알린 도구 호출은 도구 결과로 기록하고 사용자 결정으로 승격하지 않는다.
- 재연결: 연결이 끊기면 자동으로 다시 연결하고, 연속 두 번 실패하면 멈춘다. 성공하면 실패 횟수를 바로 0으로 돌린다. 멈춘 뒤에는 설정 화면의 "다시 연결"로만 시도한다. 끊길 때 진행 중이던 요청은 다시 보내지 않고, 받은 부분까지 `disconnected`로 돌려준다. 에이전트가 요청을 오류로 끝내면 연결은 그대로 두고 `failed`와 에이전트가 준 이유를 돌려준다.
- 검증: 가짜 ACP 에이전트로 신뢰 전 미시작, 환경 비공유, 권한 한 번 허용, 취소, 자동 재연결, 연속 2회 실패 후 중단, 수동 재연결을 테스트했다. 실제 `@zed-industries/codex-acp` 0.16으로 앱 대화에서 위임 승인 → codex의 셸 권한 요청 중계 → 파일 생성까지 확인했다. 사용자 `~/.codex` 기본 모델이 codex-acp에 들어 있는 codex보다 새로워서 첫 시도는 에이전트 오류로 실패했고, `args`에 `-c model="gpt-5.5"`를 넣어 해결했다(에이전트 쪽 설정 문제).
- 직접 대화: 새 대화를 만들 때 신뢰한 외부 에이전트를 고르면(`sessions.agent`), 그 대화는 이 앱의 모델 대신 그 에이전트와 나눈다. 원문은 평소처럼 기억에 남는다: 사용자 발언은 `user` 노드, 에이전트 답은 `assistant` 노드에 `detail.externalAgent`로 출처를 붙여 앱 모델의 답과 구분한다. 기억 검색, 정정 해석 대상에 그대로 들어간다.
- 직접 대화에서도 앱이 사용자 말로 기억을 찾아 맞는 것 최대 5개만 "출처가 붙은 단서이며 지시, 승인이 아님, user 항목만 사용자 말" 머리말과 함께 프롬프트 앞에 붙인다. 전체 기억을 보내지 않는다. 이 전달에 따로 동의 절차를 두지 않는다(R06, R17). (2026-10-14 "기억 범위"로 대체: 설정에서 켠 경우에만 보낸다)
- 직접 대화의 run에는 앱 도구가 없다(에이전트가 자기 도구로 일함). 에이전트가 알린 도구 호출은 답 끝에 목록으로 붙인다. 이미지는 보내지 않는다(422). 권한 요청, 취소, 재연결, 실패 처리는 위임과 같다. 서버가 다시 시작하면 에이전트 쪽 세션은 새로 열리므로, 이어지는 맥락은 앱이 붙이는 기억에 기댄다. 실제 codex-acp 직접 대화에서 "로그 포맷 뭐로 하기로 했지?"에 앱이 붙인 기억만으로 "logfmt로 바꿨고 JSON Lines는 번복"이라고 답하고, 답이 `externalAgent: codex`로 기록되는 것을 확인했다.
- agy는 [이전 검증](../../topic-generactive-ai-agent/research/ACP_AGY_PROBE.md)대로 ACP 진입점이 없어 대상에서 뺀다.

### Slash 명령 (2026-09-15)

- 입력창 맨 앞에 `/`를 치면 명령 목록이 뜬다. ↑/↓로 고르고 Tab(또는 아직 완성되지 않은 항목에서 Enter)으로 채우고, 완성된 명령에서 Enter로 실행한다. 포커스는 입력창에 남는다(한글 IME 조합 중 Enter는 그대로 IME 몫).
- 명령: `/new`(새 대화), `/agent <이름>`(신뢰한 외부 에이전트와 새 대화), `/skill <이름> [요청]`, `/recall <질문>`, `/mode ask|auto`, `/model <모델>`, `/settings`, `/cancel`, `/compact`(2026-09-17).
- skill도 `/<이름> [요청]`으로 바로 쓴다(2026-09-17). `/` 목록에 앱 명령 다음으로 보인다. 이름이 앱 명령과 같으면 명령이 먼저이고, 그 skill은 `/skill <이름>`으로 쓴다.
  - 이유: `/skill` 뒤에서만 보여서, `/draw`처럼 바로 치면 명령이 아닌 일반 메시지로 갔다.
- `/skill`, `/recall`은 모델에게 보내는 메시지로 바뀐다("read_skill로 읽고 따르기", "find_memory로 찾아 출처, 바뀐 결정과 답하기"). 따로 권한을 주지 않으며, 답변 중이면 평소처럼 대기열로 간다.
- 나머지는 앱이 바로 실행한다. 값이 없거나 모르는 값이면 실행하지 않고 이유를 보여준다.
- 우리 명령이 아닌 `/`로 시작하는 글(예: `/usr/local`)은 평소 메시지로 보낸다. 이미지가 붙은 입력은 명령으로 읽지 않는다.
- 목록은 shadcn `command`(cmdk)로 그리고, 파싱, 제안은 `slash-commands.ts`의 순수 함수로 테스트한다.

### 도구 성능 (2026-09-15)

- 측정은 `packages/memory-agent/bench/tools.bench.ts`(`vp test bench --dir bench`)로 한다. 파일 3,000개(1.4 MiB)짜리 합성 저장소(Git, 비Git), 모델, HTTP, UI 없이 도구 실행 경계만 잰다. 이 장비(M1 Pro) 평균값:

  | 작업                                      |   이전 |   이후 |
  | ----------------------------------------- | -----: | -----: |
  | list_files 전체, 비Git                    |  77 ms |  29 ms |
  | list_files 전체, Git                      |  78 ms |  43 ms |
  | search_files 전체 페이지(일치 600), 비Git | 561 ms | 141 ms |
  | search_files 전체 페이지(일치 600), Git   | 618 ms | 111 ms |
  | search_files 일치 없음, 비Git             | 609 ms | 138 ms |
  | search_files 일치 없음, Git               | 614 ms |  82 ms |
  | read_file 6,000줄 전체 페이지             |  33 ms | 0.7 ms |
  | run_shell `printf`                        |  10 ms |  10 ms |

- 바꾼 것:
  - 검색은 바이트를 먼저 보고, 대소문자 구분 검색어가 없는 파일은 UTF-8 해독, 줄 나누기, sha256을 하지 않는다. 일치 위치에서만 줄 번호를 센다.
  - 파일 읽기를 32개씩 미리 시작하고(결과는 순서대로), 디렉터리 경로 검사는 페이지마다 한 번, 파일 자체(링크, 일반 파일, 단일 링크)는 열린 handle에서 확인한다. 이전에는 파일마다 경로를 동기 lstat으로 다시 걸었다.
  - Git 작업 트리에서는 `git grep --untracked -F`로 후보 파일만 연다(목록 조회와 동시에 시작, 같은 스냅숏, 검색어의 다음 페이지는 결과 재사용). 대소문자 무시 + 비ASCII 검색어는 Git과 JS의 대소문자 규칙이 달라 전체 검색으로 간다.
  - Git 목록의 파일 확인(lstat)을 64개씩 동시에 한다. Git 없이 걸은 목록은 이미 일반 파일만 모았으므로 다시 확인하지 않는다.
  - read_file은 크기, ctime, mtime(ns), inode가 같으면 앞서 읽은 줄과 sha256을 재사용한다(최근 8개 파일). 쓰기, 편집, 삭제의 sha256 확인은 항상 새로 읽는다.
  - 한 모델 단계에서 읽기 전용 도구(기억, 파일, 밖 파일 읽기/검색, skill, Kagi)를 여러 개 부르면 첫 호출에서 모두 시작하고 결과는 호출 순서로 돌려준다(`parallelReads`). 그 단계에서 읽기 전용이 아닌 호출이 나오면 그 뒤의 읽기는 앞 호출이 끝난 뒤에 실행한다. 서브에이전트에도 같다.
- 검색 결과 계약 변경: 이진 또는 비UTF-8 파일은 그 파일 바이트에 검색어가 들어 있어 일치했을 수도 있을 때만 `skipped`로 알린다. 검색어가 없는 파일은 일치할 수 없으므로 알리지 않는다. 너무 크거나 읽지 못한 파일은 그대로 알린다.
- 셸은 이미 헬퍼 프로세스 없이 직접 실행해 10 ms라 바꾸지 않았다. 셸 중간 출력, 실행 handle(fx 방식)은 이번에 하지 않았다.

### 비밀 가리기 (2026-09-16)

- 출력에 실제로 찍힌 비밀을 기계적으로 가린다. 이름만 보고 막는 방식(위 환경 변수 필터, 모델 지침)은 어떤 값이 비밀인지 모델도 목록도 알 수 없어서 충분하지 않다. 환경 변수 필터는 그대로 두고, 그 위에 탐지기를 둔다(`SecretRedactor`).
- 탐지기는 둘을 합친다.
  - secretlint 13.0.5 core + recommended preset: OpenAI, Anthropic, AWS, GCP, GitHub, Slack, Stripe, 개인 키, 비밀번호가 든 접속 문자열 등 약 30개 서비스를 형식으로 찾는다. 규칙이 정밀해서 sha256, UUID, 커밋 해시는 건드리지 않고, 문서의 예시 키(`AKIAIOSFODNN7EXAMPLE`)도 보고하지 않는다. 순수 JS이고 프리셋이 한 파일이라 실행 파일에 번들된다(+0.5 MB). 198 KB 로그에 4 ms.
  - 비밀처럼 보이는 이름 옆에 찍힌 값(`KAGI_API_KEY=…`, `"password": "…"`): 형식이 없는 키를 잡는다. 코딩 에이전트는 코드를 계속 읽으므로 오탐을 줄이는 쪽으로 좁혔다. 대문자 환경 변수 이름은 대소문자를 구분해 보고(`const tokenCount = total`은 제외), 소문자 설정 키는 값이 따옴표에 싸일 때만 보며(`password: getPassword()`는 제외), `process.env.X`, 점으로 이은 식별자, `${…}`, `changeme` 같은 자리표시자는 값으로 치지 않는다.
  - 검토한 대안: gitleaks는 규칙이 가장 많지만 Go 바이너리라 플랫폼마다 배포하고 호출마다 프로세스를 띄워야 한다. 엔트로피 기반 탐지는 파일 도구가 sha256을 계속 찍어서 오탐이 폭증한다. `secretlint-rule-pattern`은 정규식 하나에 micromatch와 선언만 된 `@secretlint/tester`가 딸려 와서 쓰지 않는다.
- 두 탐지기가 같은 구간을 겹쳐 보고하므로 구간을 합친 뒤 `[redacted:<종류>]`로 바꾼다. 따로 바꾸면 앞 치환이 옮긴 글자를 잘라 문자열이 깨진다(실측에서 재현).
- 들어오는 길에서 가린다.
  - 모든 도구의 결과와 던진 에러 메시지: 모델, 페이지, 노드, 대화 기록에 닿기 전에. 셸, 파일 읽기, 웹, MCP, 외부 에이전트 어느 것이든 키를 찍을 수 있어서 도구를 가리지 않는다. 결과의 JSON 구조는 그대로 두고 문자열만 바꾼다.
  - 기록 middleware: assistant 글, 도구 호출 인자, 참조 URL(쿼리에 토큰이 있을 수 있다), 실패 메시지. 훅마다 가리기를 먼저 끝내고 검사와 기록 사이에 await를 두지 않는다.
  - 사용자 발언과 대기열 메시지: 모델은 보낸 그대로 읽고 기억에는 키를 뺀 채로 남긴다. 붙여 넣은 키는 그 턴에 쓰일 뿐 기억할 대상이 아니다.
  - 이관: 다른 에이전트 기록의 글, 인자, 참조.
- 알려진 대가(2026-10-12 "가려진 값 주변 편집"으로 해소): 파일에 든 키는 모델에게 가려져 보이므로, 그 줄을 `edit_file`로 고치려 하면 `oldText`가 맞지 않아 실패한다. 모델이 키를 모르니 다시 써 넣을 수도 없다. `.env` 같은 자격 증명 파일은 원래 파일 도구가 거부한다.
- 이미 저장된 것은 소급해서 가린다(`SecretSweep`). 앱이 시작해 에이전트를 처음 만들 때 백그라운드에서 돈다.
  - 노드는 여전히 수정 불가 증거이고, 예외는 정리 작업 하나다. 트리거를 끄지 않고 좁힌다: `secret_sweep_permits`에 허가가 있는 노드의 `text`만, 나머지 컬럼은 그대로일 때만 바뀐다. 정리 작업이 같은 트랜잭션에서 허가를 쓰고 지운다.
  - 노드 텍스트에서 만든 것도 같이 고친다. trigram FTS는 옛 텍스트를 빼고 새 텍스트를 넣고, 형태소 terms와 벡터는 지워서 인덱서가 가린 텍스트로 다시 만든다. 벡터는 인덱서처럼 DB 커밋 전에 저장한다(도중에 죽으면 크기가 어긋나 다시 열 때 재구성된다). 인덱서의 배치 잠금 안에서 해서, 배치가 옛 텍스트로 만든 결과를 정리 뒤에 기록하는 일이 없다.
  - 노드와 참조는 추가만 되므로 저장된 위치부터 이어서 훑는다(오래된 빌드가 쓴 것도 다음 시작에 잡힌다). 대화 기록, 승인 요청, 권한 판정 입력, 대기열, 서브에이전트, 해석 이유는 행 안에서 갱신되고 들어오는 길에서 다 가리지 않으므로 시작마다 전부 훑는다. 행 수가 적다.
  - 이 기기 실제 DB 사본(노드 9,759개, 그중 이관 9,531개)에서 비밀이 든 노드는 1개였다. 서비스 형식 키를 따로 넓게 세어도 0개여서 결과와 맞다.
  - 탐지 규칙이 더 찾게 바뀌면 `sweepVersion`을 올려 처음부터 다시 훑는다.
- 검증: 가짜 codex가 받은 도구 결과를 답변에 되읊으므로, 필터를 거치지 않는 스트림에 키가 없는지로 모델이 받은 값을 확인한다. 실행 파일은 스모크 테스트가 두 실행 사이에 비밀이 든 노드를 넣고 시작 시 가려지는지 본다(번들된 탐지기를 실제로 돌리는 유일한 검사).

### 다른 에이전트 대화 이관 (2026-09-16)

- Claude Code(`~/.claude/projects/**/*.jsonl`)와 Codex CLI(`~/.codex/sessions/**/rollout-*.jsonl`)가 로컬에 남긴 대화를 노드로 옮긴다. 새 출처는 어댑터 파일 하나와 `ImportSourceName` 태그 하나로 붙는다.
- 추출할 수 있는 발언과 도구 기록을 모두 옮긴다. `tool_call`, `tool_result`도 노드로 만들고, 구조 edge(`next`, `reply`, `calls`, `returns`, `touches`)를 라이브와 같은 규칙으로 세운다. 옛 대화도 `trace_evidence`로 근거를 따라갈 수 있게 하기 위해서다. 도구 인자의 파일 참조를 읽는 `RefArguments`에 Claude Code가 쓰는 `file_path`, `notebook_path`를 더했다(라이브 MCP 도구에도 같이 적용).
- `Nodes.append`는 건드리지 않고 `BulkNodes`를 따로 둔다. `append`는 대화 한 건을 지금 시각으로 붙이고 노드마다 트랜잭션을 연다. 라이브 턴에는 맞지만 수천 줄 기록에는 맞지 않아서, 여러 노드를 한 트랜잭션에 넣고(2026-09-16부터 200개씩 끊어서) 줄의 원래 `timestamp`를 `created_at`에 그대로 쓰는 경로를 따로 만들었다. 노드는 여전히 수정 불가 증거다.
- CLI가 사용자 쪽에 써 넣은 글은 버린다. 슬래시 명령 봉투(`<command-name>`), `<local-command-stdout>`, `[Request interrupted…]`, 압축 요약, Codex의 `<environment_context>`, `<codex_internal_context>`, `# AGENTS.md instructions`, 에이전트 인계문. 정정과 취소 권위가 사용자 발언에만 있어서, 이걸 사용자 말로 두면 기억이 틀린 근거를 갖는다. Claude의 `isSidechain`(서브에이전트 줄기), `isMeta`, Codex의 `reasoning`도 버린다.
- 기록의 `cwd`를 프로젝트로 자동 등록한다(2026-09-16). 등록된 프로젝트(숨긴 것 포함) 중 가장 깊은 뿌리가 임자이고, 없으면 그 폴더를 등록한다. 등록이 파일, 셸 도구가 닿는 범위를 넓히는 것은 그대로지만, 옮길 폴더가 전부 사용자 본인의 작업 폴더이고 스무 개를 손으로 등록하는 것이 이관의 걸림돌이어서 사용자가 자동 등록을 택했다. 권한 모드는 새 프로젝트 기본값 `ask` 그대로라 도구 호출 승인은 느슨해지지 않는다. 등록할 수 없는 폴더(없어짐, 폴더 아님, 저장 루트 안)는 `import_cursors.skipped`에 이유와 함께 남겨 설정 화면에 보여 준다.
  - 짝이 되는 장치로 프로젝트를 목록에서 뺄 수 있다(`projects.hidden_at`). 사이드바에서만 빠지고 대화, 노드, edge, 검색은 그대로다. 같은 폴더를 다시 추가하면 돌아온다(`Projects.add`가 숨김을 푼다). 이관은 숨긴 프로젝트도 임자로 인정해서, 치운 폴더의 기록이 두 번째 프로젝트를 만들지 않는다.
  - 완전 삭제(노드, 벡터, FTS, 형태소, edge, 해석까지)는 대화 완전 삭제와 같은 문제를 안고 있어 함께 미룬다.
- 이어붙이기. 파일마다 `import_cursors`에 byte offset을 두고 거기서부터 읽는다. 마지막 개행까지만 소비해서, 실행 중인 에이전트가 쓰는 중인 꼬리 줄을 반으로 읽지 않는다. `size`, `mtime`이 커서와 같으면 건너뛰고, 파일이 짧아졌으면 처음부터 다시 읽는다. 중복은 `imported_nodes`(출처 + 줄 id)가 막는다. `config.json`의 `importsEnabled`를 켜면 5분마다 따라붙는다(`fs.watch` 재귀는 Linux에서 안 돼서 폴링).
- 저장 루트 아래는 읽지 않는다. 앱 전용 `CODEX_HOME`이 거기 있어서, 앱 자기 대화를 노드로 두 번 넣게 된다.
- 기록 하나 = 세션 하나이고, 세션의 `created_at`은 그 도구가 대화를 시작한 시각이다(목록이 `created_at DESC`라 제 날짜 자리에 꽂힌다). `run_id`는 사용자 턴마다 그 노드의 id로 잡는다. `history.ts`가 `run_id`로 답변을 묶으므로 이관한 대화가 화면에서 턴 단위로 그대로 재생된다.
- 인덱싱과 해석은 보낸 날짜 내림차순이다(2026-09-16). 이관한 노드는 `seq`가 크고 시각이 옛날이라, `seq` 순으로는 방금 나눈 대화보다 먼저 처리된다. 세션 안에서는 그대로 시간순이다.
  - run 뒤 뒷정리는 예산(`indexUpTo(200)`)만큼만 한다. 예전처럼 `indexAll()`이 남은 게 없을 때까지 돌면, 이관 뒤 첫 run이 backlog를 다 비울 때까지 `analyzeAll`, `runPending`이 시작도 못 한다.
  - 남은 backlog는 `Importer`의 전용 fiber가 비운다. 인덱서가 배치마다 permit을 놓아서 그 사이의 대화가 여전히 먼저 인덱싱된다.
- 도구 결과도 라이브와 똑같이 임베딩한다. 라이브 인덱서에 kind 필터가 없어서 `tool_result`는 이미 벡터에 들어간다. 이 기기 기록 기준으로 이관할 `tool_result` 14,004개의 토큰 중앙값은 206이고 상한(2048)에 걸리는 건 2,499개뿐이라, 배치 수가 2,051(발언+`tool_call`)에서 6,003(전부)으로 느는 정도다. 전용 fiber에서 돌고 워터마크로 이어받으므로 대화를 막지 않는다.
- 이관은 사용자가 켜는 서버 기능이고 모델 도구로 내보내지 않는다. `~/.codex`는 파일 도구의 자격 증명 거부 목록에 그대로 남는다. 이관한 노드의 `detail.importedFrom`으로 출처를 남기고, 모델 지침에 그 승인, 권한이 여기로 넘어오지 않는다고 적는다.

### 가져오기 worker와 실패 격리 (2026-09-16)

- 기록 하나가 실패해도 회차는 계속한다. 기록을 읽거나 노드를 쓰다 난 예외는 Effect의 defect라, 기록마다 둔 `orElseSucceed`가 잡지 못하고 회차 전체를 끝냈다. 정렬상 앞의 기록이 매번 실패하면 "기록 N개 중 0개를 읽어"로 영영 남는다(다른 클라이언트에서 764개 중 0개로 보고됨, 읽기 권한을 뺀 기록으로 재현).
  - 이제 기록마다 `catchAllCause`로 받아 `import_cursors.failure`에 이유(오류 메시지 300자, 기록 내용은 넣지 않음)를 남기고 넘어간다. `size`를 -1로 두어 다음 회차에 다시 시도하고, 읽은 위치와 쓴 노드 수는 그대로 둔다. 설정 탭에 원천별 실패 수와 실패한 기록(최대 20개)을 보인다.
- 가져오기 회차는 import worker(`imports/worker.ts`)에서 돈다. 기록 읽기, 줄마다 비밀 가리기, 노드 쓰기가 메인 스레드에서 돌아 그동안 서버 요청이 모두 멈췄다(기록 40개, 1만 2천 줄에 메인 스레드 3.7초 정지, worker로 옮긴 뒤 최대 지연 2ms).
  - worker는 같은 DB에 따로 연결을 열고 회차에 필요한 서비스(프로젝트, 세션, `BulkNodes`, 설정, 비밀 가리기)만 둔다. 기록 폴더 훑기(개수 세기)도 worker가 한다. 메인의 `Importer`는 회차를 시작하거나 도는 회차에 합류하고, 진행 상황(`activity`: running/finished/crashed)을 개요에 싣고, 끝나면 임베딩을 이어 붙인다.
  - 설정의 "읽기", "켜기"는 회차를 시작만 하고 바로 답한다. 설정 탭은 도는 동안 1초, 인덱싱이 남아 있으면 3초마다 개요를 다시 묻는다.
  - SQLite는 WAL이어도 쓰는 연결은 한 번에 하나다. 읽기는 동시에 되지만 쓰기는 잠금을 차례로 잡고, 메인 스레드는 `busy_timeout`만큼 동기로 기다린다. 그래서 worker는 기록 하나의 노드를 200개씩 끊어 쓴다. 끊어 쓰려면 이어 쓸 때 열린 턴을 정확히 알아야 해서, `BulkNodes`는 마지막 사용자 발언 뒤의 답변만 이어받는다(전에는 앞 턴의 답변에 도구 호출이 붙을 수 있었다).
  - 저장소에서는 Node가 `worker.ts`를 TypeScript 그대로 돌린다. 실행 파일에는 `scripts/package.ts`가 `vite-plus/pack`의 `build()`로 의존성까지 한 파일(`import-worker.mjs`)로 묶어 runtime 폴더에 넣는다.
- secretlint profiler는 끈다. 기본으로 켜져 있어 검사 한 번마다 performance mark 62개를 남기고 profiler 배열에도 쌓아, 많이 검사하면 메모리가 새고 `MaxPerformanceEntryBufferExceededWarning`이 났다(200번 검사에 mark 12,400개). 주기적으로 지우는 대신 `SecretRedactor`를 만들 때 끈다.
- 설정 탭의 숫자는 motion(`useSpring`/`useTransform`)으로 새 값까지 부드럽게 바뀐다(`components/ui/animated-number.tsx`). `AnimateNumber`는 Motion+ 전용이라 쓰지 않는다. 움직임 줄이기 설정이면 바로 바뀌고, 화면 읽기에는 값만 준다. Motion 문서는 프로젝트 MCP(`https://mcp.motion.dev`)로 본다.
- 날짜 포맷은 dayjs로 쓴다(`app/lib/dates.ts`, memory-agent 지침의 오늘 날짜). ko 로케일은 호출마다 붙이고, 개발 서버 SSR 때문에 `dayjs/locale/ko.js`처럼 확장자를 적는다.
- 개발 서버의 런타임은 모듈이 다시 로드돼도 유지된다. memory-agent의 서비스나 스키마를 바꾸면 개발 서버를 다시 시작해야 새 서비스와 마이그레이션이 적용된다(안 하면 새 UI가 옛 개요를 받아 깨진다).
- 인덱싱과 가져오기의 시간 구성(실측, 이 기기).
  - 인덱싱: 모델 추론이 99.4%(노드 600개에 41.8초), 벡터 인덱스 추가, 저장과 SQL은 합쳐 0.7%다. 2048토큰짜리 텍스트 하나가 짧은 텍스트(약 10ms)의 50-75배(460-760ms)다. 상한이 512토큰이면 약 70ms, 1024토큰이면 약 157ms다.
  - 형태소 분석(Kiwi)은 텍스트당 약 12ms다.
  - 가져오기 worker: SQLite 쓰기 80%, secretlint 8%, 줄 읽기와 파싱 2%다. SQLite 쓰기의 71%는 FTS trigram 트리거다.
  - ONNX 스레드 수 조정은 측정 편차가 커서 적용하지 않았다.
- 임베딩은 지금 방식(CPU, quint8, 2048토큰)을 유지한다(2026-09-16). GPU 실행과 입력 상한을 비교했지만 당장 바꾸지 않기로 했다. 비교 결과(프로세스 물리 메모리, Apple Silicon이라 GPU 메모리 포함):

  | 상한 | 방식        | 짧은 텍스트 | 긴 텍스트 | CPU         | 적재 직후 | 최고   |
  | ---- | ----------- | ----------- | --------- | ----------- | --------- | ------ |
  | 2048 | CPU quint8  | 14–15ms     | 550–680ms | 3.4–3.7코어 | 650MB     | 1.3GB  |
  | 2048 | WebGPU fp32 | 10.5–12ms   | 500–650ms | 0.7–0.8코어 | 1.76GB    | 2.9GB  |
  | 1024 | CPU quint8  | 11.8ms      | 184ms     | 3.9코어     | 665MB     | 885MB  |
  | 1024 | WebGPU fp32 | 10.3ms      | 115ms     | 0.3코어     | 1.76GB    | 2.05GB |
  | 512  | CPU quint8  | 20.6ms      | 88ms      | 2.9코어     | 680MB     | 800MB  |
  | 512  | WebGPU fp32 | 10.3ms      | 53ms      | 0.3코어     | 1.76GB    | 1.9GB  |
  - WebGPU(fp32)는 CPU를 80-90% 덜 쓰고 결과가 fp32와 같지만(quint8은 코사인 평균 0.954, 최소 0.878), 메모리를 적재 직후 1.1GB, 최고치에서 0.9-1.6GB 더 쓴다. WebGPU에서 quint8은 정수 연산이 CPU로 돌아가 오히려 느리다(긴 텍스트 2.6초).
  - CoreML은 MLProgram(CPU+GPU, ANE)과 NeuralNetwork(CPU+GPU) 모두 이 모델을 적재하거나 실행하지 못한다.
  - 다시 볼 때의 후보: 속도는 입력 상한(1024, 512)이 가장 크게 바꾸고, CPU 부하가 문제면 WebGPU다. WebGPU의 적재 직후 메모리(모델을 CPU에도 들고 있는지)는 확인하지 않았다.
  - 같은 날 실행 방식은 아래 "임베딩 실행 방식 고르기"로 바뀌었다. 입력 상한 2048토큰은 그대로다.

### 비밀 소급 정리의 탐지 worker (2026-09-17)

- `SecretSweep`의 비밀 탐지는 redaction worker(`secrets/redact-worker.ts`)에서 한다. secretlint 검사는 텍스트 사이사이 이벤트 루프에 차례를 주지 않아서, 스윕이 도는 내내 메인 스레드가 멈췄다. 스윕은 시작할 때마다 지난번 이후의 노드를 훑는데, 가져오기 직후면 가져온 노드 전부다.
  - 실측(노드 3만 개, 5개 중 1개는 약 4.6KB 도구 출력): 메인 스레드가 1.86초 동안 한 번도 돌지 않았다. worker로 옮긴 뒤 최대 지연은 비밀이 없으면 2ms, 500개에 1개꼴로 있으면 103ms다. 전체 시간은 1.9초에서 2.4초로 늘었다(worker 시작 포함).
  - 남은 103ms는 비밀을 찾은 배치마다 벡터 인덱스를 저장하는 비용이다. 이 기기의 실제 DB(노드 1.37만 개, 텍스트 19MB)에서 지금까지 가린 노드는 1개라 그대로 둔다.
- 스윕 흐름(배치 읽기, 노드 텍스트 바꾸기, 벡터, FTS, 형태소 정리, 진행 위치 저장)은 메인에 둔다. 노드를 바꾸려면 인덱서의 허가를 잡고 메인이 가진 벡터 인덱스에서 지워야 해서, 스윕 전체를 worker로 옮기면 worker와 메인이 배치마다 주고받아야 한다. 탐지만 옮기면 메인에는 200행씩 읽고 바뀐 행만 쓰는 일이 남는다.
  - worker는 스윕마다 띄우고 끝나면 끈다. 스윕은 시작할 때 한 번 돌고, secretlint 규칙을 계속 들고 있을 이유가 없다.
  - 요청은 배치 단위다: 노드, 참조는 200개씩, 다른 표는 열마다 한 번. JSON 열은 worker가 풀어서 문자열만 가리고 다시 묶는다.
  - 실행 파일에는 가져오기 worker처럼 `scripts/package.ts`가 한 파일(`redact-worker.mjs`, 약 780KB)로 묶어 넣는다.
- 가져오기가 프로젝트를 등록해도 사이드바는 새로 고칠 때까지 옛 목록이었다(데모 녹화 중 발견). 설정 창을 닫을 때 프로젝트와 지금 프로젝트의 대화 목록을 다시 불러온다.

### 기억 범위 (2026-10-14)

- 설정 → 기억 → "기억 범위"에 두 스위치를 둔다. 둘 다 처음에는 꺼져 있고 `config.json`에 저장한다.
- "다른 프로젝트 기억도 찾기"(`crossProjectRecall`): 켜야 기억 도구와 압축 뒤 retrieval appendix가 다른 프로젝트를 찾는다. 켜도 사이드바에서 다른 프로젝트 검색을 막은 프로젝트는 제외한다. 끄면 지금 프로젝트만 찾는다. 다른 프로젝트 기억이 노이즈나 프라이버시 문제가 될 수 있어서 기본을 껐다.
- "외부 에이전트에 기억 보내기"(`externalAgentMemory`): 켜야 외부 ACP 에이전트와의 직접 대화에서 관련 기억 최대 5개를 메시지 앞에 붙인다. 외부 프로세스로 나가는 내용이라 동의를 설정에서 받는다. ACP에는 클라이언트가 에이전트에게 동의를 묻는 표준 흐름이 없어서, 대화마다 묻는 대신 이 스위치 하나로 정했다.
- 설정을 읽지 못하면 둘 다 꺼진 것으로 다룬다.

### 외부 ACP 에이전트 재연결 대기 (2026-09-30)

- 연결이 끊겼을 때 자동 재연결 간격을 500ms에서 100ms로 줄인다. 연속 두 번 실패하면 멈추고 진행 중이던 요청을 다시 보내지 않는 규칙은 유지한다.

### 셸 취소 후 파이프 정리 (2026-09-30)

- 제한 시간이나 취소로 셸 리더가 끝났다면 남은 프로세스 그룹을 즉시 강제 종료하고, 그래도 닫히지 않는 출력 파이프는 100ms 뒤 버린다. 리더가 종료하지 않으면 기존 3초의 정상 종료 유예를 유지한다. 분리된 자식이 파이프를 붙잡은 사례에서 완료 보고가 약 4초에서 0.6초로 줄었다.

### 백그라운드 실행의 Effect 수명과 종료 처리 (2026-10-04)

- `BackgroundTasks.start`는 Promise 콜백 대신 환경이 제공된 Effect 작업을 받는다. 셸·ACP Promise는 전용 SDK 연결 경계에서 Effect로 변환한다. 그 연결의 취소 finalizer는 원본 작업의 종료를 기다리며, 내부 실행은 Fiber/interruption으로 관리한다.
- 부모 취소 신호도 Effect interruption으로 변환한다. 작업의 `Exit`에 따라 완료·실패·취소를 한 번 기록하고 작업 finalizer가 끝난 뒤 종료 상태와 알림을 전달한다. 접수 기록과 fiber 등록은 짧은 중단 불가능 구간으로 묶고 동시 동일 호출은 직렬화하여 중복 실행을 막는다.
- 실행 오류, 결과 저장·디코딩 오류, Work Trace 오류와 접근 거부를 typed error로 분리한다. 결과 저장 실패를 실행 실패로 다시 저장하지 않는다. 저장 실패 시 Work Trace에 `background_result_storage_failed`를 남기고 결과 조회에는 사용 불가·재실행 주의 상태를 전달한다. Work Trace 종료 기록 자체도 실패하면 성공 알림을 내보내지 않고 운영 오류를 기록한다.

### 병렬 위임과 백그라운드 도구 실행 (2026-10-04)

- 메인은 독립 작업·세션 Goal/Plan·통합·최종 검증을 소유한다. 자식은 배정된 작업만 수행하며 세션 워크플로·메모리 승격·외부 재위임 도구를 받지 않는다. 부모 워크플로와 자동 후속 턴 문맥도 자식 프롬프트에서 제외한다. 위임에는 선택적인 담당 영역과 완료 기준을 전달한다.
- 여러 자식 보고서는 `get_subagent_reports`로 병렬 조회하되 각 attempt의 검토 이력을 따로 남긴다. 조회와 채택은 분리하며 최종 답변의 근거는 기존 `adopt_subagent_reports`로 기록한다. 자식의 큰 현재 도구 출력은 원본을 보관하고 미리보기와 페이지 조회 참조를 전달한다.
- 메인의 `run_shell`과 `delegate_to_agent`는 기본 1초까지만 완료를 기다린다. 오래 걸리면 Work Trace task/attempt 접수를 반환하고 실행을 계속한다. `yieldMs: 0`은 즉시 반환하며, 빠르게 끝나면 기존 형태의 결과를 반환한다. 승인 정책·명령 타임아웃·ACP 직렬화는 유지한다. 자식 셸은 기존 동기 실행을 유지한다.
- 완료는 기존 운영 알림과 idle 후속 턴으로 전달한다. `get_background_result`는 해당 세션의 삭제되지 않은 결과를 4000자 페이지로 제공한다. 요청·결과는 비밀정보를 제거한 뒤 저장한다. 세션/작업 취소와 삭제는 실행 정리를 기다리며 저장 결과도 삭제한다. 같은 run/tool-call 재전송은 실행을 반복하지 않는다. 재시작 시 미완료 작업은 interrupted로 남기며 자동 재실행하지 않는다.
- 실제 모델 평가는 임시 프로젝트와 현재 선택된 OpenAI 계정·모델로 지침만 비교한다. 요청 횟수와 입력 추정 예산을 제한하며 사용자 설정은 바꾸지 않는다. 2026-10-04 `gpt-6-sol`/medium 1회씩에서 두 지침 모두 자식 실행 중 부모의 파일 읽기·보고서 검토·정답 반환을 확인했다. 실행 시간은 약 52.8초/49.8초, 응답은 각 9회였지만 표본 하나이며 구 런타임 대비 속도·비용 개선의 증거로 사용하지 않는다.
- MCP 지연 스키마 탐색은 이번 변경에서 적용하지 않는다. 설치된 SDK의 discovery 도구가 승인·native owner·복구 경계를 통과하는 검증을 먼저 마련해야 한다. MCP/외부 위임의 승인 안내는 실제 프로젝트 모드에 맞춘다.

### 서브에이전트 실행 중 메인 작업 지속 (2026-10-04)

- 메인 에이전트는 위임 전에 자신이 수행할 독립 작업을 남겨 두고, 서브에이전트와 파일·영역 소유권을 나눈다. 위임 직후 자신의 작업을 수행하며 완료 여부를 반복 조회하지 않는다.
- `wait_subagents`의 기본 `timeoutMs`는 0이다. 현재 상태를 즉시 반환하고 미완료이면 `pending`과 독립 작업을 계속하라는 안내를 반환한다. 이미 완료된 시도는 타이머 없이 `completed`로 반환한다.
- 양수 timeout은 메인 모델 진행을 멈추므로 독립 작업이 모두 끝나고 다음 단계에 서브에이전트 결과가 필요한 경우에만 사용한다. 명시적 대기의 any/all·제한 시간·취소 동작은 유지한다.
- 기존 완료 알림을 다음 모델 단계 또는 유휴 상태의 자동 후속 실행에 전달한다. 대기와 알림은 보고서 검토를 대신하지 않으며 결과 사용 전 `get_subagent_report` 조회와 채택 절차를 유지한다.

### 셸 도구의 실행 설명과 스킬 목록 전달 (2026-10-05)

- 일반 채팅뿐 아니라 Goal/Plan/Execute/Verify 등 워크플로 단계에서도 현재 사용 가능한 스킬 목록과 `read_skill` 안내를 메인 모델에 전달한다. 각 단계의 도구·권한 제한은 그대로 적용한다.
- `run_shell` 설명은 유한한 비대화형 셸 스크립트 실행, 작업 디렉터리, 결과·종료 상태와 실행 제한을 설명한다. 빌드·테스트·git 등의 사용 사례를 강조하거나 다른 탐색 도구·스킬을 권하지 않는다. 일반 지침에 추가했던 특정 도구 우선 선택 안내도 제거한다.
- 실행 중 응답은 성공 증명이 아니며 `get_background_result`로 최종 결과를 조회한다는 계약은 유지한다. 백그라운드 실행과 `yieldMs` 기본 대기 시간은 변경하지 않는다.

### 첨부파일 변환의 서비스 수명 (2026-10-07)

- 첨부파일의 선행 모델 이미지 변환은 Attachments 서비스 Scope에 연결한 Fiber가 소유한다. 같은 콘텐츠 해시의 진행 중 변환을 공유하고, 완료되면 추적 항목을 제거한다.
- Sharp와 원자적 파일 게시를 수행하는 네이티브 Promise는 중간 취소 대신 완료를 기다린다. 런타임 종료는 해당 작업이 정리된 뒤 반환하며, 파일 I/O를 수행하는 작업이 저장소 삭제 뒤에 남지 않게 한다.
- 파일 fixture는 FileSystem·Path 서비스를 테스트 Scope에 제공한다. 마이그레이션 검증의 실제 SQLite 연결과 재열기 계약은 유지하고, 연결 종료가 임시 디렉터리 제거보다 먼저 이루어지게 한다.
- 테스트 임베더의 SHA-256 계산은 Effect Crypto를 사용하되 기존 문자 분할·UTF-8·정규화 결과와 동기 fixture API를 보존한다. NodeCrypto의 자원이 없는 Layer와 동기 digest 계약을 확인하고, 동기 실행은 SQLite 등 네이티브 fixture 진입점에만 둔다. 일반 임베더 호출은 Effect 안에서 직접 계산하고 실패를 EmbeddingError로 전달한다.

### 저장된 도구 결과와 파일 도구의 범위 I/O (2026-10-10)

- `read_tool_result`는 프로젝트·세션·종류 조건을 SQLite 범위 조회에 포함한다. UTF-16 페이지 계약을 유지하기 위해 UTF-8 바이트/UTF-16 오프셋 체크포인트만 캐시하며, 새 결과는 저장 시 인덱싱한다. 기존 결과는 최초 조회 시 취소 가능한 순차 스캔으로 인덱싱한다. 비밀 재정리는 캐시와 진행 중인 스캔을 무효화한다. SQLite 내부의 전체 레코드 로딩까지 제거했다고 주장하지 않는다.
- `read_file`과 `read_outside_file`은 전체 해시·UTF-8 검증을 최초에 순차 스캔하고, 이후 페이지는 실제 바이트 범위만 읽는다. 캐시에는 파일 stat과 해시·줄 바이트 오프셋만 남긴다. 2 MiB 제한, CRLF, 긴 줄의 명시적 축약, 기존 줄 번호·sha256 계약을 유지한다.
- 일반 파일 검색은 범위 페이지를 순차 처리한다. 여러 줄 쿼리와 긴 줄은 정확성을 위해 제한된 전체 파일 경로를 유지하고, 선행 읽기는 4개로 제한한다. 목록은 정렬된 고정 스냅샷이므로 전체 경로 목록은 유지하되 디렉터리 엔트리를 스트리밍하고 자식 탐색 전에 핸들을 닫는다.
- SDK 취소 신호를 Effect 실행에 전달한다. 파일의 취소 불가능한 단일 native read가 끝난 뒤 Scope가 close하며, Git 프로세스의 종료도 기다린다. interruption은 I/O 오류로 변환하지 않는다. 설계·측정·검증의 제한은 [I/O 범위 읽기 측정](io-range-performance.md)에 기록한다.

### Background 결과 조회의 확정된 읽기 실패 (2026-10-11)

- `get_background_result`는 저장된 task와 결과만 조회하므로 읽기 도구 목록에 포함한다. 없는 task나 결과 조회 오류는 owner가 확정된 실패 결과로 SDK에 전달하며, RPC 성공과 도구 성공을 구분한다. 실패 결과를 성공한 도구나 완료 근거로 기록하지 않는다.
- `cancel_background_task`는 같은 목록에 넣지 않는다. 쓰기 도구의 예외·worker 종료에 대한 uncertain 기록과 재실행 차단을 유지한다. 이번 변경은 기존 uncertain 기록을 수정하거나 자동 복구하지 않는다.

### 검증된 background 읽기 실패의 명시적 복구 (2026-10-11)

- 현재 Goal의 terminal 실패 run에서 마지막 `get_background_result` 하나만 uncertain인 경우, 직전 승인·binding·durable Failure와 다른 미완료 작업의 부재를 검증한 operator API가 별도 불변 receipt를 남긴다. schema 49는 원본 failed/uncertain/Failure를 보존하며 성공·완료 근거를 위조하지 않는다.
- 새 run의 입장 검사와 owner effect fence는 receipt를 원본과 대조하여 해당 과거 run만 제외한다. 원래 run ID 재입장과 그 run의 새 read/write RPC 예약은 계속 거부한다. 다른 pending/uncertain, stale preview, 변경된 원본과 새로운 Goal의 별도 보호는 유지한다.
- API는 fresh assessment digest·no-replay 확인·운영자가 복원 검증한 일관된 백업 식별자·세션 lease/cross-site 검사를 요구한다. 백업 확인은 operator assertion이며 API의 파일 검증이 아니다. 모델 도구로 제공하거나 메시지/agent 실행을 자동 요청하지 않는다. 실제 적용은 충분한 백업 공간과 복원 검증, 공유 서버 재시작/receipt 적용 승인을 확보한 뒤 진행한다.

### 최소 읽기 복구와 DB 단일 기준 (2026-10-11)

- 한 건의 append-only 읽기 복구에는 원본 관련 레코드의 일관된 snapshot을 격리 DB에서 복원 검증하고 불변 revoke event로 차단을 되돌릴 수 있으면 `operator_verified_original_records`를 허용한다. 전체 DB backup만을 요구하는 앞선 판단을 수정한다. 실제 backup 검증은 operator 책임이며 전체 DB 복원 가능성을 보장하지 않는다.
- 이미 실제 저장소에 적용된 schema 49를 유지하며 추가 version을 만들지 않는다. 실패 run·uncertain RPC·durable Failure는 수정하지 않고 새 run만 허용한다. 같은 binding 검사 함수의 preview로 admission을 확인하며 메시지·모델 호출·재생은 하지 않는다.
- DB의 `user_version`과 실제 column 계약이 실행 경계의 기준이다. app만 단일 `BEGIN IMMEDIATE`에서 lock 뒤 버전을 다시 읽고 pending migrations 전체를 atomic commit한다. worker/native reader는 실제 DB를 먼저 검증하고 mismatch 때 초기화·실행 전에 거부한다. 기존 generation/content hash 검증은 유지한다.
- 기존 failed/blocked task에 active attempt가 없으면 실행 중 작업으로 보지 않는다. active attempt 또는 queued/running/waiting/resuming 작업, 다른 불확실한 쓰기는 복구를 계속 차단한다.
- 이 변경은 아직 정식 릴리스에 포함되지 않았으므로 canary 사이의 호환과 구 release로의 downgrade 설치를 완료 조건으로 요구하지 않는다(기준은 "하위호환 기준" 2026-10-12). 데이터 보존·중간 실패 rollback·동시 시작 검증은 유지한다. Windows packaging은 CI에서 검증한다.

### Subagent 보고서 조회의 확정된 읽기 실패 (2026-10-11)

- `get_subagent_report`와 `get_subagent_reports`는 보고서 조회와 run-local 결과 캐시만 수행하므로 읽기 도구로 분류한다. 영구 returned/reviewed·adoption은 별도 middleware/도구의 쓰기 경계에 남긴다. 없는 task/attempt의 확정된 오류는 failed SDK tool outcome으로 전달하고 RPC를 정상 settle하며 도구 성공·완료 근거로 만들지 않는다.
- 명시적 background retrieval 복구는 이 두 보고서 조회의 UUID task/attempt와 인접한 승인 이름·모든 args를 재검증한다. 기존 schema 49와 policy 식별자를 유지한다. 다른 도구나 middleware의 uncertain을 포괄적으로 해제하지 않는다. 새 실패의 실제 적용은 사용자 요청으로 서버가 종료되어 대기 중이며 source의 readonly eligibility와 구분한다.

### 명시적 기본 도구 effect 분류 (2026-10-11)

- 기본 도구의 read/effectful 계약을 단일 분류표로 관리하고 source 등록 완전성 검증을 추가한다. 새 literal 등록 이름과 검토되지 않은 등록 문법은 검증에서 실패한다. Unknown/custom/MCP는 effectful 기본값을 유지하며 read/get 접두사로 추론하지 않는다.
- find_memory의 promoted-memory 조회 이력 INSERT와 Kagi의 외부 과금 호출은 순수 read에서 제외한다. wait_subagents 및 bound report evidence 조회는 ack/consumption·영구 쓰기가 없어 read로 분류한다. cancelled/interrupted 처리와 RPC side-effect reservation, 실패한 쓰기의 uncertain 보호는 유지한다.

### 가려진 값 주변 편집 (2026-10-12)

- 모델은 파일의 비밀을 `[redacted:<종류>]`로 읽는다. `edit_file`의 `oldText`에 자리표시자가 있으면, 서버가 현재 파일을 같은 탐지기로 다시 가린 보기에서 `oldText`를 찾고, 결과를 쓸 때 가려진 값을 원래 값으로 되돌린다. 바꾸는 범위 밖의 값은 그대로이고, `newText`의 자리표시자는 바꾸는 범위에 있던 같은 종류의 값을 순서대로 하나씩 가져간다. 가져갈 값이 없는 자리표시자는 쓴 그대로 남고, `newText`에서 빠진 값은 지워진다(그 줄을 지우는 편집).
- `oldText`가 자리표시자 중간에서 시작하거나 끝나면 `hidden_value_split`으로 거절한다. 일치 횟수와 `replaceAll`, sha256 확인 규칙은 원래와 같다.
- `write_file`로 기존 파일을 덮어쓸 때 내용에 자리표시자가 있으면, 파일 전체를 바꾸는 범위로 보고 같은 방식으로 값을 되돌린다. 전에는 가린 채 읽은 내용을 그대로 다시 쓰면 비밀이 자리표시자 글자로 바뀌어 사라졌다.
- 값은 모델, 기록, 기억을 거치지 않는다. 자리표시자에 값을 식별하는 지문(HMAC 등)은 붙이지 않는다. 지문을 쓰려면 설치별 키를 worker들과 나눠야 하고, 편집은 현재 파일만 다시 가리면 충분하다. 모델이 새 비밀을 써 넣는 것은 여전히 할 수 없다.

### 문제 제보의 사용자 모델 진단 (2026-10-12)

- 제보 진단은 사용자가 누를 때만 `POST /api/reports/diagnosis`로 사용자가 선택한 모델에 한 번 요청한다. 보내는 내용은 사용자가 작성한 설명과 포함·편집한 증거뿐이다. 응답은 `관측`(포함된 증거 ID를 인용)과 `가설`로 나누고, 인용이 없거나 없는 ID만 인용한 관측은 가설로 옮긴다. 사용자는 항목을 편집·삭제하고 포함 여부를 정한다. 모델 사용 불가(503)·호출 실패(502)·형식 오류(422)는 typed reason과 상태 코드로 구분하고, 브라우저는 거절 본문을 읽지 않는다. 제보문에는 실패 사실만 적어 최소 문안을 유지한다.

### 문제 제보의 Discord 웹훅 전송 (2026-10-12)

- 앞선 "앱은 게시하거나 웹훅을 저장하지 않는다" 결정을 대체한다. 사용자가 개발자에게 받은 Discord 웹훅 주소를 제보 페이지에서 설정하면, 검토한 최종 문안을 사용자가 누를 때만 `POST /api/reports/delivery`로 보낸다. 주소는 코드에 넣지 않고 OS 키체인(`report-discord-webhook`)에만 저장하며 브라우저에는 웹훅 ID 끝 4자리만 보인다. 개발자 개인 Discord 로그인·봇 토큰은 쓰지 않는다.
- `wait=true`로 메시지 ID를 받아야 성공으로 본다. 멘션은 모두 막고(`allowed_mentions.parse = []`), 전체 문안은 텍스트 첨부로 보낸다. 오류는 reason·상태 코드만 남기고 URL·응답 본문·tracing span을 남기지 않는다.
- 중복은 문안 해시로 서버 프로세스 메모리에서 원자적으로 막는다(`in_progress`·`duplicate`·`uncertain_duplicate`). DB 스키마 버전을 올리지 않기 위해 영속하지 않으며 재시작하면 잊는다. 확인되지 않은 전송은 사용자가 채널을 확인하고 다시 보내기를 눌러야만 재전송한다. 짧은 429(5초 이하)만 최대 2번 자동으로 기다리고, 401·403·404는 재시도하지 않는다. 실패해도 복사·텍스트 파일 저장은 남는다. Discord 제약의 근거는 [제보 문서](./reporting.md#discord-웹훅-제약-d1)에 둔다.

### 개발자 웹훅은 서버 설정에서만 읽음 (2026-10-12)

- 위 결정의 사용자 설정·키체인 저장을 대체한다. 목표의 "개발자 Discord 웹훅"은 개발자가 정하는 값이므로, 서버가 시작할 때 서버 설정 `DISCORD_WEBHOOK_URL`을 Effect `Config.Redacted`로 한 번 읽는 것이 유일한 출처다. 개발 실행에서는 React Router Vite 플러그인이 `apps/agent`의 env 파일을 `process.env`로 올리고, 기본 `ConfigProvider`가 그 값을 읽는다. 값을 바꾸려면 서버를 다시 시작한다.
- 키체인 경로는 두 출처의 우선순위·화면 상태를 늘리므로 남기지 않았다. 제보 페이지의 주소 입력·제거와 `configure`/`remove` 요청, `report-discord-webhook` 비밀 이름을 지웠다. 이전 개발 빌드가 키체인에 남긴 항목은 더 이상 읽지 않는다. 이 기능은 아직 GitHub 릴리스에 포함되지 않았으므로 하위호환 대상이 아니다.
- 비밀 취급: 값은 서버 안에서 `Redacted`로만 다니고 Discord 요청을 만들 때만 풀린다. 브라우저에는 설정 여부와 웹훅 ID 끝 4자리만 간다. 키가 없으면 `not_configured`(409), 값이 Discord 실행 웹훅 형식이 아니면 `invalid_webhook_url`(503, 서버 설정 문제)이며 오류·로그에 값은 담지 않는다.
- 패키징된 실행 파일은 env 파일을 읽지 않는다. 배포본에 개발자 웹훅을 넣는 방법(빌드 시 주입 등)은 별도 결정이 필요하며, 그전까지 배포본은 `not_configured`로 복사·저장만 제공한다. (아래 "배포본의 개발자 웹훅은 빌드 때 넣음"으로 결정됨)

### 배포본의 개발자 웹훅은 빌드 때 넣음 (2026-10-12)

- 사용자 결정: 패키징된 앱은 빌드 때 `DISCORD_WEBHOOK_URL`을 받는다. `vp run package`가 빌드 환경의 값을 `Config.Redacted`로 읽어 SEA asset(`release/server-config.json`)으로 넣고, 서버는 시작할 때 그 asset을 Schema로 읽어 agent runtime에 `ConfigProvider.layerAdd`(실행 환경 우선, 빌드 값은 대체)로 붙인다. 서버의 기존 `Config.Redacted` 조회와 typed reason(`not_configured`·`invalid_webhook_url`)은 바뀌지 않는다. 값은 클라이언트 번들에 넣지 않는다(Vite `define`·`VITE_` 변수를 쓰지 않는 이유).
- GitHub Actions secret `DISCORD_WEBHOOK_URL`은 사용자가 직접 등록하고, 릴리스 워크플로는 실행 파일 빌드 단계의 env로만 넘긴다. 값은 로그·문서·asset 디코딩 오류(`BuildConfigInvalid`, 내용 없음)에 남기지 않는다.
- 감수한 위험: 실행 파일을 가진 누구나 웹훅 URL을 꺼낼 수 있어 개발자 채널 스팸이나 웹훅 수정·삭제에 악용될 수 있다. 남용되면 웹훅을 지우고 새로 만든 뒤 secret을 바꿔 다시 릴리스한다(이전 배포본은 `webhook_rejected`). 자세한 내용은 [제보 문서](./reporting.md#배포본의-개발자-웹훅-2026-10-12).

### `run_shell`을 셸 스킬로 바꿈 (2026-10-14)

- 사용자 결정: `run_shell`을 없앤다. 호스트 명령은 프로젝트 셸 스킬로만 실행한다. 목적은 막연한 grep·rg·ls 같은 호출과 넘치는 출력을 없애고, 명령을 작업 목적에 맞춘 재사용 단위로 남기는 것이다. 위 "셸 도구의 실행 설명과 스킬 목록 전달"(2026-10-05)의 `run_shell` 설명 항목, R05 보류 항목, 저장소 폴더를 run_shell로 다루라는 안내는 이 결정으로 대체한다.
- 셸 스킬은 표준 skill 폴더다. `.agents/skills/<name>/SKILL.md`(name, description, 사용법)와 `scripts/run.sh`. 기존 skill 목록과 `read_skill`, 다른 에이전트가 그대로 읽는다. 별도 의미 매칭은 두지 않고 모델이 목록의 description을 보고 고른다.
- 도구 두 개:
  - `save_shell_skill(name, description, script, usage?)`: 만들거나 같은 이름의 셸 스킬을 바꾼다. 기존 `run_shell` 자리의 승인 대상이다(ask는 TanStack 승인, auto는 검토, full은 바로). 승인 카드는 스크립트 전문을 보여 준다. `scripts/run.sh`가 없는 일반 skill 이름은 덮어쓰지 않는다.
  - `run_skill(name, args?, workdir?, timeoutSeconds?, yieldMs?)`: 호출마다 묻지 않는다. 지금 스크립트의 sha256이 그 프로젝트에서 저장 때 승인된 값(`shell_skill_approvals`)일 때만 실행한다. 파일 도구 편집은 승인이 없으므로, 내용이 바뀌면 `not_approved`로 거절하고 다시 저장(다시 승인)하게 한다. full 모드는 확인 없이 실행하고 승인도 기록하지 않아서, 모드를 낮추면 다시 묻는다.
- 실행은 확인한 스크립트 텍스트를 `/bin/sh -c`에 그대로 넘기고 인자는 따옴표로 감싼 `$1…`로만 전달한다. 확인 뒤 파일이 바뀌어도 실행 내용은 바뀌지 않고, 인자는 셸이 해석하지 않는다. 결과 형태(상태, 종료 코드, 출력 앞뒤 보존, 백그라운드 전환, 실패 기록)는 `run_shell`과 같다.
- 내장 도구와 겹치는 스킬은 저장을 거절한다(`builtin_overlap`). 각 단계의 첫 프로그램이 모두 ls·find·cat·head·tail·sed·awk·grep·rg·touch·tee·rm 같은 내장 도구 대상이면 거절하고 대신 쓸 도구를 알려 준다. `pnpm test | tail -50`처럼 다른 프로그램 뒤 필터로 쓰는 것은 허용한다. cd·export·echo 같은 준비 단계는 세지 않는다.
- 감수한 위험: 승인한 스크립트는 이후 인자만 바꿔 묻지 않고 실행된다. 승인 카드와 auto 검토 지침에 이를 적고, 검토는 인자가 위험한 명령으로 이어질 수 있으면 ask한다. 자동 허용 빠른 경로는 모든 줄이 일상 패키지·git 명령이고 `$` 확장이 없을 때만 쓴다.
- Verify 단계는 두 셸 스킬 도구를 받는다. 셸 스킬 저장은 검증 도구 준비로 보고 Verify의 파일 수정 금지에서 뺀다.
- 기존 대화의 `run_shell` 호출은 이름 표시와 결과 미리보기만 유지한다.
- 셸 스킬 작성 지침(2026-10-14, 사용자 결정): 내장 skill `shell-skill-writing`을 두고, `save_shell_skill` 설명이 대화에서 처음 저장하기 전에 읽으라고 안내한다. Anthropic skill-creator(Apache 2.0)에서 셸 스킬에 맞는 원칙만 추렸다. description에 무엇과 언제를 함께 적기, 반복 작업을 스크립트로 묶기, 이유를 설명하는 명령형, 놀랄 동작 없기, 출력은 작업에 필요한 만큼. skill-creator 원문은 넣지 않았다. 인터뷰·평가·서브에이전트 비교·Python 스크립트·`claude -p` 설명 최적화로 이어지는 범용 skill 제작 과정이라 작업 중 만드는 작은 셸 스킬과 맞지 않고, 원문(약 33KB)을 저장할 때마다 읽으면 낭비를 줄인다는 목적과 반대가 된다. 출처와 변경 사항은 SKILL.md 주석에, 라이선스 사본은 같은 폴더의 `LICENSE.txt`에 둔다.

### 셸 스킬 샌드박스 (#22, 2026-10-14)

- 설계 문서: [shell-skill-sandbox.md](./shell-skill-sandbox.md).
- 셸 스킬 스크립트는 OS 샌드박스 안에서 실행한다. 이 절은 위 절의 "실행은 호스트에서"와 아래 UI 절의 "셸 격리는 #22로 미룬다"를 대체한다.
- 참고한 사례:
  - Claude Code: `@anthropic-ai/sandbox-runtime`(srt, Apache 2.0)으로 파일·네트워크를 막고, 새 도메인은 실행 중에 묻는다.
  - Codex CLI: workspace-write 샌드박스에서 네트워크를 기본으로 끄고, 벗어날 때는 이유를 붙여 승인받는다.
  - Codex 클라우드: 도메인 허용 목록 프리셋을 둔다.
  - Gemini CLI: Seatbelt 프로필을 고른다.
- 사용자 지적: "네트워크 필요" 같은 표시만으로는 무심코 승인하기 쉽다. 그래서 네트워크는 표시가 아니라 스킬마다 정확한 호스트 목록으로 받는다.
  - `save_shell_skill`에 `network`(호스트, `*.` 와일드카드, `:port`)를 추가했다. 저장할 때 `scripts/run.sh` 첫 줄 `# run_skill network: …`에 쓴다.
  - 호스트 목록은 승인 대상 텍스트의 일부다. 따라서 스크립트와 같은 sha256으로 함께 승인되고, 파일을 고쳐 호스트를 늘리면 `not_approved`가 된다. 이 줄을 스크립트 본문에 직접 쓰면 거절한다(`network_line`).
  - 승인 카드는 호스트를 하나씩 보여 준다. 와일드카드와 `localhost`에는 의미를 덧붙인다.
  - auto 검토는 호스트가 있으면 자동 허용 빠른 경로를 쓰지 않는다. 검토 지침에는 작업과 무관한 호스트, 업로드형 서비스, 넓은 와일드카드, localhost면 ask하라고 적었다.
- 실행 중에 묻지 않는다. 목록 밖 호스트는 막고, 무엇을 막았는지 stderr의 `<sandbox_violations>`로 모델에게 보여 준다.
  - 모델은 필요할 때만 호스트를 더해 다시 저장(재승인)한다. Codex의 승인 요청 방식을 스킬 승인에 합친 것이다.
  - Claude Code처럼 실행 중에 묻지 않은 이유가 둘 있다.
    - srt의 묻기 콜백은 프로세스에 하나뿐이고 어떤 실행의 요청인지 알려 주지 않는다. 여러 세션이 동시에 도는 이 앱에서는 요청한 실행을 특정할 수 없다.
    - 묻는 동안 패키지 설치 같은 연결이 시간 초과로 끊긴다.
- 구현:
  - srt 0.0.79를 고정해 쓴다. 연구 미리보기라 설정 형식이 바뀔 수 있다.
  - srt는 정책·필터 프록시·위반 기록을 모듈마다 하나씩 가진다. 그래서 실행마다 worker thread(`sandbox-worker`)를 하나씩 띄워 허용 목록을 분리한다.
  - srt는 소켓 이름을 pid로 짓는다. 그래서 worker마다 TMPDIR을 따로 준다.
  - 명령은 기존 `runCommand`가 실행한다. 프로세스 트리 종료, 출력 보존, 백그라운드 전환은 그대로다. worker는 명령이 끝날 때까지 프록시를 유지하고, 끝나면 위반을 붙인 stderr를 돌려준 뒤 종료된다.
  - srt는 옆 폴더의 보조 바이너리를 찾아야 해서 번들하지 않는다. 런타임 패키지(`requireRuntime`)로 싣는다.
- 정책:
  - 쓰기: 프로젝트, `/tmp`, 시스템 임시 폴더, 패키지·툴체인 캐시(`~/.npm`, `~/.cache`, `~/Library/Caches`, pnpm, cargo, go, gradle, m2, `~/.vite-plus` 등)만 허용한다. 프로젝트의 `.agents/skills`는 막는다. 스킬은 `save_shell_skill`로만 바뀐다. 셸 설정과 `.git/hooks`·`.git/config`는 srt가 기본으로 막는다.
  - 읽기: 전체를 허용하되, 알려진 자격증명 저장소(`~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.git-credentials`, gh·gcloud, 에이전트 로그인, 키체인, 브라우저 프로필 등)와 앱 저장소 폴더는 막는다. 앱 저장소 파일을 셸 스킬로 고치라는 안내는 없앴다.
  - 네트워크: 스킬의 호스트만 허용한다. 루프백 포트는 `localhost`를 적었을 때만 바인딩·접속을 허용한다. 이 앱 서버를 포함한 모든 로컬 서비스에 닿기 때문이다. ssh로 하는 git은 지나가지 못하므로 https remote를 쓴다.
- 권한 모드는 샌드박스를 풀지 않는다. 경로·자격증명 규칙을 모드가 풀지 않는다는 기존 원칙과 같다.
- 샌드박스를 쓸 수 없는 환경에서는 ask·auto 모드가 실행을 거절한다(`sandbox_unavailable`). 해당 환경은 macOS·Linux 외 OS와, bubblewrap·socat이 없는 Linux다. full 모드는 승인 없는 스크립트도 이미 실행하므로 샌드박스 없이 실행한다.
- 감수한 한계:
  - 읽기는 거부 목록 방식이라, 목록에 없는 비밀 파일은 읽힌다. 홈 전체를 막고 허용 목록으로 여는 방식은 툴체인 위치마다 깨져서 쓰지 않는다.
  - 프로젝트의 `.env`는 테스트·실행에 필요해 읽기를 막지 않는다.
  - 허용한 호스트로의 업로드는 막지 못한다(srt 문서의 도메인 단위 한계).
  - 캐시 쓰기는 캐시 오염 경로가 될 수 있다.

### Codex 압축 rollout 이관 (2026-10-16)

- Codex 0.162는 `legacy_to_paginated_v1` 마이그레이션에서 더 쓰지 않는 rollout을 zstd로 압축한다(`rollout-*.jsonl.zst`). 이 기기에서 `~/.codex/sessions`의 151개 중 117개가 압축됐고, `.jsonl`만 찾던 이관은 이 기록을 건너뛰었다. 줄 형식(`session_meta`, `response_item`, 최상위 `ordinal`)은 그대로다.
- `.jsonl.zst`도 Codex 기록으로 찾고, 대화 id는 압축 전과 같이 파일 이름의 uuid다. 그래서 `imported_sessions`가 같은 세션을 다시 잡고, `imported_nodes`(출처 + `<id>:<ordinal>`)가 이미 옮긴 줄을 막는다.
- 압축 파일은 이어 쓰이지 않으므로 통째로 풀어서 읽는다(Node `zlib.zstdDecompress`, Effect에는 zstd codec이 없음). 커서의 byte offset은 압축을 푼 바이트 기준이다. `size`·`mtime` 비교는 압축 파일 그대로 한다. 해제 실패는 `TranscriptDecompressFailed`로 그 기록의 실패로만 남는다.
- `~/.codex/archived_sessions`도 읽는다(출처 경로는 `~/.codex`). Codex는 대화를 보관하면 rollout을 그 폴더로 옮기고 압축한다. 대화 id가 그대로라 이미 옮긴 세션에 이어지고, 처음 옮긴 대화는 보관 상태 그대로 가져온다.
  - 보관된 파일이 처음 세션에 들어갈 때 한 번만 세션을 보관한다(그 경로의 커서가 없거나 건너뛴 기록이었을 때). 그 뒤 이 앱에서 보관을 풀면 다음 회차가 다시 보관하지 않는다. Codex에서 보관을 풀어도 이 앱의 세션을 되돌리지 않는다. 사용자가 이 앱에서 보관한 세션과 구분할 기록이 없기 때문이다.
- 10/14 마이그레이션은 일부 최근 대화를 새 uuid의 rollout으로 다시 썼다. 이 기기에서 이관 커서 168개를 확인하니 사라진 파일이 없었다(그대로 34, `.zst` 117, 보관 17). 새 uuid 대화가 옛 id로 옮겨진 적이 없어서 합칠 중복도 없었다. 그래서 내용 비교로 세션을 합치는 규칙은 두지 않는다.

### worktree 대화를 저장소 프로젝트에 넣기 (2026-10-17)

- 에이전트는 git worktree(Orca, Conductor, `claude --worktree`, Codex)에서 일한다. 기록의 `cwd`를 그대로 등록하면 worktree마다 프로젝트가 생기고, merge 뒤 worktree가 지워지면 그 대화는 갈 곳을 잃었다. 이 기기에서 worktree 프로젝트가 13개였다.
- 어디에 넣을지는 git이나 기록의 git 정보로 증명될 때만 바꾼다. 이름이 닮은 것만으로는 합치지 않는다. 잘못 합친 대화보다 따로 남은 대화가 고치기 쉽기 때문이다. 순서(`imports/checkouts.ts`):
  1. 폴더가 있고 linked worktree면(`--git-dir` ≠ `--git-common-dir`) 원래 checkout의 같은 위치로 옮긴다.
  2. 그 밖에 있는 폴더는 그대로 둔다(지금까지와 같다).
  3. 지워진 폴더는 기록의 git 정보로 찾는다. Codex `session_meta.git`의 `repository_url`이 등록된 저장소의 `origin`과 하나만 맞으면 그 저장소다. remote가 없거나 둘 이상이면 `commit_hash`를 가진 저장소가 하나뿐일 때 그 저장소다. Claude Code는 브랜치만 남기는데 merge 뒤 브랜치가 지워져서 쓰지 않는다.
  4. 지워진 폴더가 등록된 저장소의 worktree 상위 폴더(`git worktree list`의 각 worktree 부모, 예: `~/orca/workspaces/<repo>`) 아래면 그 저장소다. 저장소 checkout 자체가 들어 있는 상위 폴더는 쓰지 않는다. checkout 옆에 worktree를 만드는 구성에서 `~/code` 전체가 한 저장소로 묶이기 때문이다. 후보가 둘 이상이어도 쓰지 않는다.
  5. 어느 것도 아니면 `cwd` 그대로다.
- 한계: 4번은 지금 살아 있는 worktree가 하나라도 있어야 그 상위 폴더를 안다. 이 기기의 opi-workspace는 worktree가 모두 지워져 있어 그 쪽 기록은 따로 남는다.
- 회차를 시작할 때 이관이 worktree에 만든 프로젝트를 저장소 프로젝트로 접는다. 세션과 그 노드의 `project_id`를 옮기고, 빈 프로젝트는 숨긴다(지우지 않음). 검색 범위는 `nodes.project_id`로 정해져서 벡터는 그대로 둔다. 이 앱에서 시작한 대화나 세션 밖 노드가 있는 프로젝트는 사용자 것이라 접지 않는다.
- 폴더 때문에 건너뛴 기록(`no_project`, 등록 거절)은 파일이 바뀌지 않아도, 저장해 둔 `cwd`를 지금 넣을 수 있게 되면 다시 읽는다. 전에는 크기·시각이 같으면 영영 건너뛰어서, 9/16 이전 코드가 남긴 `no_project` 기록 13개(이 저장소의 88MB 대화 포함)가 남아 있었다.

### 세션별 worktree 기록 (2026-10-17)

- 프로젝트는 저장소 하나에 하나로 두고, worktree 구분은 세션에 둔다. worktree마다 프로젝트를 만들면 같은 저장소의 기억이 갈라지고 사이드바에 폴더가 중첩된다.
  - `sessions.worktree_path`: 대화가 돈 worktree 폴더. 원래 checkout에서 나눈 대화는 비운다. 남아 있는 worktree는 git의 `--show-toplevel`, 지워진 worktree는 상위 폴더 아래 첫 폴더, Codex git 기록으로 찾은 것은 기록된 `cwd`다. 접은 worktree 프로젝트의 세션은 그 프로젝트 폴더다.
  - `sessions.branch`: Claude Code `gitBranch`, Codex `session_meta.git.branch`. 분리된 HEAD(`HEAD`)는 브랜치가 아니다.
  - 이미 있는 세션은 채워진 값을 덮지 않는다(`coalesce`).
- 저장소가 worktree를 만드는 상위 폴더를 `worktree_parents`에 남긴다. 회차마다 git이 보여 준 상위 폴더를 더하고 지우지 않는다. 그래서 그 저장소의 worktree가 모두 지워진 뒤에도 지워진 worktree의 대화가 저장소를 찾는다. 이 기록이 생기기 전에 worktree가 모두 지워진 저장소(이 기기의 opi-workspace)는 여전히 찾지 못한다.
- 사이드바는 세션에 브랜치(없으면 worktree 폴더 이름) 배지를 달고, 작업 위치가 하나라도 있으면 "모든 작업 위치 / 저장소 본체 / 브랜치별" 필터를 보인다. worktree를 만들고 지우는 관리 화면은 두지 않는다. Orca 같은 도구의 일이고 이 앱의 역할은 기억과 대화다.
- 이 앱에서 직접 연 대화(실행 폴더·브라우저에서 추가한 폴더가 worktree인 경우)를 저장소 프로젝트에 넣는 일은 아직 하지 않았다. 실행 중인 세션의 파일·셸 도구가 worktree와 원래 checkout 중 어디서 일할지 먼저 정해야 한다.

### worktree 프로젝트를 접을 때 노드 옮기기 (2026-10-20)

- 증상: 노드가 있는 worktree 프로젝트를 접으면 `UPDATE nodes SET project_id`가 `nodes_immutable` trigger에 막혀 가져오기 회차 전체가 매번 실패했다(`ImportStoreFailed` ← `nodes are immutable evidence`). 10/17의 접기 테스트가 노드 없는 프로젝트만 다뤄서 놓쳤다.
- 결정: secret sweep처럼 이동 전용 permit을 둔다. `node_project_moves(from_project, to_project)`에 행을 쓰고, `project_id`를 바꾸고, 행을 지우는 일을 한 트랜잭션에서 한다. trigger는 그 프로젝트 쌍의 permit이 있고 `project_id` 말고는 아무것도 바뀌지 않을 때만 허용한다. sweep permit은 여전히 텍스트만 바꾼다. 둘 다 아니면 전처럼 거부한다.
- 버린 안: 노드는 두고 접힌 프로젝트를 소유 프로젝트의 alias로 조회 때 해석하는 방식. 검색·회상·임베딩 후보(`nodes_embeddable`)·지식 등 `nodes.project_id`로 범위를 정하는 모든 조회가 alias를 알아야 해서, 하나라도 빠지면 접은 대화가 검색에서 사라진다. permit은 한 곳만 바꾸고 10/17 결정("검색 범위는 `nodes.project_id`로 정해져서 벡터는 그대로 둔다")과 그대로 맞는다.
- `ImportStoreFailed`에 실패 단계 reason(`WorktreeParents`·`Fold`·`Mapping`·`Cursor`·`Title`·`FailureRecord`)을 단다. worker 로그는 `failure`에 `ImportStoreFailed:Fold`처럼 태그와 reason만 따로 남긴다. SQL과 경로는 reason에 넣지 않는다.

## UI·클라이언트

### UI (2026-09-14)

- 대화 기록은 커서 페이지네이션(50개씩, 2026-10-07부터 20개씩)을 유지하고, 위쪽 Intersection Observer로 이전 페이지를 읽는다(2026-09-25). 스트리밍 Markdown과 도구 카드의 높이가 계속 변하므로 메시지 가상화는 제거하고 일반 문서 흐름으로 배치한다. 이전 페이지를 붙일 때 읽던 위치를 보존하고, 맨 아래를 보고 있을 때만 새 출력에 따라 스크롤한다.
- 답변은 streamdown으로 스트리밍 마크다운 렌더링한다. 플러그인은 코드 하이라이트(`@streamdown/code`)와 한글 강조(`@streamdown/cjk`)만 쓴다. shadcn의 AI Elements `message`는 Vercel AI SDK 타입과 mermaid, 수식 의존이 따라와서 쓰지 않는다.
- ~~답변 속 이미지는 streamdown 기본대로 표시한다.~~ (2026-10-14 대체) 다른 출처의 http(s) 이미지는 `{호스트}의 이미지 불러오기` 버튼으로 보이고 눌렀을 때만 불러온다. 렌더링 순간 요청이 나가면 모델이 URL에 넣은 내용(도구 결과 포함)이 사용자 동작 없이 외부로 나가기 때문이다. 같은 출처와 data/blob 이미지는 그대로 표시한다. 링크는 이동 전에 확인한다.
  - 같은 검토에서 셸 격리는 #22(샌드박스, 2026-10-14 "셸 스킬 샌드박스"에서 구현)로 미루고, 승인 없는 프로젝트 안 파일 쓰기는 유지한다. 쓰기는 프로젝트 경로 안으로 한정되고 sha256 확인으로 덮어쓰기 충돌을 막는다.
- 입력 영역은 카드 하나(shadcn `input-group`)로 묶는다(2026-09-14 변경). 위에서부터 대기 메시지 목록, 첨부 이미지, 입력창, 툴바(첨부, 상태, 단축키, 중지, 전송) 순서다. 대기 메시지는 상태 아이콘과 짧은 라벨로 표시하고, 편집, 지우기 버튼은 행에 마우스를 올리거나 포커스할 때만 보인다. 단축키 안내(`kbd`)는 Enter의 뜻이 바뀌는 답변 중, 편집 중에만 넓은 화면에서 보여준다. 읽기 전용 탭에서는 입력 카드 대신 안내 카드(`item`)를 둔다.

### 디자인 시스템 린트 (2026-09-16)

- `@shadcn/lint`를 Oxlint JS 플러그인(`shadcn`)으로 루트 `vite.config.ts`의 `lint.jsPlugins`에 등록한다. 패키지는 린트 설정을 가진 루트의 `devDependencies`에 둔다.
  - `vp lint`와 `vp check`는 어느 폴더에서 실행해도 루트 `vite.config.ts`를 `-c`로 넘긴다. Oxlint는 `-c`를 받으면 하위 설정을 찾지 않는다. 그래서 `apps/agent/vite.config.ts`의 `lint` 블록은 적용되지 않는다. 하위 설정으로 읽혔다면 그 안의 `options.typeAware`가 에러를 냈을 것이다. 앱에만 걸 규칙은 루트 `lint.overrides`에서 `apps/agent/**`로 범위를 정해야 한다.
  - 컴포넌트와 테마는 `apps/agent/components.json`(`~/components/ui`, `app/app.css`)과 앱 `tsconfig.json`의 `paths`에서 찾는다. 루트에서 실행해도 찾으므로 `settings.shadcn`은 두지 않는다.
  - 루트에 `typescript`(catalog, 7.0.2)를 둔다. `@shadcn/lint`가 쓰는 `@typescript-eslint/parser`는 peer로 `typescript <6.1.0`을 요구한다. 루트에 TypeScript가 없으면 pnpm이 TypeScript 6을 설치하고, 루트 `vite-plus`도 그 버전으로 묶인다. 이 파서는 `oxc-parser`가 없을 때만 쓰이므로, TypeScript 7과 peer 범위가 맞지 않아도 동작에는 영향이 없다.
  - README가 Oxlint 1.80 이상을 요구해서 Vite+를 0.3.2(Oxlint 1.82.0)로 올린다. 0.3.0의 Oxlint 1.79.0에서도 로드와 진단은 됐다. 0.3.2는 `pack.dts`의 `tsgo: true`를 `generator: "tsgo"`로 바꿨다(utils `vite.config.ts`).
- 여섯 규칙(`no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-inline-styles`, `no-unknown-classes`, `require-static-classes`)을 모두 `error`로 켠다. `no-restyle`과 `no-arbitrary-values`는 레이아웃 클래스(`mt-4`, `w-full` 등)를 허용한다(`allow: ["layout"]`).
  - 컴포넌트 폴더 `apps/agent/app/components/ui/**`에서는 `no-restyle`, `no-arbitrary-values`, `require-static-classes`를 끈다. 컴포넌트는 자기 모양을 스스로 정하고 `ring-[3px]` 같은 구조용 값이 필요하다. `no-raw-colors`와 `no-inline-styles`는 그 폴더에서도 켠다.
  - 켠 시점에 `apps/agent/app/entry`에 기존 위반이 84개 있었다(`no-restyle` 75, `no-arbitrary-values` 6, `no-raw-colors` 3).
- 기존 위반은 규칙을 풀지 않고 디자인 시스템 쪽을 넓혀서 없앴다. 화면이 거의 그대로 남는 방법을 골랐다.
  - 토큰: 경고색 `--warning`(`text-warning`, 라이트는 amber-600, 다크는 amber-400 값)과 `text-xs`보다 작은 글자 `--text-2xs`(11px, 섹션 라벨, 단축키 안내), `--text-3xs`(10px, 이미지 번호)를 `app.css`에 둔다. 두 글자 크기는 줄 높이를 정하지 않아, 이전 임의값처럼 부모의 줄 높이를 따른다.
  - 변형: Card `variant="warning"`(승인 요청), Item `variant="card"`(읽기 전용 막대), ItemDescription `variant="destructive"`와 `lines={3}`, Button `variant="ghost-muted"`를 더한다. CardFooter는 기본으로 `gap-2`를 준다.
  - 입력창은 `components/ui/prompt-input.tsx`(`PromptInput`, `PromptInputHeader`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputButton`)로 옮긴다. InputGroup을 조합해 입력창만의 모양을 디자인 시스템 안에서 정한다.
  - 경로와 주소처럼 코드인 글자는 `font-mono` 대신 `<code>`로 감싼다. 문제 목록은 `FieldError`로 보인다.
  - 컴포넌트 안쪽 배치(아이콘 간격, 설명 두 줄 사이)는 margin으로, 컴포넌트 바깥 틀(슬래시 명령 목록의 테두리와 그림자, 대화 목록 보관 버튼을 hover 때만 보이기)은 감싸는 일반 요소로 준다. 설정 탭 본문의 윗여백은 `pt-3` 대신 `mt-3`이다.
  - `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`는 스타일이 없는 Base UI 래퍼다. 루트 설정의 `no-restyle` contract로 모든 분류를 허용한다.
  - (2026-10-17) `@shadcn/lint` 0.2부터 Base UI `render` prop도 검사한다. contract에는 shadcn CLI가 스타일 없이 내보내는 래퍼만 넣는다. 넣기 전에 `shadcn add <name> --diff`로 `components/ui` 파일이 CLI 원본과 같은지 확인한다. 지금은 `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`, `TooltipTrigger`, `DropdownMenuTrigger`, `HoverCardTrigger`가 해당한다.
  - (2026-10-17) `CollapsibleTrigger`에 넣어 둔 커서와 포커스 링 클래스는 CLI 원본에 없었다. 그래서 래퍼를 CLI 원본으로 되돌리고, 같은 클래스를 각 호출부에 둔다. `render`로 `Button`을 쓰는 곳은 Button이 이 스타일을 이미 갖고 있다. 2026-10-01 접힘 UI 결정의 포커스 스타일은 그대로 유지된다.
  - 컴포넌트가 이미 정한 값으로 바뀐 곳이 있다. ItemGroup 간격 8→10px, ItemTitle 안 배지 간격 6→8px, 이미지 hover 미리보기 안쪽 여백 6→10px, 승인 카드 테두리색 amber-500→`warning`.
  - 입력창의 `rounded-xl`과 `text-sm`은 이 정리 전부터 적용되지 않는다. InputGroup의 `has-[textarea]:rounded-md`와 Textarea의 `md:text-xs/relaxed`가 이긴다. 이번 정리는 이 동작을 바꾸지 않았다.

### 화면 테마와 세션 제목 (2026-09-17)

- 테마는 시스템 설정을 기본으로 하며 라이트·다크를 선택해 브라우저에 저장한다. 첫 화면에도 적용하고 시스템 테마 변경을 따라간다.
- 로컬 세션은 처음 저장된 사용자 메시지(비밀 제거 후)를 공백 정리해 최대 60자로 제목에 쓴다. 긴 제목은 말줄임표를 붙이며 빈 텍스트는 `이미지 대화`로 표시한다. 기존 제목과 가져온 세션은 덮어쓰지 않는다.
- 제목 자동 저장 도입 전 로컬 대화도 조회 시 저장된 첫 사용자 메시지로 제목을 표시한다. 명시된 제목·가져온 대화는 그대로 유지한다. (2026-09-17 보완)
- 선택한 세션에 제목이 없으면 목록을 1초 간격으로 갱신하여 첫 메시지 제목을 표시한다.

이 저장소의 제품과 설계 결정을 날짜와 함께 기록합니다. 결정이 바뀌면 해당 내용을 현재 결정으로 교체하고 날짜를 갱신합니다. 이전 결정은 git 기록에서 확인할 수 있습니다.
요구사항의 원본은 이전 프로젝트(`topic-generactive-ai-agent`)의 PRD R01-R19이며, 여기서는 그중 이 저장소에서 바꾸거나 구체화한 부분만 적습니다.

### 화면 문구와 줄바꿈 (2026-09-17)

- 화면 문구는 해요체 문장으로 쓴다. 가운뎃점(·)으로 나열하지 않고 "와/과"나 쉼표로 잇는다. 배지처럼 짧은 이름 외에는 명사 조각 대신 문장으로 쓴다.
- 이름이나 값 뒤에 조사가 붙어야 하면 "을(를)"로 함께 적지 않고, 조사가 필요 없는 문장으로 바꾼다(예: "MCP 도구 X 실행을 승인할까요?", "쓸 수 있는 모델 목록에 없어요: X").
- 본문은 `word-break: keep-all`과 `overflow-wrap: anywhere`로 줄바꿈한다. 한국어는 낱말 단위로 끊고, 공백 없는 경로나 URL은 칸을 넘지 않게 아무 데서나 끊는다. 명령과 경로만 담은 `code`는 `break-all`을 그대로 쓴다.
- `color-scheme`은 OS 설정이 아니라 `.dark` 클래스를 따른다.

### 설정 창 구성 (2026-09-17)

- 설정 창은 크기를 고정하고(너비 약 768px, 높이 최대 640px), 페이지를 바꿀 때 내용만 스크롤한다. 왼쪽 메뉴는 연결(웹 검색, MCP 서버, 외부 에이전트), 기억(대화 가져오기, 임베딩), 지침(Skills)으로 묶는다.
- 모든 페이지는 같은 머리를 쓴다: 제목, 상태 배지, 1-2줄 설명, 주요 버튼. MCP 서버, 외부 에이전트, Skills처럼 선택한 프로젝트의 파일을 읽는 페이지는 프로젝트 이름을 배지로 보인다.
- 설정 파일 경로는 한 줄로 줄여 보인다(홈은 `~`, 프로젝트 안은 프로젝트 이름부터). 전체 경로는 복사 버튼으로 준다.
- 신뢰 버튼 문구는 신뢰하기, 다시 신뢰하기(설정이 바뀜), 사용 중지로 통일한다.

### 로컬 API와 이벤트 연결 (2026-09-24)

- 전역·프로젝트·세션 쿼리 변경 알림은 `/api/events` SSE 하나로 전달한다. 클라이언트는 이벤트 범위와 주제에 맞는 TanStack Query 키를 즉시 무효화한다. 첫 연결에서는 조회와 구독 사이의 변경을 보정하고, 재연결에서는 서버 revision이 달라졌을 때만 앱 쿼리를 다시 조회한다. (2026-09-24 보완)
- Work Trace SSE는 저장된 cursor를 기준으로 변경을 알려준다. trace 쿼리는 타이머로 무효화를 늦추지 않고, 조회 중에 들어온 변경을 완료 후 한 번 더 조회해 최신 상태를 받는다. (2026-09-24 보완)
- 계정 추가 로그인이 다른 탭에서 끝나면 서버가 `auth` 이벤트를 보내고, 페이지는 로그인 상태와 계정 목록을 다시 조회한다. 기다리는 동안 1초 폴링하지 않는다. 남은 주기 조회는 로그인 만료를 확인하는 60초 조회와 설정 화면을 열어 둔 동안의 RRSI 실험 상태 5초 조회뿐이다. (2026-10-14)
- 보이지 않는 탭은 앱 이벤트와 Work Trace SSE를 닫고, 다시 보일 때 연결하며 저장된 상태를 재조회한다. 여러 탭에서 오래 열린 SSE가 일반 API 요청의 연결 슬롯을 차지하지 않도록 한다.
- 실행 중지와 OAuth 상태 조회·모델 목록 호출에는 제한 시간을 둔다. 백엔드 작업이 늦어도 요청을 무기한 기다리지 않게 한다.
- 세션 상태에서 필요한 마지막 실행 기록은 실행 이력 전체 대신 최신 1건만 조회한다.

### 클라이언트 데이터 표현 (2026-09-24)

- 화면은 서버 응답 배열을 별도 `Map`/`Set` 인덱스로 복제하지 않고, 필요한 항목을 배열에서 직접 찾는다. Work Trace의 task와 대기 승인, 첨부 이미지가 이에 해당한다. 일시적인 메시지 배치 위치는 ID별 객체로 보관한다.
- 고정된 표시 문구와 오류 분기는 객체 또는 `switch`로 표현한다. 브라우저 내부 구독자 등록은 서버 응답과 관계가 없으므로 알림 구독 집합을 유지한다.

### 화면 데이터와 이미지 생성 흐름 (2026-09-24)

- 서버 조회는 `entry/queries`의 계층형 키와 `queryOptions`로 정의하고 도메인 훅에서 읽는다. 프로젝트와 세션에 딸린 조회는 부모 키 아래에 둬 설정 변경, 작업 추적 갱신, 세션 변경 시 필요한 범위를 무효화할 수 있게 한다. 변경 요청이 성공하면 관련 키를 무효화해 서버 스냅샷을 다시 읽는다. 낙관적 변경을 하지 않는 한 `setQueryData`로 조회 결과를 직접 덮어쓰지 않는다.
- 프로젝트 선택, 세션 소유권처럼 조회가 조건부인 화면은 `useQuery`를 쓴다. 항상 조회할 수 있는 설정 페이지는 `useSuspenseQuery`를 쓰고 페이지마다 로딩과 오류 재시도 경계를 둔다.
- 이미지 생성 요청은 mutation이 진행 상태와 결과를 소유한다. 공급자 간 실행 승인이 필요하면 한 창에서 이번 요청 승인, 항상 승인, 취소를 선택한다. 승인 취소나 요청 실패 때 작성 중인 프롬프트를 보존한다.
- 화면 파일은 `chat`, `session`, `settings`, `navigation`, `media`, `queries`, `events`, `shared`로 묶는다. URL 진입점과 HTTP 클라이언트는 `entry` 루트에 둔다.
- 설정 창은 `overlay-kit`으로 연다. 창의 `open` 상태는 overlay가 소유하고, 사이드바 버튼과 대화 명령은 같은 열기 함수를 사용한다. 설정 변경으로 낡아진 조회는 각 mutation의 `onSuccess`에서 무효화한다.
- 메인 화면의 로그인·모델·프로젝트·세션 조건은 `ts-pattern`의 완전 매칭으로 렌더링한다. JSX를 임시 변수에 대입하는 분기를 두지 않는다.

### 접힘 UI 구성 (2026-10-01)

- 한 섹션을 여닫는 UI는 Base UI 기반 `components/ui/collapsible.tsx`의 `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`로 구성한다. 계정 설정, 진단 정보, 증거 원문처럼 직접 만든 `<details>/<summary>`도 같은 접근성 동작과 키보드 포커스 스타일을 사용한다.
- 사이드바 그룹은 [shadcn Base UI Sidebar](https://ui.shadcn.com/docs/components/base/sidebar)의 `SidebarGroup` + `Collapsible` 조합을 기준으로 삼는다. 여러 항목이 하나의 집합으로 열리고 닫혀야 할 때만 Accordion을 사용한다.
- 채팅 사이드바의 계정/모델과 프로젝트 접힘 버튼은 동일한 높이·여백과 오른쪽 ChevronDown 아이콘을 사용한다. 열리면 아이콘을 180도 회전한다.
- 펼친 내용에서는 계정과 모델을 각각 이름 붙인 구역으로 보여주고, 프로젝트 선택과 현재 프로젝트의 설정을 분리한다. 추론 강도와 권한 모드는 선택 목적이 보이도록 라벨을 붙이며, 중복 설명은 반복하지 않는다.

### 브라우저 provider schema와 빌드 출력 경계 (2026-10-04)

- 브라우저에서 사용하는 provider schema는 `memory-agent/provider-contracts` 전용 진입점에서 가져온다. 서버 서비스·worker·Node 모듈을 re-export하는 패키지 루트를 값 import로 사용하지 않는다.
- 앱의 TypeScript 검사는 원본 코드와 React Router 생성 타입을 대상으로 한다. 패키징 산출물인 `build`·`dist`의 복사된 runtime TypeScript는 제외한다. `pnpm build` 이후에도 동일한 원본 타입 검사가 가능해야 한다.

#### 빌드 경고 재검증

- `pnpm build`는 수정 전후 모두 성공했다. 브라우저의 Node 모듈 externalization 경고는 564개에서 0개로 줄었고, 서버 worker URL에 대한 asset 경고도 없어졌다. 메인 route 청크는 3,011.83 kB에서 1,037.79 kB로 줄었다 (gzip 883.20 → 324.42 kB). 이 수치는 이번 checkout의 빌드 스냅샷이다.
- 500 kB 초과 청크 경고는 남아 있다. 메인 route와 일부 syntax grammar·WASM 청크가 대상이며, 경고 제한을 올리거나 숨기지 않는다. 초기 로드·문법 로딩 정책의 별도 최적화 대상이다.
- Node 실행 파일 번들에서는 React Router의 `use client` 지시문 보존 경고가 남고, Vite+ pack의 `exe` 실험적 옵션 안내도 출력된다. 이번 변경에서 RSC 동작이나 패키징 방식을 변경하지 않는다.

### Node SSR에서 브라우저 storage 조회 방지 (2026-10-04)

- `react-simplikit@0.3.1`의 root import는 storage 모듈을 초기화하며 `localStorage`·`sessionStorage`를 조회한다. Node 26 개발 서버의 첫 SSR 요청에서 `--localstorage-file` 없는 localStorage getter가 경고를 내는 것을 trace로 확인했다. 앱의 테마 hook effect가 원인은 아니다.
- pnpm dependency patch로 ESM·CommonJS의 storage probe에 browser `window` 존재 검사를 추가한다. SSR에서는 기존 메모리 fallback을 사용하고, 브라우저에서는 기존 storage probe를 유지한다. Node storage 파일을 추가하거나 경고를 전역 억제하지 않는다.
- Node의 storage getter를 접근 시 실패하도록 정의한 회귀 테스트에서 두 module 형식의 root import가 storage를 읽지 않는지 확인한다. 별도 개발 서버의 실제 SSR 200 응답에서도 trace 경고가 사라지는지 확인한다.

### 응답량과 독립적인 tool 상세 렌더 지연 (2026-10-07)

- 접힌 tool card에서는 detail subtree와 JSON pretty 계산을 만들지 않고 실제 펼침에서만 생성한다. 원본 인자·결과·API/pageSize는 바꾸지 않으며 상태/승인 badge와 SVG preview는 유지한다.
- 같은 20 tools·동일 대형 인자/결과를 실제 브라우저에 전달한 전후 비교를 사용한다. historical eager 동작은 browser module의 guard 한곳만 재현하며 working source/DB를 되돌리지 않는다. 양측 동일 React Profiler를 사용하고 production build/p95로 보고하지 않는다.
- SSR shell/bootstrap, history 응답 이후 client/SDK/React 처리, DOM/layout counter를 구분한다. Profiler commit timestamp를 DOM commit duration으로, renderer TaskDuration을 최장 blocking으로 계산하지 않는다. 측정 및 회귀 범위는 `docs/performance-ui-history.md`에 기록한다.

### 모델 목록 대기와 로컬 기록 표시 분리 (2026-10-07)

- 기존 프로젝트/세션 URL의 `SessionView`는 공급자 인증·모델 카탈로그 선택 placeholder보다 먼저 mount한다. 로컬 기록 조회와 shell은 카탈로그 완료나 오류 때문에 숨기지 않는다. API의 실제 세션/인가 검증은 유지한다.
- 모델/인증 준비 여부는 `sendingEnabled`로 변경 동작에 적용한다. 자동 queued turn도 이 gate를 건너뛰지 않으며, 준비 상태가 돌아오면 이전 snapshot을 재사용하지 않고 현재 서버 run/queue를 재조회한 뒤 기존 완료-run 조건을 확인한다.
- 브라우저 검증은 remote catalog를 보류한 채 shell/기록과 A→B→A 표시를 확인하고 503·늦은 B 기록 반환 후 A 격리를 확인한다. lease 응답은 브라우저 fixture이며 실제 서버 변경/모델 실행은 하지 않는다. 이는 독립 hydration/render 비용 측정과는 별개의 검증이다.

### 프로필·프로젝트 사이드바 접힘과 계정 관리 (2026-10-12)

- 사이드바 접힌 프로필은 `공급자 / 모델`만, 연결 이상 시에만 상태를 덧붙인다. 펼치면 구독 공급자의 `계정 목록`에서 계정 추가·전환·이름 변경·해제와 계정별 한도 상태를 본다. 목록·한도 조회는 펼쳤을 때만 실행한다. 한도 조회 요청 자체의 실패는 `조회 불가`와 구분해 표시한다.
- 접힌 프로젝트 표시는 선택된 프로젝트 이름만 보이고, 접근성 이름은 `프로젝트 <이름>`으로 맥락을 유지한다. 선택이 없으면 `프로젝트 선택`을 보인다.

## 배포·개발 환경·성능

### 배포: 실행 파일 (2026-09-15)

- 앱은 실행 파일 하나(`context-agent`)로 배포한다. 실행하면 웹 앱 서버와 에이전트가 한 프로세스에서 뜨고 브라우저를 연다. Node나 저장소가 필요 없다.
- 실행에 필요한 파일은 사용자 공간인 저장 루트 아래에 둔다.
  - 실행 파일 안의 파일(클라이언트 빌드, Kiwi worker, 네이티브 패키지와 임베딩 패키지, codex 매니페스트)은 첫 실행 때 `runtime/<해시>`에 한 번 풀고, 다른 빌드의 폴더는 지운다.
  - codex는 `runtime/codex-*`에 처음 필요할 때 받는다(위 "인증과 모델").
  - 모델은 지금처럼 `models/`에 처음 쓸 때 받는다.
- 서버는 Hono 없이 React Router 핸들러(`@react-router/node` `createRequestListener`)와 `node:http`로 만든다(`apps/agent/server/`).
  - `127.0.0.1`에만 연다. 기본 포트는 5173(ACP 기본 주소와 같음)이고, 사용 중이면 이유를 알리고 끝낸다.
  - 옵션: `[폴더]`(프로젝트로 열 폴더, 없으면 실행 위치), `--port`, `--no-open`, `--storage`.
  - Host 검사: 루프백 이름(`127.0.0.1`, `localhost`, `[::1]`)이 아닌 Host는 403. DNS rebinding으로 다른 사이트가 이 서버에 붙는 것을 막는다(R14). 개발 서버는 Vite의 host 검사에 맡긴다.
  - 기존 교차 사이트 검사(`rejectCrossSite`)는 그대로 둔다.
- 번들: 서버 빌드가 JS 의존성을 모두 담고, `vp pack`이 `server/main.ts`와 함께 한 파일(`dist/context-agent.mjs`)로 묶는다. `vp pack --exe`(Node SEA)가 같은 번들에 런타임 파일을 asset으로 넣어 실행 파일을 만든다(`vp run package`).
- SEA 제약: SEA 본문은 디스크 파일을 `import()`하지 못한다. memory-agent는 네이티브 패키지와 임베딩 패키지를 `require`로만 불러온다(transformers는 Node CommonJS 빌드). worker 안에서는 ESM import가 된다.
- 넣는 패키지와 크기: turbovec, `@napi-rs/keyring`, transformers, onnxruntime(이 플랫폼 bin만), sharp, kiwi-nlp와 그 의존성. 런타임 74 MB, darwin-arm64 실행 파일 238 MB.
  - 뺀 것: `onnxruntime-web`(transformers Node 빌드가 쓰지 않음), onnxruntime-node의 설치 스크립트 의존성.
- 플랫폼마다 그 플랫폼 기기에서 빌드한다. pnpm은 이 기기용 optional 패키지만 받고, turbovec은 이 기기에서만 빌드된다.
- 릴리스는 macOS arm64와 Windows x64만 한다(2026-09-15). GitHub 릴리스를 발행하면 `.github/workflows/release.yml`이 각 러너에서 빌드, 스모크 테스트 뒤 `.tar.gz`/`.zip`(실행 권한 보존)과 `.sha256`을 릴리스에 올린다. Linux는 로컬 빌드만 지원한다: 빌드한 기기의 glibc에 묶이고, 로그인 토큰을 둘 Secret Service가 헤드리스, WSL에 없어서다. 준비물과 절차는 `docs/building.md`.
  - turbovec 애드온(`memory-turbovec.node`)은 저장소에 없어서 새로 받은 기기에서는 Rust(윈도우는 MSVC 빌드 도구도)가 있어야 한다. `vp run package`가 turbovec `build`를 먼저 돌린다(아래 "개발 규칙"). 패키징은 필요한 네이티브 파일(turbovec, onnxruntime, keyring, sharp, Kiwi WASM)이 하나라도 없으면 무엇을 해야 하는지 알리고 멈춘다. 빠진 채로 만든 실행 파일이 첫 검색에서야 실패했기 때문이다.
- 윈도우 차이는 `packages/memory-agent/src/runtime/host.ts` 한 곳에서 다룬다. 플랫폼을 인자로 받아 두 갈래를 모두 테스트한다. 윈도우 기기에서 실제로 실행해 보지는 않았다.
  - 앱이 직접 실행하는 도구(codex, git)는 PATH의 절대 경로 항목에서만 찾는다(윈도우는 PATHEXT 포함). 넘기는 환경 변수는 시스템 폴더와, 윈도우에서 프로그램 실행에 필요한 변수(`SystemRoot`, `ComSpec`, `TEMP` 등)뿐이다. codex에는 자격 증명 저장소를 위해 사용자 폴더 변수(`USERPROFILE`, `APPDATA` 등)도 넘긴다.
  - 셸 도구: POSIX는 `$SHELL -c`(없으면 `/bin/sh`)와 프로세스 그룹 종료, 윈도우는 `cmd.exe /d /s /c`와 `taskkill /T /F`(SIGTERM이 없음).
  - 외부 에이전트는 `cross-spawn`으로 실행해 윈도우의 `npx.cmd` 같은 실행기도 인자를 따옴표 처리해 띄운다. 끝낼 때는 실행기뿐 아니라 프로세스 트리를 끝낸다.
  - 실행 폴더를 프로젝트로 열 때 실행 파일 자신의 폴더도 제외한다(윈도우 탐색기 더블클릭은 거기서 시작).
  - 서버는 SIGHUP(윈도우 콘솔 창 닫기 포함)에도 codex와 인덱스 잠금을 정리한다.
  - 받은 압축(codex, Kiwi 모델)은 윈도우에서 `System32\tar.exe`(bsdtar)로 푼다. PATH 앞에 Git for Windows, MSYS의 GNU tar가 있으면 `C:\…`를 원격 `host:path`로 읽어 실패하기 때문이다. 풀린 폴더를 옮길 때는 백신이 방금 쓴 실행 파일을 검사하느라 잡고 있을 수 있어, `EPERM`, `EACCES`, `EBUSY`면 최대 약 10초 다시 시도한다.
- 실행 파일은 `NODE_OPTIONS`를 무시한다(SEA `execArgvExtension: "none"`). 개발 도구나 사용자의 Node 플래그가 배포된 앱을 바꾸거나 깨뜨리지 않게 하기 위해서다.
- `vp run package`, `vp run smoke-package`는 캐시하지 않는 vite task다. Vite Task의 파일 추적 아래에서는 띄운 실행 파일이 응답하지 않아서, 스모크가 캐시 모드에서 실패했다.
- 서명과 공증은 로컬에서 한다(2026-09-16). CI는 지금처럼 ad-hoc 서명한 실행 파일만 만들고, Developer ID 서명과 공증은 인증서를 가진 사람의 기기에서 `vp run notarize`로 한다. 인증서와 Apple 자격 증명을 GitHub secrets에 두면 그 저장소에 쓰기 권한이 있는 누구나, 어떤 워크플로 변경으로든 우리 이름으로 서명할 수 있게 된다. 릴리스가 잦지 않아서 수동 한 단계로 충분하다.
  - 서명은 항상 `vp pack` 뒤에 한다. `postject`가 SEA 블롭을 넣으며 Mach-O를 고쳐서 Node가 달고 온 서명이 깨진다.
  - 공증 조건이라 하드닝 런타임을 켜고, 인증서가 없을 때(ad-hoc)도 같은 설정으로 서명해 배포본과 같게 동작시킨다. `apps/agent/entitlements.plist`의 예외는 없으면 실행이 안 되는 것들뿐이다: V8 JIT 두 개, codex를 자식 프로세스로 띄우기 위한 dyld 환경 변수, 그리고 라이브러리 검증 해제.
  - 라이브러리 검증을 해제해야 한다. 네이티브 애드온(turbovec, onnxruntime, sharp, keyring)은 첫 실행 때 저장 루트에 풀려서 로드되고, 우리 Team ID로 서명돼 있지 않다. ad-hoc 서명에서는 이 검증이 실제로 걸리지 않으므로 Developer ID로 처음 서명한 빌드는 스모크 테스트를 다시 돌려 확인한다.
  - 배포물은 `.dmg`다. 맨 Mach-O 실행 파일에는 공증 티켓을 붙일 수 없고, 티켓이 없으면 인터넷이 없는 Mac에서 여전히 경고가 뜬다. `.tar.gz`는 CI가 만드는 서명 없는 빌드로 남는다.
  - 미룬 것: `.app` 번들, 자동 업데이트, Windows 코드 서명(EV 인증서).
- 검증은 `vp run smoke-package`로 한다. 실행 파일을 저장소 밖에서 임시 저장 루트로 띄워 첫 실행 자원 풀기, Host, 교차 사이트 차단, codex 받기, 검증, 실행, 프로젝트, 세션, keyring, acp, 종료 정리, 두 번째 실행 재사용을 확인한다.
  - 측정: 첫 실행 3초, codex 받기 11초, 두 번째 실행 0.5초.

### 개발 backend 변경 감지 (2026-09-21)

- HMR frontend와 안정 backend의 build id가 다르면 모든 browser fetch가 `backend_restart_required`와 `backend_restarting` 응답을 감지한다. 일반 JSON API뿐 아니라 채팅 SSE도 같은 전역 상태를 올린다.
- Fast Refresh 대상인 `app/entry/*.tsx`는 런타임에 React 컴포넌트만 export한다. 훅, context, 변환 함수, 초기 실행 스크립트는 `.ts` 모듈로 분리하고 `react/only-export-components`를 오류로 검사한다. 타입 전용 export와 React Router가 요구하는 route export는 예외다.
- 재시작 필요 상태에서는 대화 초안을 보존한 채 입력, 첨부, workflow 변경과 전송을 비활성화한다. 화면 위 경고는 유지하며, backend는 차단한 method, path, backend build id와 browser build id를 터미널에 기록한다.

### 개발 서버의 네이티브 빌드 (2026-09-26)

- `pnpm dev`와 `pnpm dev:agent`는 안정 backend를 빌드하기 전에 `vp run turbovec#build`를 실행한다. 네이티브 빌드 실패 시 backend와 frontend를 시작하지 않는다. 기존의 React Router 직접 빌드 경로는 Vite Task의 의존 빌드를 거치지 않아 새 checkout에서 `memory-turbovec.node` 없이 시작하려 했다.

### 반복 API 지연의 제한된 계측과 no-HMR backend 검증 (2026-10-07)

- SQL 추가 검증은 과도한 전체 조회 여부에 한정한다. 약10초 지연이 기동 이후 반복될 때만 해당 지연을 조사한다.
- API GET 계측은 개발 모드 또는 기존 `--dev-backend`에서만 숫자형 단계시간을 제공한다. 모델·계정·토큰·오류본문은 노출하지 않고 응답 JSON·인가·POST 계약을 유지한다.
- stable dev backend는 빌드된 no-HMR 런타임이므로, 현재 소스 검증과 live API 증거를 build fingerprint로 구분한다. 프론트엔드 cwd가 같다는 사실만으로 backend가 현재 소스를 실행한다고 간주하지 않는다.
- active run·승인 및 병행 리팩토링을 보존하기 위해 현재 서버를 임의 종료하지 않는다. live 단계 계측은 coordinated backend 재빌드·재기동 후 확인하며 적용되지 않은 코드를 성능 개선 완료로 보고하지 않는다.

### 개발 서버 시작 실패의 프로세스 정리 (2026-10-07)

- 개발 backend manifest를 쓰기 전에 상위 build 디렉터리를 생성한다. 서버 준비 확인·manifest 기록·frontend 시작 중 어느 단계에서 실패해도 해당 실행이 만든 backend와 frontend를 종료한다.
- manifest 삭제는 기존 build ID 소유권 확인을 유지하며 다른 실행이 만든 manifest를 지우지 않는다.

### Local API: limited final verification (2026-10-08)

- After the user's rebuild/restart, served/current backend fingerprints match `b69717d9c665d257f255185d`. Twenty subsequent observations per endpoint reproduce no ≥10-second delay; all 84 requests, including first observations and static/health controls, return 200. This is bounded observation, not proof of a permanent cure or causal attribution to the FTS edit across parallel refactoring.
- Residual API/health wall-time maxima are 3.7–3.8 seconds while static remains below 30 ms. Retain this as unresolved; do not claim the local API p95 target was met. The first observed catalog request (291 ms) is not proven cold startup.
- Follow Goal v6/Plan v13: do not expand deep API/SQL investigation when the later ten-second episode is not reproduced. Targeted final current-source regressions pass 59/59 across 11 existing files, with search format/lint/type passing. Reuse earlier storage/bytes/UI/0.0.13 browser and rollback evidence explicitly as historical; parallel frontend changes are not re-benchmarked by these tests.
- No operating DB mutation, model/tool replay, schema change or assistant-initiated service restart in this verification. See `performance-api-streaming.md` for measurements and limits.

### dev 중복 실행과 시작 실패의 명시적 종료 (2026-10-11)

- dev 감독 프로세스는 자신이 시작할 backend/UI 포트의 사용 가능 여부를 backend build 전에 확인한다. 포트 충돌은 종료 코드 1로 보고하고 기존 서버는 유지한다. 의존성 빌드는 기존 Vite+ task 순서를 유지한다.
- backend 준비 대기는 해당 자식 프로세스의 종료와 함께 감시한다. 이미 종료된 자식의 exit를 뒤늦게 기다리며 멈추지 않는다. UI 주소는 실제 Vite loopback 기본값인 `localhost`로 안내한다.
- 동일 기본 명령의 재현·정상 시작·중복 실행, 격리 dev 회귀 17개, 실제 5173 UI 및 5180 health와 DB schema/기존 복구 기록 보존을 확인했다. 자세한 결과는 [dev 시작 검증](dev-startup-failure-2026-10-11.md)에 기록한다.

### native search worker의 시작 의존성 제한 (2026-10-11)

- Native search worker는 필요한 공식 `@effect/platform-node/NodeFileSystem`과 `NodePath` 하위 모듈을 직접 가져온다. 전체 platform-node 진입점은 사용하지 않는 NodeRedis와 Redis SDK까지 ESM 평가하므로, 이 worker의 2초 시작 계약에는 불필요한 비용이다.
- worker 생성·모듈 로딩·첫 SQLite 검사·native extension 초기화·ready를 /tmp의 격리 preload로 계측했다. 같은 공식 Effect preview와 원래 실패한 두 파일의 두 worker 실행에서 로딩 모듈은 1,113→310개로 감소했다. 스키마 검사, cache lease, 인덱스 초기화, IPC 계약과 2초 시작 제한은 변경하지 않는다.
- 이 프로젝트는 릴리스 전 로컬 개발 환경이다. 요청된 수정은 실제 사용하는 dev 경로에 반영하며 별도 운영 배포 승인을 요구하지 않는다. 로컬 데이터 보존과 활성 모델 작업 보호는 유지한다. 재시작 전 DB의 running 기록 0개와 대상 세션 비실행 상태를 확인했다. 완료된 해시 마이그레이션을 다시 실행하지 않았다.

### release 서명과 Crypto 진단의 작업별 판정 (2026-10-11)

- release manifest의 canonical UTF-8, Ed25519 PKCS#8/SPKI PEM 키, 원문 직접 서명과 Base64 wire 계약을 보존한다. 서명을 SHA digest로 대체하지 않는다. 설치된 공식 Effect Crypto 및 NodeCrypto는 난수·UUID·SHA digest를 제공하지만 서명·검증·키 import/generation을 제공하지 않는다.
- canonical UTF-8는 TextEncoder, 서명 Base64 출력은 공식 Effect Base64.encode를 사용한다. 입력의 기존 unpadded/base64url/whitespace 허용 계약은 엄격한 Base64.decode와 다르므로 기존 디코더를 유지한다.
- TS377057은 모듈 단위 안내다. 개별 연산과 드라이버를 확인하여 판정하며 Crypto 경고 5곳 전체를 미지원으로 묶지 않는다. UUID는 지원되고, 서명·키 생성·상수시간 비교·증분 digest는 현재 서비스에 없다. 진단 억제나 다른 import 경로로 경고를 숨기지 않는다.

### 기억 정리 쿼리의 조회 범위와 API 지연 (2026-10-15)

- 백그라운드 그래프 정리도 서버와 같은 동기 SQLite 연결을 쓰므로 긴 쿼리가 provider usage와 모델 조회를 막을 수 있다. 실제 프로파일에서 이전 파일 읽기 억제 쿼리와 주제 정리 큐 조회가 병목이었다.
- 이전 읽기 탐색은 현재 결과 → 호출 → 파일 참조 인덱스 → 이전 호출 순서로 `CROSS JOIN`을 고정한다. 프로젝트의 모든 호출을 먼저 읽는 실행 계획을 피하며 원문 보존·프로젝트 경계·해시 비교 조건은 유지한다.
- 주제 정리는 후보 큐부터 순서대로 읽고 노드를 기본 키로 조회한다. 큐가 비었을 때 전체 nodes를 훑지 않는다. 진행 위치·배치 트랜잭션·벡터 제거 재시도는 유지한다.
- 같은 실제 DB의 읽기 전용 비교에서 파일 읽기 4건의 후보 조회는 1,469ms → 25ms, 빈 주제 큐 조회는 62.6ms → 0.022ms였다. 이는 쿼리 측정이다. 수정본 재시작 후 별도로 측정한 캐시 만료 usage HTTP 응답은 OpenAI 1.34초·Anthropic 0.52초였고, 캐시 적중은 약 0.09초, 모델 목록은 약 0.11초였다. 초기화가 포함된 재시작 직후 첫 usage 응답은 각각 5.52초·2.80초였다. 모두 단일 로컬 관측값이며 분포 측정은 아니다.

## 테스트

### 테스트의 고정 대기 줄이기 (2026-09-29)

- 채팅 실행, 큐 전달, 보관 테스트의 가짜 provider가 완료를 기다리는 데 쓰던 2초와 700ms 지연을 테스트가 직접 여는 게이트로 바꾼다. 취소나 서비스 종료 시에는 실제 TanStack 요청의 abort signal로 게이트를 풀어, 시간 경과 없이 해당 경로를 검증한다.
- 큐 취소 후 클라이언트 로딩이 끝나는지 확인하는 한 사례는 게이트로 바꾸면 기존 스트림 종료 계약을 확인할 수 없어 고정 지연을 유지한다. 측정된 느린 사례는 서로 다른 동작을 검증하므로 테스트 삭제나 파일 격리 해제는 하지 않는다.
- ACP의 취소와 세션 재생은 서로 다른 계약인데 한 테스트에 묶여 5초 제한에 가까웠다. 둘을 분리하고 취소 사례에만 10초 제한을 둔다. 가짜 응답 게이트로 바꾸면 ACP 클라이언트의 스트림 종료를 확인할 수 없어 해당 지연은 유지한다.
- 1,000개 작업을 만드는 Work Trace 성능 테스트는 병렬 실행 부하에서 바깥쪽 5초 제한을 넘었다. 바깥쪽 제한만 10초로 늘리고, 실제 투영 구간의 1초 성능 기준은 유지한다.
- 변경 전 `memory-agent` 전체 테스트는 79개 파일, 559개 통과에 54.43초였다. 변경 후 통과 실행은 현재 작업트리의 추가 테스트를 포함해 38.78초와 48.43초(80개 파일, 최종 567개 통과)였다. 중간 실행은 시스템 부하와 두 시간 제한 실패로 53.09초, 59.70초까지 흔들렸다. 직접 바꾼 세 파일의 테스트 본문은 처음 측정한 약 21.8초에서 약 7.3초로 줄었다.

### Work Trace 투영 성능 테스트 준비 (2026-09-30)

- 1,000개 작업의 조회 성능을 검증할 때 준비용 작업 삽입은 하나의 바깥쪽 트랜잭션으로 묶는다. 투영 측정 구간과 1초 기준은 그대로 유지하고, 이 테스트에서 작업 1건씩 영속화하는 비용은 측정하지 않는다.

### 취소 재전송과 비동기 테스트 대기 (2026-09-30)

- 클라이언트가 이미 중단된 `runId`로 POST를 다시 보내면 같은 실행의 스트림을 처음부터 재생한다. 취소된 사용자 요청을 새 실행으로 처리해 모델을 다시 부르지 않는다.
- 테스트용 모델 어댑터는 TanStack이 전달하는 요청의 abort signal로 지연을 끝낸다. 큐와 ACP 취소 검사는 고정된 2초 응답을 기다리지 않고 테스트 게이트와 실제 취소 신호로 검증한다.
- 비동기 하위 에이전트 검사의 700ms·2초 모의 응답도 테스트가 필요한 시점에 여는 게이트로 바꾼다. 부모 실행 중, 자식 완료, 취소와 재시작의 순서는 각 사례가 명시적으로 확인한다.

### Vitest 테스트 격리와 비동기 검증 (2026-10-04)

- 테스트의 상태 전이 대기는 `expect.poll`로 확인하고 제한 시간 안에 조건을 만족하지 못하면 실패시킨다. 실제 서버·프로세스 종료를 검증하는 테스트의 실행 환경은 유지한다.
- 병렬 실행은 두 작업이 완료 gate 해제 전에 모두 시작되는지 검증한다. 벽시계 실행 시간으로 병렬성을 판정하지 않는다.
- 환경변수 대체는 `vi.stubEnv`와 `vi.unstubAllEnvs`로 원래 값을 복구한다. Vitest 5의 테스트별 mock 호출 기록 초기화를 사용하고 이전 테스트의 호출 기록에 의존하지 않는다.

### 테스트의 Effect 진단 억제 제거 기준 (2026-10-07)

- Effect 서비스·Schema를 검증하는 테스트는 `@effect/vitest`에서 Effect를 직접 실행한다. 기존 fixture가 소유한 ManagedRuntime의 Context를 받아 서비스를 조회하고, 테스트 내부의 반복 `runPromise` 진입을 없앤다. fixture의 기존 자원 정리 계약은 유지한다.
- Schema 검증은 Effect 디코더로 실행하며, 기대하는 typed failure는 `Effect.flip`으로 검증한다. SDK AsyncIterable은 Stream으로 소비하고 오류 원인을 보존한다. Promise를 요구하는 즉시 값 콜백은 SDK 경계에서만 `Promise.resolve`로 반환한다.
- 진단 억제는 원인을 수정하거나 이미 원인이 사라졌음을 검증한 뒤 제거한다. 억제를 다른 위치로 옮기거나 설정을 약화하지 않는다. 프로세스·브라우저·외부 SDK의 호출 계약 또는 동기 fixture API 변경이 필요한 항목은 별도로 설계한다.
- SDK 테스트의 AbortController는 `SdkCancellations`를 통해 테스트 Scope에 연결한다. Promise 배리어와 네이티브 종료 이벤트는 `Deferred`로 기다리고, 병렬 테스트는 Effect의 동시성을 명시한다. ScriptedTextAdapter는 응답 함수·외부 Promise·지연을 Stream의 Fiber에서 기다리고 `Stream.toAsyncIterable`로 SDK에 전달한다. iterator 종료는 대기 Fiber를 중단하며, 원래 rejection과 실패 전에 전달한 청크를 유지한다.
- 공통 `testRuntime` fixture는 테스트 Scope가 임시 디렉터리와 모든 재시작 런타임을 소유한다. 파일 I/O는 `FileSystem`·`Path` 서비스로 수행하고 초기화 Fiber도 해당 Scope에 연결한다. 런타임 재시작은 저장소 Scope를 닫지 않으며, 테스트 종료 시 초기화 중단·런타임 해제·디렉터리 제거 순서를 유지한다. SDK 클라이언트 상태를 기다리는 테스트는 Effect의 반복과 시간 제한을 사용하고 클라이언트를 Scope에서 해제한다.
- scripted responder와 테스트 배리어는 요구 서비스가 없는 Effect도 받을 수 있다. 공통 `turnGate`는 Deferred로 만들고 스트림의 실행 Fiber에서 직접 기다린다. 기존 Promise 응답·대기 계약은 유지하며, 의도적으로 취소를 무시하는 네이티브 SDK·서브프로세스 실험은 해당 경계에서만 Promise로 실행한다. Effect 대기는 취소 시 정리를 마친 뒤 SDK 스트림을 종료한다.
- 원인 수정의 검증은 `vp run typecheck`로 앱·memory-agent·utils와 서버 테스트용 프로젝트를 모두 검사한다. Vite Task는 병렬 실행 중에도 다른 패키지의 진단 실패로 앱 작업을 중단할 수 있으므로 각 검사 결과를 모은 뒤 최종 실패를 반환한다. 앱의 `tsc`가 경고로 중단되어도 서버 테스트용 프로젝트를 검사한다.

### 모듈 모킹 없이 테스트 의존성 구성 (2026-10-07)

- 테스트는 `vi.mock`으로 모듈 그래프를 바꾸지 않는다. HTTP 클라이언트와 서버 핸들러는 생성 함수로 전송 함수와 Effect 런타임을 주입한다.
- Goal 워커의 소스 경로와 생성 관찰자는 런타임의 `GoalWorkerConfiguration`으로 구성한다. SQLite 생성 함수는 Database Layer에서 주입하고, 파일 캡처 경쟁은 캡처 읽기 함수를 주입해 재현한다. 실제 워커·SQLite와 종료·재시작 검증은 유지한다.

### 테스트의 Fiber와 네이티브 SDK 게이트 (2026-10-07)

- Effect 테스트가 시작하는 조회·스트림 소비 Fiber는 해당 테스트 Scope에 연결한다. 동시 조회의 시작 순서가 계약인 경우 `startImmediately`로 기존 순서를 보존한다.
- SDK가 요구하는 안정적인 Promise 대기값은 Deferred와 캡처한 실행 컨텍스트로 제공한다. Scope 종료 때 대기 Fiber를 정리하고, 공유 조회의 소비자 취소·소유자 취소·늦은 결과 차단을 실제 서비스로 검증한다.
- Effect의 Scope 신호와 호출 Fiber의 취소 신호를 구분한다. 취소 가능한 네이티브 명령에는 `Effect.tryPromise`의 신호를 전달하고, Promise가 종료될 때까지 기다린 뒤 임시 파일을 제거한다.
- 실제 stdio·별도 Node 프로세스·Ed25519 PEM 키 생성처럼 SDK 또는 플랫폼 API가 필요한 경계는 명시적으로 유지한다. 진단 억제 주석이나 진단 수준 하향으로 감추지 않는다.
- 실행 종료 후 큐와 새 Goal 요청을 정리하는 작업도 실행의 해제 Effect가 기다린다. `ended` 신호는 이 정리가 끝난 뒤 완료하여, SQLite와 이벤트 서비스를 닫은 뒤 미처리 Promise가 남지 않게 한다.
- 서비스 Scope 종료는 SDK에 `service_shutdown` 사유를 먼저 전달한 뒤 생산 Fiber를 중단한다. 완료한 실행은 중단하지 않으며, 종료 당시 진행 중인 실행은 `failed/server_restarted`로 남긴다. 사용자의 명시적 취소는 기존 `aborted` 의미를 유지한다.

### SQLite lock regression coverage (2026-10-10)

- Keep the original subagent parent-cancellation and restart-recovery integration test. It exercises the production memory-agent Layer with a real temporary SQLite database and fake providers; it is not a Rust implementation-only test.
- Evaluate the Node SQLite API-table bridge with an offline, locked Cargo build in a temporary target directory. Test-only module resolution selects the temporary addon without replacing the checkout addon or restarting a user's server. The final Mac SEA package passed startup/core APIs/reopen/exit-0 checks outside the checkout without Node/compiler on PATH; unpacked artifact search/Goal regressions also passed. Windows packaging remains a CI verification item, and no installation or deployment is implied.
- Preserve SQLite locking and WAL visibility. Diagnostic stress coverage supplements actual MemorySearch and runtime reopen coverage rather than replacing that contract with bundled-Rust unit tests.

### 목적별 테스트 구조와 Effect 테스트 환경 (2026-10-11)

- 테스트는 목적에 따라 나눈다. 외부 자원 없이 한 모듈의 로직을 검증하는 unit 테스트는 `src/**`의 모듈 옆에 두고, 실제 에이전트 준비가 필요한 테스트는 `tests/<기능>/` 기능 슬라이스에 모은다. 실제 프로세스·OS 자원을 다루는 테스트는 별도 슬라이스로 분리한다.
- 기능 슬라이스는 `tests/support/test-env.ts`의 `TestEnv` Layer를 쓴다. 임시 저장소, 프로젝트, 세션을 가진 실제 에이전트를 Layer로 제공하고 에이전트 서비스를 테스트에서 직접 `yield*`한다. 재시작은 `TestEnv.reopen`이 이전 에이전트의 Scope를 닫은 뒤 같은 저장소로 다시 열고, 그 뒤의 서비스는 `TestEnv.use`로 얻는다.
- 슬라이스는 `testAgent()` 블록마다 에이전트 하나를 공유하고, 각 테스트는 새 세션으로 상태를 격리한다. 데이터베이스 전체에 영향을 주는 테스트(트리거 추가 등)는 자기 블록을 따로 둔다. 저장 시각과 lease를 검증하므로 블록은 실제 Clock을 쓴다.
- 테스트 안에서 `Effect.provide(layer)`, `Layer.build`, `ManagedRuntime`, `Effect.runPromise`로 런타임을 직접 다루지 않는다. 다른 Layer 구성이 필요하면 `@effect/vitest`의 `layer(...)` 블록을 진입점으로 둔다. 이전 Promise 기반 `testRuntime()`은 모든 사용처를 옮긴 뒤 제거했다(2026-10-12).
- 버그 수정마다 회귀 테스트 파일을 새로 만들지 않는다. 해당 기능 슬라이스에 계약 단위로 추가하고, 같은 계약을 중복 검증하거나 타입으로 이미 보장되는 테스트는 합치거나 지운다.

## BTW 별도 질문 채팅 (2026-10-12)

- BTW는 메인 세션에 영구히 묶인 별도 스레드(`btw_threads`)다. 일반 `sessions` 행이 아니므로 모드 전환 API가 없고, 부모 세션·생성 시각은 트리거로 불변이다. 부모 세션을 삭제하면 BTW도 FK cascade로 함께 지워진다.
- 참조 범위: 매 요청 시점의 최신 메인 대화(user/assistant 노드, 최신부터 24,000자, 메시지당 4,000자 상한, 노드 ID 포함)와 같은 프로젝트의 기억만 읽는다. 교차 프로젝트 기억은 BTW에서 검색하지 않는다. BTW 내용은 메인 대화로 역병합하지 않는다.
- 도구 allowlist는 `find_memory`·`read_evidence`·`trace_evidence`(같은 프로젝트, 실행 바인딩 없음: 검색·사용 기록이나 승격을 남기지 않음)뿐이다. 서버는 이 목록만 구성하고, 미들웨어가 요청 단계에서 다른 도구를 제거하며 다른 이름의 호출은 실행하지 않고 거부한다. 요청 본문의 도구 정의는 반영하지 않는다. 쓰기·승격·워크플로·파일·셸·하위 실행·MCP·웹 도구는 제공하지 않는다.
- BTW의 질문·답변·도구 호출·도구 결과는 `btw_threads.messages`에만 저장한다. nodes·FTS·벡터·형태소·해석 작업·기억 승격·API 사용 장부·chat_runs에 쓰지 않으므로 백그라운드 pending 인덱싱과 재시작 후에도 검색·해석 대상이 될 수 없다. 기록·인덱싱·해석·요약 미들웨어는 BTW 실행에 붙이지 않는다.
- 이미지는 `btw_attachments`로 스레드에 연결해 보존한다. 고아 첨부 정리는 노드와 BTW 참조가 모두 없을 때만 파일을 지운다. 이 표에는 attachments FK를 두지 않는다: 이전 릴리스의 고아 정리가 FK 위반으로 시작에 실패하지 않게 하고, 그 경우 BTW 전용 이미지가 먼저 지워지는 쪽으로 실패한다.
- 명시적 삭제는 실행 중인 답변을 먼저 중단·종료 대기한 뒤 스레드 행 하나를 지워(메시지·도구 전사 포함, 첨부 연결은 cascade) 한 트랜잭션으로 끝내고, 그다음 더 이상 참조되지 않는 이미지 파일을 지운다. 파일 정리가 실패해도 활성 DB에는 참조가 남지 않으며 다음 고아 정리가 파일을 지운다. SQLite 여유 페이지·WAL·백업·외부 모델 제공자 기록의 소거는 보장하지 않으며 UI에 그대로 안내한다.
- 호환성·롤백: 추가 마이그레이션 하나로 새 표 두 개만 만든다. 기존 세션·노드는 백필하지 않는다. 이 단계를 모르는 이전 릴리스로 롤백하면 BTW 표를 읽지 않으므로 BTW 대화가 세션 목록에 나타나거나 색인되지 않는다. `user_version`은 낮추지 않는다.
- 패널 입력은 텍스트만 받는다. 서버 경로는 이미지 첨부의 연결·삭제 정리를 지원하지만 BTW 작성기에는 첨부 UI를 두지 않았다. 패널을 닫으면 열려 있던 BTW 선택을 지워 다른 대화에서 이전 BTW가 열리지 않게 하고, 목록에서 다시 연다.
- 검증은 실제 API 라우트와 런타임 Layer를 임시 저장소·메모리 비밀 저장소·스크립트 모델로 실행하는 테스트와 Chromium 컴포넌트 테스트로 한다. 현재 dev 실행은 저장소를 옮겨도 OS 키체인 서비스를 전역으로 읽으므로 사용하지 않았다.

## Node builtin을 설치본 Effect API로 교체하는 기준 (2026-10-12)

- 설치본 `effect`·`@effect/platform-node`에 같은 동작의 API가 있으면 Node builtin 대신 쓴다. 판단은 설치된 `src`로
  하고, 동작(정밀도, 동기성, 종료·신호 계약, 테스트 단언)이 하나라도 달라지면 바꾸지 않고 부족한 API를 기록한다.
- 이번에 바꾼 곳: 테스트 HTTP 서버 3곳(`NodeHttpServer.layerTest`), OAuth 하네스 UUID(`Crypto.randomUUIDv4`),
  io-range 테스트의 경로 stat·`/dev/fd` 목록(FileSystem).
- 남긴 곳과 이유: `text.ts` no-follow 페이지 읽기(ns ctime/mtime stamp), 셸·프로세스 트리 종료(동기 kill, 신호 이름,
  Windows verbatim 인자, pipe abandonment), io-range의 descriptor 번호 fstat, owner-workflow-engine의 encoded
  채널(래핑 시 finalizer·compensation cause가 바뀌고, Activity R 축소는 거짓 타입). 나머지 sync fence, Ed25519,
  `timingSafeEqual`, 운영 http factory, posix glob은 대응 API가 없다. 근거 표는 `docs/efx11-12-verification.md`.
- 진단을 없애려고 억제·severity 변경·타입 단언을 쓰지 않는다. Effect 업그레이드 때 이 목록을 다시 대조한다.

## 남은 Node builtin 2차 전환 (2026-10-12)

- 사용자 결정: lstat·SHA-256·Ed25519·`timingSafeEqual`을 동작·보안 계약을 유지하는 범위에서 없앤다. sync fence,
  posix glob, 운영 http factory, child_process, owner-workflow-engine은 대상이 아니다.
- release 서명은 런타임 표준 WebCrypto(`crypto.subtle` Ed25519)를 `Effect.tryPromise`와 typed error로 쓴다. 앞 절의
  "Ed25519 대응 API 없음"은 effect Crypto만 본 판단이었다. 키는 계속 SPKI·PKCS#8 PEM이고 서명 바이트가 같으며 기존
  node:crypto 서명이 검증된다. trust anchor 자리의 private key PEM·인증서는 더 이상 받지 않는다.
- 상수시간 비교는 TypeScript로 쓴다(길이가 다르면 false, 같으면 전 바이트 XOR 누적). 입력이 메모리에 다 있거나 기존
  상한(텍스트 2 MiB)이 있는 SHA-256은 `Crypto.digest`로, 상한 없는 패키지 manifest 해시는 증분 `createHash`로 둔다.
- lstat은 `readLink`(성공=링크) + reason `Unknown`(EINVAL)일 때 `FileSystem.stat`으로 대체한다. `open(noFollow)`는
  Windows 미지원·FIFO 블록·무권한 EACCES로 계약이 달라 쓰지 않는다. 두 호출 사이 교체 시 링크 대상으로 분류되는
  race 차이는 받아들이되(코디네이터 결정) 이후 사용이 별도로 보호되거나 자체 출력인 skills·패키지 스크립트에만
  적용한다. `paths.ts`는 동기 검사라 lstat을 유지한다.
- 갱신(2026-10-12): `listing.ts`도 import 제거를 시도했으나 설치본 `readDirectory`는 전체 이름 배열만 주고 디렉터리
  스트림이 없어, `walkLimit`에서 멈추는 `opendir` walk의 디렉터리당 메모리 상한(30만 항목 실측 +11 MB 대 +68 MB,
  6.0초 대 0.86초)과 부분 읽기 계약이 깨진다. `opendir`·`lstat`을 유지한다.
- 근거 표는 `docs/efx11-12-verification.md` "Node builtin 경계 2차 전환"에 있다.

## 조회 시점의 구조화된 기억 근거 (2026-10-15)

- `read_evidence`는 기존 원문 페이지·메타데이터에 `evidenceContext`를 추가한다. 원문을 요약으로 대체하거나 새 사실을 저장하지 않고, 기존 Nodes·Graph·Interpretations로 출처와 정정/철회 관계를 함께 읽는다. 검색 후보·순위·도구 목록·승격 계약은 유지한다.
- 원문과 발췌에는 UTF-16 위치와 이어 읽기 위치를 붙인다. 부가 원문은 출처 최대 4개, 변경 최대 8개, 각각 최대 600자로 제한한다. 직접 적용된 변경을 우선하며 잘린 개수를 표시한다. 판정은 잘리기 전 관계 전체를 사용하고, 미확정 변경 존재 여부도 별도로 표시한다. 이 상한은 반환 텍스트에 대한 것이며 DB 조회량이나 모델 토큰 수의 상한은 아니다.
- `recorded_change`는 읽은 노드 자체, `context_changed`는 원인 노드에 적용된 관계가 있음을 뜻한다. `unresolved`는 미확정 관계만, `no_recorded_change`는 발견된 적격 관계가 없음을 뜻한다. `untraced`는 그래프에서 출처를 추적할 수 없는 경우다. 어느 값도 현재 사실의 유효성을 인증하지 않는다.
- 정정/철회는 대상과 같은 프로젝트의 더 나중 사용자 노드만 근거로 삼는다. `applied`도 자동 해석이 적용되었다는 뜻이며 사용자 확인과 같지 않다. 대체 원문 자체의 추가 정정은 그 원문을 다시 읽어 확인한다. 기록 시각과 사실의 적용 시점을 구분하고, 조건·예외는 원문에서 확인한다.
- 현재 프로젝트·교차 검색 제외 설정을 원문·출처·변경에 적용한다. 허용되지 않은 중간 출처에서 추적을 멈추고 `provenanceScopeLimited`를 표시한다. BTW도 기존의 프로젝트 한정 범위를 유지한다. 저장소 읽기 실패는 `EvidenceReadFailed/StorageRead`로 반환하며 변경 없음으로 바꾸지 않는다. typed error로 바꾸는 범위는 SQLite 읽기 호출로 한정하고 실패 단계(`scope`·`source`·`trace`·`pending_changes`)만 남긴다. 원래 예외는 경로·행 내용을 담을 수 있어 오류에 싣지 않는다. 판정·조립 코드의 결함은 defect로 남긴다.
- 같은 출처·대상·관계가 이미 적용되었으면 남아 있는 unconfirmed 해석은 미확정 변경으로 세지 않는다.
- 정정 근거 필터(같은 프로젝트·더 나중 사용자 노드)는 `read_evidence`에만 적용한다. `find_memory`의 `supersededBy`와 `trace_evidence`의 `challengedBy`는 기존처럼 필터 없이 관계를 보여 주므로 두 도구와 `read_evidence`의 판정이 다를 수 있다. 판정 규칙의 통합은 후속 작업으로 남긴다. (2026-10-16 "기억 변경 판정 규칙 통합"에서 통합함)
- 이후 읽기로 대체된 `tool_result`는 그래프에서 제외되므로 원문은 읽히지만 `untraced`로 표시된다. 대체 여부를 별도 상태로 구분하려면 Graph 추적 API를 바꿔야 하므로 이번 단계에서는 유지한다. (2026-10-16 "기억 변경 판정 규칙 통합"에서 변경함)
- 이번 단계는 근거 전달 계약을 실제 저장소 테스트로 검증한다. 모델의 최종 답변 정확도 향상이나 철회된 근거의 사용 차단을 입증한 것은 아니다. 모델·검색 후보·토큰 예산을 고정한 답변 정확도/필수 근거 포함률/철회 근거 사용률 비교는 별도 평가가 필요하다. 그 파일럿 결과는 아래 "구조화 기억 읽기 파일럿 평가 (2026-10-15)"에 있다.

## 사이드바 하단 계정 전환기 (2026-10-12)

- 사용 중인 계정은 사이드바 맨 아래에 공급자 표시·이름·한도 게이지로 보이고, 누르면 ChatGPT·Claude 프로필과 OpenAI 호환
  설정을 한 목록에서 고른다. 항목마다 공급자 이름을 함께 보인다.
- 사용 중인 계정은 모델 선택의 공급자에서 선택된 프로필이다. 다른 공급자의 계정으로 바꾸면 그 공급자의 기본 모델을
  함께 선택한다. 모델 선택이 하나라서, 모델을 남겨 두면 표시된 계정과 실제로 실행되는 계정이 달라지기 때문이다.
- 계정 추가·이름 변경·해제·연결 해제는 전환 메뉴의 "계정 추가·관리" 대화상자로 옮기고, 위쪽 패널은 모델 설정만 둔다.
- 개정(2026-10-13, 사용자 결정): 전환기 버튼과 메뉴 항목은 "공급자 · 이름"을 한 줄로 보인다. 계정 관리는 전환기 옆
  설정 버튼이 여는 Sheet에서 모든 공급자의 프로필을 한 목록으로 보여 주고, 행마다 이름 변경·로그아웃, 목록 아래에서
  공급자를 골라 계정을 추가한다. 공급자를 먼저 골라야 그 계정 목록이 보이던 선택 상자는 없앤다. 전환은 전환기에서만
  한다. "사용 중" 표시는 모델 선택의 공급자에서 선택된 프로필 하나에만 붙인다.
- 개정(2026-10-13, 사용자 결정, Orca의 사용량 메뉴·계정 화면 참고): 전환기 행은 아이콘·"공급자 · 이름"·가장 많이
  쓴 창의 초기화까지 남은 시간(`3d 8h 7m`)과 사용률만 한 줄로 보이고, 창별 막대는 관리 Sheet에 둔다. Sheet는
  공급자 섹션마다 제목·설명·"계정 추가" 버튼을 두고, 계정 카드에 이름·조회 시각과 "이름 변경"·"로그아웃" 버튼,
  창마다 이름·막대·"N% 사용"·"… 후 초기화"를 보인다. 공급자 아이콘은 ChatGPT에 Codex, Claude에 Claude 로고
  (lobe-icons의 MIT SVG를 앱 자산으로 복사, 패키지 의존성 없음), OpenAI 호환에는 lucide `CpuIcon`을 쓴다.

## main 타입 검사와 미지원 Effect 경계 (2026-10-15)

- 사용자 결정: TypeScript·Effect error와 지원 API로 고칠 수 있는 warning은 코드에서 수정한다.
  설치본에 동등한 API가 없는 warning은 의존성 patch를 추가하지 않고 남겨 보고한다.
  warning도 실패시키는 검사 정책은 유지한다. 상세 목록은 [검증 기록](main-typecheck-2026-10-15.md)을 따른다.
- Provider retry의 durable wait 실패는 취소로 변환하지 않고 실제 typed error를 전파한다.
- uncertain run 승인은 SQLite의 동기 read/compare/write transaction을 유지하면서 Schema Result를
  Effect 오류 채널로 연결한다. 승인 목록이 바뀌었거나 검증·저장에 실패하면 승인하지 않는다.

## 구조화 기억 읽기 파일럿 평가 (2026-10-15)

- 실제 설정 모델로 고정 후보 8개를 2회씩 비교한다. 기존 읽기, 기존 읽기+추적, 구조화 읽기를 구분하고
  정답률과 필수 근거 구절 포함률·인용률을 별도로 기록한다. 기본 명령은 dry-run이며 `--live`에서만 호출한다.
- 사용자 저장소는 선택한 모델·프로필 확인에만 사용하고 합성 사례는 임시 저장소에서 실행한다.
  출력에는 합성 원문·답변·점수를 남기되 인증 정보와 프로필 ID는 남기지 않는다.
- 입력 토큰 상한은 같지만 실제 근거량은 다르다. 이번 정답률 차이는 긴 발췌에서 발생했으므로
  구조 자체의 인과 효과나 전체 에이전트 정확도 개선으로 해석하지 않는다.
  [실측 결과와 한계](structured-memory-benchmark-2026-10-15.md)를 함께 보고한다.
- 사용자 제안에 따라 질문 시각, 후속 근거 조회, 동일 정보의 JSON/문장 표현을 분리한 추가 평가를 둔다.
  후속 조회는 평가기가 강제하며 제품의 자동 조회 정책으로 도입하지 않는다. 해당 8개 사례에서는
  질문 시각 추가가 후속 철회 실패를 해결하지 않았고, 후속 조회를 하면 두 표현 모두 맞혔다.
  [추가 비교](structured-memory-ablation-2026-10-15.md)의 결과를 구조의 일반적 충분성으로 확대하지 않는다.

## 기억 변경 판정 규칙 통합 (2026-10-16)

- 정정/철회 근거는 `find_memory`·`trace_evidence`·`read_evidence` 모두 같은 규칙으로 판정한다. 대상과 같은 프로젝트의 더 나중 사용자 노드만 인정한다. 규칙은 `memory/changes.ts`의 `isChangeAuthority`와 같은 조건의 SQL 조각 하나로 둔다.
- `find_memory`의 `supersededBy`·`unconfirmedChallenges`도 이 규칙을 따른다. 같은 출처·대상·관계가 이미 적용된 unconfirmed 해석은 세지 않는다. 검색 후보와 순위는 바꾸지 않는다.
- `trace_evidence`도 `read_evidence`처럼 허용되지 않은 중간 출처에서 추적을 멈춘다. 숨겨진 상위 출처나 그 정정은 노출하지 않는다. 출력 형식은 유지하며 저장소 읽기 실패는 `EvidenceReadFailed/StorageRead`로 반환한다.
- Graph 추적은 시작 노드가 이후 읽기로 대체된 `tool_result`여도 출처를 따라간다. 그래프 탐색·검색에서는 계속 제외한다. 대체된 읽기 결과는 `untraced` 대신 실제 출처와 변경 판정을 받는다.
- `find_memory`·`trace_evidence`도 도구 호출의 abort signal을 Effect 실행에 연결한다.

## 검색 결과의 최신 근거 포인터 (2026-10-16)

- `find_memory` 결과를 마지막 근거로 바꾸지 않는다. 각 결과에 정정/철회 사슬이 끝나는 곳(`latest`)을 덧붙이고 검색 후보와 순위는 유지한다. 정정은 자동 해석이라 결과를 바꾸면 잘못된 정정이 원문을 가리고 이력 질문에 답할 수 없기 때문이다.
- 사슬은 `isChangeAuthority`를 만족하는 applied 관계만 따라가며 순환과 깊이 6에서 멈춘다. `latest`는 `unchanged`·`changed`(끝 하나)·`branched`(끝 여럿)로 구분하고 `unconfirmedAfter`·`truncated`를 함께 표시한다.
- 한 사실은 한 시점에 값이 하나이므로 `branched`는 이상 신호로 다룬다. 잘못된 대상 연결·여러 사실을 담은 메시지·실제 모순 중 무엇인지는 원문으로만 알 수 있어 하나를 고르지 않고 각 끝에 기록 순서(`recordedRank`)를 붙인다.
- 같은 사실의 갈라짐은 해석이 정정을 사슬 끝이 아닌 원래 노드에 연결해 생길 가능성이 크다. 쓰기 시점에 대상을 사슬 끝으로 보정하는 작업은 별도로 진행한다.
- 탐색은 `memory/latest.ts`의 Effect로 작성하고 저장소 읽기는 `MemorySearch`가 `NativeMemorySearchFailed`로 변환해 주입한다.
- 근거: 12개 합성 사례 72회 실측에서 정답률 원문만 75%, latest 95.8%, 강제 1단계 후속 조회 83.3% (`docs/latest-evidence-pointer-2026-10-16.md`).

## 기록 이관의 입력 경계 강화 (2026-10-17)

- Codex `.jsonl.zst` 기록은 통째로 풀기 때문에 해제 결과를 512 MiB(`MaxDecompressedBytes`)로 제한한다. 넘으면 `TranscriptDecompressFailed`로 그 기록만 실패로 남기고 나머지 이관은 계속한다.
- 사라진 폴더를 worktree 상위 폴더로 저장소에 배치하는 규칙은, 그 상위 폴더에 그 저장소의 현재 worktree 외의 다른 폴더가 없거나 상위 폴더가 사라졌을 때만 적용한다. 무관한 폴더와 함께 쓰는 상위 폴더(`/tmp`, 공용 작업 폴더 등)에서 사라진 다른 대화가 그 저장소 프로젝트의 기억으로 섞이지 않게 하기 위해서다. 그런 대화는 기록된 remote·commit 근거로만 배치한다.

## 긴 기억 원문의 청크 임베딩 (2026-10-18)

- 사용자 결정: 긴 노드를 청크별로 임베딩하고 기존 양자화를 유지한다. CPU quint8 / GPU fp32와 turbovec 4-bit 설정은 바꾸지 않는다. 네이티브 검색의 청크 매핑에 필요한 최소 Rust 수정은 사용자가 별도로 허용했다.
- 사용자·모델 발언과 topic의 원문 전체를 tokenizer 기준 최대 512토큰(특수 토큰 포함), 최대 128토큰 겹침(특수 토큰 제외)으로 나눈다. 도구 호출·결과는 계속 임베딩하지 않는다. 질문·직접 임베딩의 2,048토큰 제한과 문서 청크 크기는 구분한다.
- tokenizer가 원문 offset을 제공하지 않아 원문 부분 문자열의 실제 토큰 수를 센다. 한 번의 토큰화 입력은 최대 4,096 UTF-16 단위로 제한하고, surrogate pair를 자르지 않는다. 이는 청크를 덜 채울 수는 있지만 원문을 버리지는 않는다. 원문 노드·정정 그래프는 그대로 두고 `node_vector_chunks`에 각 청크의 원문 UTF-16 범위를 저장한다.
- 벡터를 평균내지 않는다. 검색은 프로젝트 범위를 먼저 적용하고 원문별 최고 점수 청크를 남긴다. 한 원문의 청크가 후보를 독점하면 native 시간·후보 예산 안에서 선택한 원문의 청크를 다음 검색에서 제외하여 서로 다른 원문을 채운다. 각 native 검색은 기존 k ≤ 48 측정 범위를 지킨다. 기존 50,000 후보 제한은 이제 청크 벡터 수에도 적용되므로 긴 문서가 많으면 더 일찍 예산에 도달할 수 있다.
- `find_memory`는 원문 ID와 함께 `matchedSpan { start, end, unit: "utf16" }`을 반환하고 해당 위치의 snippet을 보여 준다. `read_evidence`에 `start`를 offset으로 전달하면 원문의 해당 부분부터 읽는다. 자동 정정 판정은 여전히 원문 노드 기준이다.
- 임베더 identity에 청크 정책 버전·크기·겹침을 포함한다. 기존 단일 벡터 캐시는 섞지 않고, 앱 시작 시 Scope에 묶인 backfill로 새 인덱스를 채운다. 기존 DB marker와 구형 캐시는 유지하며 새 원문을 만들거나 사용자 기록을 수정하지 않는다.
- publication 안에서 청크 ID를 예약하고 벡터를 저장한 다음 원문 완료 marker를 커밋한다. 저장 후 marker 커밋 전에 종료되면 재시작 때 미완료 청크만 제거한다. marker 삭제 시에는 청크 벡터 제거 ID를 별도 journal에 남겨 redaction·retirement·session purge 후에도 청크를 정리할 수 있게 한다. 임베딩 중 원문이 바뀌면 기존 재검증으로 그 결과를 버린다.
- 실제 Granite quint8 비교: 반복 문장 합성 원문(15,628 UTF-16 단위)의 마지막 배포 결정을 묻는 질문을 단독 임베딩했을 때, 정답 청크 순위는 1,024토큰에서 원벡터 3위 / 4-bit 검색 2위, 512토큰에서 모두 1위였다. 256·128토큰도 1위였으나 각각 41·83개 청크가 필요해 21개인 512토큰을 채택했다. 2·3-bit로 바꿔도 1,024토큰 사례는 1위가 되지 않아 양자화 강도는 유지한다. quint8은 배치 구성에 따라 벡터가 달라지므로 질문과 문서를 함께 임베딩한 초기 1,024토큰 실험(정답 9위)과 이 순위를 혼동하지 않는다.
- FP32 비교에서는 1,024·512·256·128토큰 모두 정답 청크가 원벡터 기준 1위였다. 따라서 이 사례에는 모델 양자화의 품질 영향도 있다. CPU 모델을 FP32로 강제 전환하지 않고 512토큰으로 조정하며, GPU의 기존 FP32 경로도 유지한다.
- 실제 모델 → 4-bit 인덱스 → `MemorySearch.find` → `read_evidence` 경로의 캐시 모델 테스트를 추가한다. `MEMORY_EMBEDDING_TEST_ROOT`로 별도 모델 캐시를 지정할 수 있다. 이 합성 사례의 1위를 모든 질문에 대한 순위 보장으로 일반화하지 않는다.
- 동시 에이전트 실행 시 모델 worker는 요청 배치 단위 Semaphore(1)로 물리 실행량을 제한한다. 전체 문서 임베딩을 잠그지 않아 backfill 배치 사이에 검색이 들어갈 수 있다. 대기 중 취소는 전송하지 않고, 실행 중 취소는 해당 worker를 종료한 뒤 종료 확인까지 기다린다. 다음 요청은 새 worker에서 실행하며 다른 에이전트의 대기를 실패시키지 않는다.
- native remove/save 동안 다른 에이전트가 만든 제거 journal을 보존한다. 제거할 journal과 live chunk ID를 하나의 동기 DB 경계에서 읽고 실제 제거·저장한 ID만 확인 처리한다.
- chunk 예약 후 native 저장 중 세션 purge·원문 변경이 가능하므로 marker commit에서도 원문을 재검증한다. 사라지거나 변경된 부모는 완료 처리하지 않고 해당 청크를 제거 journal로 회수하여 다른 에이전트의 검색 publication을 실패 상태로 만들지 않는다. 이 경쟁 구간은 Deferred gate로 재현한다.
- 리뷰 반영(2026-10-18): `Database.atomic`은 모든 fiber가 공유하는 depth로 SAVEPOINT를 중첩하므로, 트랜잭션 안에서는 재검증과 쓰기만 동기로 수행하고 Effect를 `yield`하지 않는다. 노드별 처리 결과는 서로소 유니온(`NodeOutcome`)으로 정한 뒤 `switch`로 쓴다. native await 전에 필요한 청크 ID·제거 journal은 한 트랜잭션에서 읽는다. fiber별 트랜잭션 연결을 주는 `effect/sql`의 `SqlClient.withTransaction`으로 옮기는 일은 리포 전체의 동기 SQLite 사용과 `@effect/sql-sqlite-node`의 `effect ^4.0.5` 요구 때문에 별도 작업으로 둔다.
- native owner는 명령을 하나씩 처리하므로 id별 명령을 병렬로 보내도 빨라지지 않는다. `remove`는 `add`처럼 `ids` 배열을 받는 한 owner 단계로 처리하고 제거된 개수를 돌려준다. 검색 중 매핑이 사라진 청크 ID(2^52 이상)는 원문 seq로 해석하지 않고 버린다. 검색 k 확장은 이전 결과에 의존하므로 순차로 둔다.
- turbovec `VectorIndex`에 `close`를 추가하고 native owner가 인덱스를 `ScopedRef`로 소유한다. reset 교체, 호환되지 않는 저장 인덱스 교체, worker 종료 때 GC를 기다리지 않고 바로 해제한다. 닫힌 인덱스 호출은 해제된 메모리에 닿지 않고 오류를 반환한다. native 경계의 실패는 원래 예외를 `NativeOwnerFailed.cause`로 프로세스 안에 보존하고 IPC로는 reason 코드만 보낸다.

## SQL·worker 경계의 Effect 전환 (2026-10-18)

- 사용자 결정: 청크 임베딩 리뷰 PR 위에 `effect/sql`과 `effect/workers`·`effect/rpc` 전환 PR을 하나 더 올린다. 이 PR은 기반과 임베딩 경로만 옮기고 나머지 DB 모듈은 후속 PR에서 옮긴다.
- SqlClient는 앱이 이미 연 단일 `DatabaseSync` 위에 만든다(`sqlClientOver`). 두 번째 연결을 열면 suspend된 SqlClient 트랜잭션과 동기 `BEGIN IMMEDIATE`가 이벤트 루프를 막아 교착할 수 있기 때문이다. `@effect/sql-sqlite-node`는 `effect ^4.0.5`를 요구하므로 쓰지 않는다.
- 문장·트랜잭션은 `makeSqliteAcquirers`의 연결 lease(Semaphore 1)를 잡는다. 다른 fiber의 문장은 열린 트랜잭션이 끝날 때까지 기다린다. 전환 기간의 동기 `Database.atomic`은 lease를 잡지 않으므로, 바깥 SqlClient 트랜잭션이 열려 있으면 섞지 않고 `TransactionInterleaving`으로 거부한다.
- `withTransaction` 본문은 `Scheduler.PreventSchedulerYield`로 실행한다. 스케줄러 선점으로 트랜잭션 도중 다른 fiber의 동기 `atomic`이 끼어드는 일을 줄이기 위해서다. 정확성은 위 거부 규칙이 보장한다.
- 인덱서·벡터 인덱스·검색 청크 범위 조회는 `SqlClient`와 `SqlSchema`로 옮긴다. 여러 id 조회는 1,000개 단위 `IN` 질의로 묶고, 예약·커밋·정리는 `withTransaction` 하나로 처리한다.
- 임베딩 worker와 native owner worker는 `RpcGroup` 서버로 바꾼다. host는 `RpcClient.layerProtocolWorker`(size 1, concurrency 1)로 연결하고, 벡터는 `Transferable` 스키마로 버퍼를 넘긴다. worker 종료는 RpcClient Scope가 맡아 별도 close 명령을 두지 않는다.
- 임베딩 세션은 `ScopedRef<Option<ModelSession>>`와 Semaphore(1)로 소유한다. 실행 중 취소·load 실패·transport 유실은 세션을 버리고, 다음 요청이 새 worker를 연다.
- native owner host는 요청마다 job fiber를 `FiberMap`에 두고 Semaphore(1) 슬롯과 `Ref` 원장(queued/active)으로 용량 32·중복·취소·조회를 관리한다. 대기 중 떠난 호출자는 전송 전에 제거하고, 실행 중 job은 worker 응답까지 슬롯을 유지한다. worker 종료와 치명적 reason은 남은 대기자를 모두 실패시킨다.

## 남은 DB 접근의 SqlClient 전환과 node:* 정리 (2026-10-18)

- 사용자 결정: 앞 PR을 머지한 뒤 남은 원시 SQLite·`Database.atomic` 사용처를 모두 `SqlClient`로 옮기고, Effect에 대응 API가 있는 `node:*` 모듈을 걷어 낸다.
- `Database`는 열고 마이그레이션한 연결의 `SqlClient`만 제공한다. `Database.sqlite`·`atomic`·`TransactionInterleaving`을 지우고, 동기 SQL이 lease 밖에서 끼어들 일이 없어졌으므로 `withTransaction`의 `PreventSchedulerYield` 우회도 지운다.
- 노드·그래프·해석·검색·secret sweep·가져오기·작업 추적·구독 계정 프로필을 도메인별 커밋으로 옮긴다. 거부 사유는 리터럴 reason을 가진 typed error로 오류 채널에 남긴다.
- SDK가 동기로 묻는 경계(계정 바인딩된 실행의 계정 선택, 카탈로그 키)는 `OAuthProfiles`가 소유한 커밋 스냅샷을 읽는다. 스냅샷은 쓰기와 같은 트랜잭션 안에서 다시 읽어 `Ref`에 둔다. 실행 lease는 `DatabaseSync`를 키로 한 WeakMap 대신 서비스 인스턴스가 소유한다.
- 원시 `DatabaseSync`는 다음 경계에만 남긴다: 시작 시 열기·마이그레이션, 별도 읽기 연결을 쓰는 native 검색 worker, RRSI의 읽기 전용 원본 DB(acquireRelease로 수명 관리), 마이그레이션 경계 테스트, 패키지 smoke 검사와 순수 SQLite 벤치마크 도구.
- 테스트 fixture SQL은 `tests/support/sql.ts`(`sqlAll`·`sqlGet`·`sqlRun`·`sqlExec`·`sqlTransaction`)로 SqlClient를 거친다. `TestEnv`는 `OpenSqlClient` reference로 현재 열린 agent의 연결을 가리켜 `reopen` 뒤에도 닫힌 연결에 쓰지 않는다. `env.use` 안에서는 그 agent 자신의 SqlClient를 쓴다.
- 앱이 쓰지 않는 Effect cluster 엔진이 lease 없는 어댑터로 owner 연결을 공유하던 계약 테스트와 atomic 전용 테스트는 지운다. 재시작 뒤 재생은 owner 엔진 테스트가, 0.0.13 cluster 테이블 제거는 남은 릴리즈 스키마 테스트가 맡는다.
- `node:*`는 Effect 대응 API가 있으면 쓰지 않는다(fs·path·crypto·child_process·http·url). 파일 URL 변환은 `Path.fromFileUrl`·`toFileUrl`로 옮긴다. 대응 API가 없는 `worker_threads`·`os`·`sqlite`·`sea`·`module`·`zlib`·`perf_hooks`·`util`(`parseArgs`·`isDeepStrictEqual`)은 경계에 남긴다.

## OpenAI 호환 엔드포인트의 계정화 (2026-10-18)

- OpenAI 호환 연결을 설정 하나가 아니라 계정 목록으로 관리한다. `ProviderId`의 `openai-compatible`은 연결 종류로 유지하고, 그 아래에 엔드포인트 계정을 여러 개 두며 선택 계정 하나가 새 실행에 쓰인다. 구독 공급자의 계정 목록·선택 계정과 같은 구조다. 엔드포인트마다 `ProviderId`를 만들지 않는 이유는 `ModelSelection`·DB·feature flag·공급자 간 동의가 고정된 `ProviderId`를 키로 쓰기 때문이다.
- 계정은 이름·Base URL·키체인 항목(`credentialEntry`)만 가진다. 컨텍스트 창·출력 한도·도구 호출·추론 강도 공개 정보는 모델의 속성이므로 계정 아래 등록 모델 카탈로그(`models`)에 둔다. 구독 계정이 공급자 카탈로그를 갖는 것과 같은 모양이며, 서버가 한도를 알려 주지 않으므로 모델은 사용자가 등록한다. `/models` 조회는 등록을 돕는 후보 목록과 등록 모델의 추론 강도 갱신에만 쓴다.
- 키는 계정마다 별도 키체인 항목에 서버 URL과 함께 저장한다. 키가 있는 계정의 주소를 바꾸려면 새 키 또는 명시적 삭제가 필요하고, 주소가 바뀌면 이전 서버가 공개한 추론 정보를 지운다. 계정 삭제는 키를 먼저 지운 뒤 설정을 쓴다.
- 모델 선택은 기존 전역 `provider`·`model`을 유지한다. 계정을 바꾸면 같은 모델 ID가 새 계정에 있으면 유지하고, 없으면 새 계정의 첫 모델로 바꾼다. 선택 모델을 카탈로그에서 지우면 남은 첫 모델로 옮긴다. 실행 중인 run은 시작한 계정 ID에 고정되어 도중의 계정 전환이 키를 바꾸지 않는다.
- 0.0.15까지의 `openaiCompatible` 단일 설정은 읽을 때 `default` 계정과 모델 하나로 해석하고 기존 키체인 항목(`openai-compatible-api-key`)을 그대로 쓴다. 다음 계정 쓰기에서 `compatibleAccounts`로 대체하며 키를 옮기는 별도 작업은 하지 않는다.
- `/api/accounts`가 모든 공급자의 계정 목록과 작업을 맡는다. 응답 view는 연결 종류 태그(`subscription` / `compatible-endpoint`)를 가진 유니온이고, 선택·삭제·이름 변경 intent는 공통이며 로그인(`add`·`cancel`)과 엔드포인트 연결·모델 등록·테스트·후보 조회는 연결 종류별 intent다. 기존 `/api/settings/compatible`과 설정 화면의 호환 공급자 페이지는 제거하고 계정 관리 화면에서 엔드포인트와 모델을 관리한다.

## 남은 node:* 모듈의 Effect 전환 (2026-10-18)

- 사용자 결정: 별도 패키지가 아닌 벤치마크·측정 스크립트(`tools/native-search-*`, `io-range-benchmark`, `suspense-verification`)는 지운다. 나머지 `node:*`는 Effect 추상화가 있으면 그것으로 옮긴다. 앞 절의 "대응 API가 없어 남긴다" 목록 중 `worker_threads`·`util`·`perf_hooks`·`net`·`assert`는 대응이 있어 이 결정으로 대체한다.
- 모든 worker(가져오기·redaction·샌드박스·Kiwi)는 `RpcGroup` 서버와 `NodeWorker`/`NodeWorkerRunner` RPC로 통신한다. `parentPort`·`postMessage`·요청 ID와 대기자 Map은 두지 않는다. 남는 `node:worker_threads`는 `NodeWorker.layer` 안의 `Worker` 생성자와 시작 설정 `workerData`뿐이다(`NodeWorkerRunner`에 시작 설정을 받는 API가 없다).
  - worker 종료는 Scope가 맡는다. Scope가 닫히면 `NodeWorker`가 종료를 요청하고 5초 안에 끝나지 않으면 강제로 끈다. 예전에는 바로 `terminate()`했다.
  - worker 실패는 리터럴 reason(가져오기 `start`/`count`/`pass`/`lost`, redaction `redaction-failed`/`worker-lost`)만 전달한다. 원래 오류 문장은 worker 로그에만 남고, 설정 화면은 코드에 맞는 문구를 보인다.
  - 샌드박스 worker는 `Prepare`/`Finish` 두 RPC다. `SandboxManager.reset`은 worker Scope의 finalizer로 옮겨 정상 종료와 중단 모두에서 정리된다.
  - Kiwi 세션은 임베딩처럼 `ScopedRef`가 소유하고, 모델 빌드에 실패한 worker는 다음 요청에서 새로 띄운다.
- Goal 워커의 역방향 owner RPC는 Effect worker 프로토콜에 MessagePort 플랫폼 어댑터(`effect-rpc-message-port.ts`)를 끼워 쓴다. 원장·권한 검사(`makeOwnerRpcEffect`)는 그대로다. 포트가 닫힌 뒤 들어온 요청은 바로 실패하지 않고 프로토콜 재연결 주기(1초) 안에 실패한다. 서버 layer는 포트 Scope가 소유한 fiber에서 빌드한다.
- worker 파일은 `@effect/platform-node` 진입점 대신 쓰는 하위 모듈만 불러온다. 진입점은 `NodeRedis`까지 평가해 시작이 느려지고, `redis`가 없는 실행 파일의 runtime 폴더에서는 Kiwi·임베딩 worker가 시작하지 못했다.
- 실행 파일은 모든 worker를 한 파일(`.mjs`)로 묶는다. Kiwi·임베딩 worker는 자기 모듈만 묶고 모델 패키지는 runtime 폴더의 `node_modules`에서 쓴다. 원본 `.ts`를 복사하던 때는 옆 모듈의 상대 import가 실행 파일 안에서 풀리지 않았다.
- `ScopedRef.set`은 새 값을 interruption 없이 얻으므로, worker 세션(임베딩·Kiwi·가져오기)은 획득만 `Effect.interruptible`로 연다. 그러지 않으면 모델 로드 중에 받은 SIGTERM이 로드가 끝날 때까지 서버 종료를 막는다. 앞 PR부터 있던 문제로, 실행 파일에서는 임베딩 worker가 시작하지 못해 가려져 있었다.
- CLI 인자는 `effect/cli`로 파싱한다. 내장 전역 플래그는 끄고(`CliConfig.builtIns: []`) 기존 옵션 이름·사용법 문구를 유지한다. `isDeepStrictEqual`은 `Equal.equals`로, 포트 점유 확인은 `NodeSocketServer`의 scoped bind로, 측정 시간은 `Clock`·`Effect.timed`로, 테스트 단언은 vitest `expect`로 바꾼다.
- 홈 폴더·임시 폴더·전체 메모리는 Effect에 대응 서비스가 없어 `runtime/host-system.ts`만 `node:os`를 쓰고 나머지는 그 Effect 값을 읽는다.
- 남기는 `node:*`와 이유: `sqlite`(Effect의 SQLite 드라이버는 별도 네이티브 패키지라 SEA 제약과 맞지 않아 자체 `SqlClient`가 `node:sqlite`를 감싼다), `sea`(실행 파일 자산), `module`(`createRequire`: SEA 본문은 네이티브 패키지를 require로만 부른다), `zlib`(설치본에는 HTTP 응답 압축만 있고 zstd 해제가 없다), 테스트의 `async_hooks`·모듈 로더 hook의 `url`(Effect 런타임 밖에서 동기로 돈다).

## 개발용 관측과 프로파일링 도구 (2026-10-18)

- 사용자 결정: 기본 관측 경로는 OTLP, Effect devtools는 개발용 보조 경로로 둔다. clinic.js처럼 사람이 보는 HTML 대신 에이전트도 읽을 수 있는 텍스트 요약을 만든다.
- `@effect/opentelemetry`는 쓰지 않는다. 설치본 `effect/observability`의 `OtlpTracer`·`OtlpMetrics`를 `layerFromConfig`로 쓰고, 기존 OpenTelemetry SDK가 없으므로 Effect 문서가 권하는 내장 경로를 택한다.
- 에이전트 런타임(`apps/agent/app/.server/agent.ts`) 최하단에 관측 Layer를 둔다. 표준 `OTEL_*` 변수가 없으면 아무것도 내보내지 않는다. 로그는 프롬프트와 공급자 응답을 담을 수 있어 OTLP로 내보내지 않는다. `CONTEXT_AGENT_DEVTOOLS_URL`이 있으면 devtools tracer가 OTLP tracer를 감싼다.
- `tools/profile/main.ts`가 OTLP·devtools 수집기와 요약기를 맡는다. 두 수집기는 같은 span NDJSON을 쓰고, span 속성은 숫자·불리언만 남긴다. CPU는 Node의 `--cpu-prof` 결과(`.cpuprofile`)를 같은 요약기로 읽는다.
- worker 내부 span은 이번 범위에서 내보내지 않는다. worker CPU는 `--cpu-prof`가 thread별 파일로 남긴다.
- 사용자 결정: 메모리 도구는 고친다. `MemoryTools.forRun`은 Effect가 되어 호출한 실행의 context를 잡고, 도구 Effect는 그 위에 서비스를 덮어 돈다(`MemoryToolEnvironment.caller`). 그래서 도구 span이 run span과 같은 trace에 붙는다. `forProject`는 Layer를 만들 때의 context를 쓴다. BTW도 질문을 처리하는 `BtwChat.handle`의 context를 넘긴다. Goal native owner 경로도 같은 실행 안에서 따로 빌드한 `createMemoryTools`를 부를 뿐이고, 아티팩트가 `effect`를 번들하지 않아 호스트 런타임을 공유하므로 실행 context를 넘긴다.
- 사용자 요청: delegate(`DelegateTools.forRun`)·workflow(`WorkflowTools.forSession`) 도구도 실행 context를 `caller`로 받아 run trace에 붙인다. 서비스는 Layer를 만들 때의 것을 위에 덮어 그대로 쓰고, tracer와 부모 span만 실행에서 온다.
- 사용자 결정 (2026-10-19): 실행 context는 인자로 넘기지 않고 요구 타입으로 주입한다. run 도구 팩토리(파일·outside·approved·MCP·스킬·Kagi·delegate·workflow·백그라운드·그림 미리보기·메모리 `forRun`)는 `Effect<도구, E, Tracer.ParentSpan>`을 돌려주고, 안에서 `runTrace`(`Context.Context<Tracer.ParentSpan>`)를 읽는다. span 밖에서 도구를 만들면 컴파일되지 않는다. `Effect.fn`으로 감싼 팩토리는 자기 span이 시작되기 전에 읽어, 도구가 팩토리 span이 아니라 run span 아래에 붙게 한다.
- 이 타입으로 `AgentChat.handle`에 span이 없어 채팅 도구가 붙을 run span이 없었던 것을 찾았다. `AgentChat.handle`·`CardAgent.run`·`CardAgent.verify`에 span을 달았다. `Effect.fn`의 타입은 `ParentSpan` 요구를 지우지 않으므로 `BtwChat.handle`은 `fnUntraced`에 `Effect.withSpan`을 붙인다.
- 절차는 `.agents/skills/effect-profile` 스킬에 둔다.

## 저장소 전체 Effect 오류의 typed error 정리 (2026-10-18)

- 사용자 요청: Effect 로직 전체에서 실패가 typed error로 드러나게 한다. 칸반 정리와 같은 기준을 칸반 밖 코드(`packages/memory-agent/src` 전체, `apps/agent/app`)에 적용했다.
- 예상 실패는 `Data.TaggedError` 대신 `Schema.TaggedError`와 리터럴 reason으로 정의한다. `orDie`·`Effect.die`는 실제로 도달할 수 없는 불변식과, 오류 채널이 `never`인 상위 인터페이스(`effect/workflow`의 `WorkflowEngine`) 경계에만 남긴다.
- 실패를 기록하고 끝내는 공용 헬퍼는 `runtime/logged-failures.ts` 한 모듈에 둔다(`stopLogged`·`fallbackLogged`·`logFailure`·`ignoreLogged`·`failureTags`). 로그에는 오류 태그와 reason 태그만 남기고, 원문 메시지·경로·명령 출력·공급자 본문은 남기지 않는다. 결함은 `Defect`로 표시하고, interruption은 그대로 통과시킨다.
- 정리 작업의 실패가 원래 실패를 덮어쓰지 않게 한다. finalizer 안의 best-effort 정리(worker 종료, 임시 파일·snapshot 삭제, SDK iterator close, MCP shutdown)는 실패해도 결함으로 만들지 않고 태그만 로그한다.
- 결함과 interruption을 typed 실패로 바꾸던 `catchCause`는 `catchTag`·`catchReason`으로 좁힌다. 결함은 결함으로 전파한다. 예외로 `catchCause`를 남기는 곳은 다음과 같다. 사용자가 대기·승인을 중단한 제품 취소 기록, 권한 분류의 fail-closed 처리, 경로·비밀이 모델로 새지 않게 막는 SDK 도구 경계의 redaction, 담당 모듈이 원문 없이 결함을 고정 코드로 정규화하는 경계(worker 실패의 `RUN_ERROR`, owner RPC ledger의 `uncertain` 정산).
- route는 오류 태그·reason을 HTTP 상태와 안전한 코드로 바꾸는 표(`.server/kanban-failures.ts`, `.server/account-failures.ts`)를 거친다. 표에 없는 오류가 오류 채널에 있으면 컴파일되지 않는다. route에서 난 결함은 `answerDefect`로 500 `internal_error`를 응답하고 원문은 싣지 않는다.
- 브라우저는 `refusalOf`로 `ApiError`만 골라 코드별 문구를 보이고, 그 밖의 실패에는 고정 문구를 보인다. 저장된 가져오기 실패·GPU 확인·RRSI·sandbox 설정 실패 사유는 알려진 코드에만 문구를 붙이고, 모르는 값(옛 원문 포함)은 일반 문구로 보인다.
- 사용자 결정을 기다리는 동작은 이번 정리에서 바꾸지 않았다. 결함 뒤에도 계속 도는 루프(가져오기 감시, transcript pass, lease 갱신, 승인 중계), 외부 에이전트·MCP·ACP·채팅 스트림의 원문 오류 표시, 모델이 받는 읽기 도구 오류 원문, 채팅 스트림 종료 시 큐 정리 실패의 `orDie`가 여기에 해당한다.

## 원문 오류 표시와 백그라운드 루프 실패 정책 (2026-10-18)

- 사용자 결정: 외부 에이전트·MCP·ACP·채팅·BTW 스트림의 오류는 `{ code, detail }`로 다룬다. 화면에는 코드 문구를 보이고, 원문은 기본으로 접힌 "자세히"에서 보인다. `detail`은 `SecretRedactor.shownDetail`을 거친다(1000자로 자르고, 가리기에 실패하면 `null`). 코드 문구 표는 `externalAgentFailureText`·`runFailureText`에 둔다. 모르는 코드와 옛 기록은 `run_failed` 일반 문구로 보인다. ACP editor 오류는 message에 코드 문구를, data에 `{ code, detail }`을 담는다.
- 사용자 결정: 모델이 받는 도구 실패는 `{ error, cause, detail }`이다(`detail`은 redaction된 원문). 모델이 경로 등을 고쳐 재시도할 수 있게 원문을 유지한다. `@tanstack/ai@0.61.0`은 도구 throw를 `{ error: message }`로 고정하므로, catch에서 심볼 속성의 구조화 결과를 쓰게 하는 pnpm patch(`patches/@tanstack__ai@0.61.0.patch`)를 둔다. `@tanstack/ai`를 올리면 이 패치를 다시 만든다. `delegate_to_agent` 결과의 `error`/`reason` 문자열은 `failure: { code, detail }`로 바뀐다.
- 사용자 결정: 백그라운드 루프는 실패 종류로 나눈다. 예상 실패(공급자·git·네트워크·DB 등)는 10초부터 지수 backoff로 최대 5회 재시도하고 간격 상한은 5분이다. 소진하면 그 루프만 멈춘다. 결함은 재시도 없이 멈춘다. 상태는 `LoopHealth`(Healthy·Retrying n/5·Exhausted·Defected)로 서버 메모리가 소유하고, 화면에 다시 시작 버튼을 둔다. 앱을 재기동하면 정상 상태로 시작한다.
  - 칸반: 카드 통합·merge 단계가 소진되거나 결함이 나면 그 보드 루프 전체가 멈춘다. 다시 시작하면 다음 look이 그 단계를 다시 실행한다. 카드 단위 실패 사다리(retry_backoff → blocked → dead-letter)는 그대로다.
  - 가져오기: 감시 상태는 `overview.watch`, 다시 시작은 `restart_watch`다. transcript pass는 typed 실패만 항목 실패로 기록하고, 결함이 나면 pass를 멈춘다.
  - ACP lease 갱신·승인 중계는 소진·결함 시 그 루프만 멈추고 태그만 로그한다(별도 프로세스라 Discord 보고는 하지 않는다). 갱신이 멈추면 90초 뒤 lease가 만료되어 앱이 읽기 전용이 되고, 중계가 멈추면 승인은 앱 화면에서 답한다. 브라우저 lease 갱신도 같은 schedule로 재시도하고, 소진하면 기존 관찰·claim 경로로 돌아간다.
- 사용자 결정: 결함은 Discord webhook으로 보고한다(Sentry 대용). `DISCORD_WEBHOOK_URL`을 재사용하고, GlobalConfig `defectReports`(기본 켜짐, webhook이 없으면 무시)와 `/report` 체크박스로 끈다. 메시지는 `[결함] 태그 @ 위치(span) ×n`에 버전·플랫폼·sessionId/goalInstanceId의 SHA-256 앞 12자·redaction된 요약 300자·스택 5줄을 붙인다. fingerprint(태그@위치)당 10분에 1회, 전체 분당 5회로 제한하고, dropping Queue(64)와 동시 2개로 보낸다. 전송 실패는 `defect_report_failed` 태그만 로그한다. 결함 기록은 `logDefect` 한 경로로 모은다(루프·`answerDefect`·finalizer).
- 채팅 응답 스트림이 끝날 때의 큐 정리(`settleQueue`)가 실패하면 그 세션의 대기 메시지를 모두 보류(`holdWaiting(stopped)`)해 사용자 확인 없이 다음 턴으로 보내지 않는다. 보류도 실패하면 결함으로 보고한다. 스트림은 정상 종료한다.

## 제보의 자동 증거 묶음과 진단 초안 (2026-10-19)

- 사용자 결정: 제보를 받는 개발자는 사용자의 로컬 DB·세션에 접근할 수 없으므로, 제보 하나로 원인을 찾을 수 있게 근거를 자동으로 묶어 보낸다. 증거를 하나씩 고르던 선택 UI와 항목별 편집, 항목 상세 조회(8,000자) 엔드포인트는 없앤다. 사용자는 진단·초안(편집 가능)과 보낼 묶음 전체(읽기 전용, 접힌 섹션)를 확인하고, 직접 눌러야만 보낸다.
- 묶음은 환경(버전·플랫폼·공급자/모델 종류·칸반·MCP·외부 에이전트 상태), 연동·루프 상태, 최근 결함, 세션 타임라인(run·대화 발췌·도구 호출·승인·Work Trace·칸반 카드의 failure_streak·replans·reason)이다. 상한은 run 30개, run당 이벤트 60개, 원문 1,500자(실패 결과·run 오류는 6,000자), 결함 20개, run 없는 항목 20개다. 잘림은 묶음에 표시한다. 모든 원문은 SecretRedactor를 거친다.
- 로컬 ID는 SHA-256 앞 12자로만 남기고, 관계는 순번(`run-N`, `run-N/call-M`)으로 표현한다.
- 진단은 페이지를 열 때 자동으로 돌리지 않고 버튼 한 번으로 실행한다(모델 비용, 사용자가 증상을 쓴 뒤 실행). 진단 입력은 서버가 묶음에서 만든다. 환경 3,000자, 타임라인 개요 8,000자(최신 우선), 실패 run 최대 10개×3,000자이며, 응답에 `summary`를 더한다.
- 전송은 Discord webhook 메시지 본문에 초안을, 첨부 `context-agent-evidence.json`에 묶음을 담는다(상한 4,000,000바이트, 비부스트 서버 10MiB 이내). 중복 판정 해시는 초안과 묶음을 함께 본다. 복사·파일 저장도 같은 묶음을 쓴다. `DefectReporter.recent`는 webhook이 없어도 최근 결함을 기억해 묶음에 넣는다.
- 설정 화면의 MCP 서버·외부 에이전트 명령줄과 URL은 서버에서 `shownDetail`로 가려 응답한다(`target: string | null`). 설정 파일 자체는 바꾸지 않는다.

## compatible 메인 채팅 tool 노출과 모델 턴 진단 로그 (2026-10-20)

- 메인 채팅과 btw가 compatible 모델에 tool을 줄지는 선택된 endpoint 계정에 등록된 그 모델의 `toolCalling`으로만 정한다(`compatibleToolCalling`). 계정 도입 전 단일 `openaiCompatible` 설정은 `compatibleAccountsOf`가 읽어 같은 판단에 들어간다. 메인 채팅이 레거시 `openaiCompatible.toolCalling`만 읽어, 계정으로 저장된 설정(레거시 키를 지움)에서는 tool이 항상 빠지고 모델이 "확인하겠습니다"만 내고 멈췄다.
- compatible 어댑터는 provider 턴이 끝날 때(`RUN_FINISHED`) `Compatible model turn finished` 로그에 SDK run ID, `finishReason`, 보낸 tool 정의 수, 받은 tool call 수만 남긴다. 프롬프트·응답 본문·모델 ID·endpoint·키는 남기지 않는다. 진단용 임시 로그가 아니라 유지한다.

## Docker로 Linux 실행 파일 빌드와 실행 (2026-10-20)

- `apps/agent/Dockerfile`은 `pnpm build`(`vp run package`)가 만드는 실행 파일을 Linux에서 빌드하고, 그 실행 파일을 컨테이너에서 실행한다. 빌드 컨텍스트는 저장소 루트다.
  - `pnpm build:docker`: linux/amd64와 linux/arm64 실행 파일을 함께 만들어 `apps/agent/dist/docker/context-agent-linux-<arch>/`에 둔다.
  - `pnpm start:docker`: 이 머신용 이미지를 만들고 `http://localhost:5173`으로 실행한다. 저장 루트는 `context-agent-data` 볼륨(`/data`), 프로젝트 폴더는 `/workspace`다.
- 아키텍처에 묶이지 않게 플랫폼마다 따로 빌드한다(다른 아키텍처는 에뮬레이션). 실행 파일에는 대상 플랫폼의 Node와 네이티브 addon(turbovec, onnxruntime 등)이 들어가므로 `$BUILDPLATFORM`에서 교차 컴파일하지 않는다. Docker로는 Linux만 만든다. macOS와 Windows는 각 머신에서 `pnpm build`로 만든다.
- 빌드 단계는 Vite+ Docker 가이드를 따라 `ghcr.io/voidzero-dev/vite-plus`(로컬 vite-plus와 같은 버전)를 쓰고, turbovec용 Rust 1.99.0만 더한다. Node는 `vp`가 `.node-version`에서 받는다. 설치는 `--ignore-scripts`로 한다. prepare 스크립트는 git hook과 lint 도구만 바꾸고 빌드에는 쓰이지 않는다.
- 실행 단계는 Vite+ 가이드가 권장하는 glibc 기반 `debian:bookworm-slim`에 `libatomic1`을 더한다. Alpine(`gcompat`)은 실행 파일이 `fcntl64`, `__res_init` 심볼을 찾지 못해 시작하지 못했고, `onnxruntime-node`에 musl 바이너리가 없어 musl 빌드도 할 수 없다. distroless(`cc-debian12`)는 `libatomic.so.1`이 없다. amd64와 arm64 컨테이너 모두 HTTP 200과 루프백이 아닌 Host의 403을 확인했다.
- 빌드 단계의 Rust는 이미지의 비루트 `vp` 사용자 소유로 복사한다. cargo가 `/usr/local/cargo`에 git과 레지스트리 캐시를 쓴다.
- 서버의 루프백 전용 정책(위 "배포: 실행 파일")은 바꾸지 않는다. 컨테이너 안에서 `socat`이 `0.0.0.0:8080`을 `127.0.0.1:5173`으로 넘기고, 호스트에는 `-p 127.0.0.1:5173:8080`처럼 루프백에만 publish한다. 브라우저의 Host는 `localhost`라 기존 Host 검사를 통과하고, 루프백이 아닌 Host는 컨테이너에서도 403이다.
- `--broadcast` 플래그를 둔다. 서버를 `0.0.0.0`에 열고 Host 검사를 하지 않는다. 네트워크에서 이미 닿는 서버라 DNS rebinding 방어의 의미가 없기 때문이다. 교차 사이트 검사(`rejectCrossSite`)는 그대로다. 인증이 없으므로 실행 시 stderr로 경고하고, 기본값은 루프백 그대로다. 컨테이너에서는 `docker run -p 5173:5173 … --broadcast`로 앱 포트를 직접 publish한다.
- 비밀값(API 키, OAuth 토큰, Kagi 키)의 저장소는 `CONTEXT_AGENT_SECRET_DIRECTORY`로 고른다. 없으면 지금처럼 OS 키체인이고, 있으면 그 폴더에 entry마다 AES-256-GCM으로 암호화한 파일 하나를 둔다(`memory-agent/src/runtime/keyring.ts`). 컨테이너에는 OS 키체인(Secret Service)이 없어 키체인 저장이 `keychain_failed`로 실패했고, 컨테이너 안 `gnome-keyring`과 D-Bus도 기본 keyring을 만들지 못했다.
  - 파일 저장소는 명시적으로만 켠다. 키체인이 실패했다고 파일로 바꾸지 않고, 파일 저장소가 실패해도 키체인으로 바꾸지 않는다(R14). Docker 이미지는 `CONTEXT_AGENT_SECRET_DIRECTORY=/data/secrets`로 켠다.
  - 암호화 키는 볼륨 밖에서 받는다. `CONTEXT_AGENT_SECRET_KEY`(Base64 32바이트, `openssl rand -base64 32`) 또는 Docker secret 파일 경로인 `CONTEXT_AGENT_SECRET_KEY_FILE`이다. 키가 없으면 저장과 읽기가 `SecretFileStoreFailed`(`key_missing`)로 실패한다. 키를 잃으면 저장된 값을 읽을 수 없다.
  - 파일 이름은 `sha256(service + "\n" + account)`이고, 같은 문자열을 AAD로 써서 다른 entry로 복사한 파일은 복호화되지 않는다. 쓰기는 임시 파일과 rename으로 하며 권한은 폴더 0700, 파일 0600이다.
  - 세 키체인 사용처(`SecretStore`, OpenAI 호환 계정 키, OAuth 자격증명)는 모두 `openKeyringEntry`로 entry를 연다. 컨테이너에서 Kagi 키 저장, 재시작 후 유지, 키 없는 실행의 실패를 확인했다.
- 저장 루트 잠금(`backend.lock`)에 소유 프로세스의 시작 시각(`performance.timeOrigin`)을 함께 남긴다. 기록의 pid가 현재 프로세스와 같아도 시작 시각이 다르면 이전 실행이 남긴 것으로 보고 지운다. 강제 종료된 컨테이너를 같은 볼륨으로 다시 띄우면 진입점이 매번 같은 pid를 받아, 살아 있는 소유자로 오인하고 시작하지 못했다. 같은 프로세스 안의 두 번째 잠금은 여전히 거부한다.
- 이전 `apps/agent/Dockerfile`은 React Router 템플릿(npm, `package-lock.json`)의 잔재라 현재 저장소에서 빌드되지 않았다. 이 파일로 교체하고, `apps/agent/.dockerignore`는 루트 컨텍스트용 `Dockerfile.dockerignore`로 바꾼다.
