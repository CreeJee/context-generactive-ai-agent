# main 타입 검사 정리 (2026-10-15)

기준은 `origin/main`의 `183a6f6`이다. 일반 TypeScript 오류 1개와 Effect error 7개를
수정했다. 경고의 severity와 종료 코드 정책은 바꾸지 않았다. 사용자가 최종 선택한 범위는
설치본의 지원 API로 전환하고, 동등한 API가 없는 경고는 남겨 보고하는 것이다.

## 수정

- 공개 definitions에서 `ProviderRetryView`를 재수출해 앱의 추론 타입이 공개 경로로 표현되게 했다.
- Effect 테스트의 JSON 인코딩·디코딩은 Schema로, AbortSignal 수명은 Effect와 Scope로 관리한다.
- 화면 시간은 DateTime으로 처리하고 다중 인자 공개 함수에 `Function.dual` overload를 제공한다.
- Schema 오류 생성자는 `.make`를 쓰고 문자열 조건은 길이를 명시한다.
- 모델 재시도 대기의 오류 채널은 실제 `ProviderRetries.wait` 타입을 보존한다. 저장소·admission
  실패를 취소로 바꾸거나 원시 오류를 로그에 출력하던 catch를 제거했다.
- uncertain run 조회는 Schema의 Effect decoder를 사용한다. 승인은 동기 SQLite transaction 안에서
  Result decoder로 검증한 뒤 쓰고, 밖에서 Effect 오류 채널로 전달한다. 검증·조회·쓰기 실패를
  성공이나 임의 기본값으로 바꾸지 않는다.

## 남은 경고

설치본은 Effect commit `844a77b18c03b4faa386cf04bf94908d3d37abc7`, tsgo `0.48.1`이다.
고유 위치 17개(여러 tsconfig의 중복을 포함한 출력 18회), error 0개로 `vp run typecheck`는
여전히 exit 1이다. 아래 항목은 억제하거나 더 좁은 타입으로 단언하지 않았다.

| 경계                  | 위치                                                                                                                                        | 유지 이유                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 증분 해시             | `apps/agent/scripts/package.ts`                                                                                                             | `Crypto.digest`는 전체 입력을 요구한다. 크기 상한 없는 manifest의 증분 해시를 대체하지 못한다.                                                                                                                            |
| HTTP 생성             | `apps/agent/server/serve.ts`, `src/oauth/validation-harness.ts`                                                                             | NodeHttpServer의 운영용 make/layer도 Node server factory를 인자로 요구한다. OAuth listener는 이미 NodeHttpServer를 사용한다.                                                                                              |
| 동기 검증             | `src/agent/{goal-worker-assets,native-artifact-loader,owner-native-files}.ts`, `src/files/paths.ts`, `tests/fixtures/native-test-loader.ts` | 설치된 FileSystem에는 동기 read/realPath/lstat API가 없다. 검증과 모듈 로드 사이의 동기 경계를 유지한다.                                                                                                                  |
| 디렉터리·glob         | `src/files/listing.ts`의 fs/path import                                                                                                     | FileSystem에는 opendir 스트림과 lstat이 없고 Path에는 POSIX matchesGlob이 없다. 전체 배열 읽기는 기존 walkLimit의 메모리 상한을 깨뜨린다.                                                                                 |
| 파일 I/O              | `src/files/text.ts`의 두 fs import, `tests/io-range.test.ts`                                                                                | Windows noFollow 대체 검사, 명시적 close 실패와 native descriptor 검사에 대응하는 계약이 없다. POSIX 읽기는 이미 FileSystem.open(noFollow)을 사용한다.                                                                    |
| 프로세스              | `src/runtime/host.ts`, `src/shell/run.ts`                                                                                                   | 동기 exit 안전망, Windows verbatim 인자, 종료 신호 이름 및 빠져나간 자식의 pipe abandonment를 함께 제공하지 않는다.                                                                                                       |
| Workflow encoded 계약 | `src/workflow/owner-workflow-engine.ts`의 두 호출                                                                                           | 설치본 WorkflowEngine.Encoded.register의 오류는 unknown, Activity.Any.executeEncoded는 any 채널이다. 원인을 wrapping하면 finalizer/compensation에 보이는 cause가 달라지고 요구 서비스를 임의로 축소하면 거짓 타입이 된다. |

`src/`와 `tests/`는 별도 표시가 없으면 `packages/memory-agent/` 아래다.
기존 조사와 동작 계약은 [EFX11–12 검증 기록](efx11-12-verification.md)에도 남아 있다.

## 검증

- `vp check`: 오류·경고 0.
- 관련 backend 테스트: 5개 파일, 69개 통과.
- 변경한 frontend transport 테스트: 1개 파일, 11개 통과.
- memory-agent 전체: worker 산출물 재빌드 후 197개 파일, 1260개 통과, 2개 skip.
  재빌드 전 실행은 workflow timeout 3개가 발생해 중단했으며 통과로 계산하지 않았다.
- `vp run memory-agent#build`, `vp run agent#build`: 통과.
- strict typecheck: error 0, 남은 warning 17곳 때문에 실패 유지.
