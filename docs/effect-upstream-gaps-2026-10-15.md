# PR #10: Effect·tsgo upstream 조사 (2026-10-15)

설치본은 Effect 4.0.3의 커밋 `844a77b18c03b4faa386cf04bf94908d3d37abc7`, `@effect/tsgo` 0.48.1이다. npm registry에서 확인한 최신 stable/staging은 Effect·platform-node·platform-node-shared 4.0.5, tsgo 0.53.0이다. beta는 4.0.0-beta.107, rc는 4.0.0-rc.118로 stable보다 오래됐다. 이번 조사는 의존성을 변경하지 않았다.

확인 범위는 beta.107·rc.118·4.0.5 배포 소스, Effect main `1e7909beb05bc740dbd330509e60bb185d7eeed1`, tsgo main `4bebbce4e832001e9c098dfd83cca511039bf99e` 및 공개 이슈·PR이다. 최신 버전으로 전체 저장소를 재검사한 결과는 아니다.

## 남은 경고와 지원 상태

PR #10의 경고는 고유 위치 기준 17개다. 15개는 `nodeBuiltinImport`, 2개는 Workflow encoded API의 넓은 오류·환경 타입이다.

| 항목                                  | 확인 결과                                                                                                                                                                                                          | 처리 방향                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `nodeBuiltinImport`                   | 최신 tsgo도 모듈 경로를 기준으로 진단한다. 사용 심볼이나 대체 API의 계약까지 비교하지 않는다. `node:http`의 `createServer`에도 HttpClient를 권하지만 공식 NodeHttpServer layer는 `Http.Server` 생성 함수를 받는다. | 공식 서버 생성 예제를 재현으로 삼아 진단 정밀도를 upstream에서 개선하는 것이 적합하다.                      |
| `FileSystem.lstat`                    | beta·rc·stable·main에 없음. 이슈 #6332와 PR #6428은 열려 있으며 미병합 상태다.                                                                                                                                     | 기존 PR 추적. 배포된 기능으로 취급하지 않는다.                                                              |
| `noFollow`·positional read            | PR #8900이 10월 8일 병합됐고 설치본에도 포함되어 있다. POSIX 경계는 이미 전환했다. Windows·Deno의 미지원 계약은 남는다.                                                                                            | 현재 fallback을 단순 삭제하지 않는다.                                                                       |
| 디렉터리 스트리밍·동기 파일 경계·glob | `readDirectory`는 배열 반환이며 `opendir` 스트리밍, 필요한 동기 검사 API, `Path.matchesGlob`를 찾지 못했다.                                                                                                        | 배열 전체 로딩이나 비동기 검사로 바꿔 자원·안전성 계약을 약화하지 않는다.                                   |
| 증분 해시                             | 현재 Crypto는 전체 Uint8Array digest를 제공한다. 확장 PR #8749는 병합 후 같은 날 #9077로 되돌려졌다. 해당 확장이 streaming hash까지 제공했는지는 확인하지 않았다.                                                  | 해시 확장이 배포됐다고 전제하지 않는다.                                                                     |
| 프로세스 경계                         | `windowsVerbatimArguments`, 필요한 raw 종료 signal·동기 종료·escaped pipe 계약이 여전히 부족하다. #9015는 이미 종료된 프로세스의 불필요한 taskkill을 고친 것으로 별개다.                                           | 기존 취소·종료 계약 유지.                                                                                   |
| Workflow encoded                      | `Encoded.register`의 callback은 `Effect<unknown, unknown, ...>`, `Activity.Any.executeEncoded`는 `Effect<any, any, any>`다.                                                                                        | 근거 없는 타입 단언이나 오류 변환으로 경고를 없애지 않는다. schema를 보존하는 encoded 경계 개선이 필요하다. |

`opendir`, `matchesGlob`, directory streaming, Workflow encoded 관련 검색에서 직접 맞는 해결 PR을 찾지 못했다. 이는 관련 이슈가 전혀 없다는 뜻은 아니다.

## 권고

최신 stable 업그레이드는 별도 호환성 작업으로 다룬다. 4.0.5의 `File.Info` 일부 필드는 bigint로 바뀌었고, 최신 tsgo는 추가 진단도 도입했다. 버전만 바꾸면 위 17개 경고가 사라진다고 볼 근거는 없다. 우선순위는 builtin 진단 정밀도, 기존 lstat PR, 필요한 플랫폼 기능의 좁은 보완이다. 경고도 실패로 유지하며 이번에는 패치·억제·upstream 이슈 게시를 하지 않았다.

## 근거

- [Effect npm registry](https://registry.npmjs.org/effect), [tsgo npm registry](https://registry.npmjs.org/@effect%2Ftsgo), [Effect 4.0.5 릴리스](https://github.com/Effect-TS/effect/releases/tag/effect@4.0.5)
- [tsgo builtin 규칙](https://github.com/Effect-TS/tsgo/blob/4bebbce4e832001e9c098dfd83cca511039bf99e/internal/rules/node_builtin_import.go), [tsgo 변경 기록](https://github.com/Effect-TS/tsgo/blob/4bebbce4e832001e9c098dfd83cca511039bf99e/_packages/tsgo/CHANGELOG.md)
- [NodeHttpServer](https://github.com/Effect-TS/effect/blob/1e7909beb05bc740dbd330509e60bb185d7eeed1/packages/platform/node/src/NodeHttpServer.ts#L479)
- [lstat 이슈 #6332](https://github.com/Effect-TS/effect/issues/6332), [lstat PR #6428](https://github.com/Effect-TS/effect/pull/6428), [noFollow PR #8900](https://github.com/Effect-TS/effect/pull/8900)
- [FileSystem](https://github.com/Effect-TS/effect/blob/1e7909beb05bc740dbd330509e60bb185d7eeed1/packages/effect/src/FileSystem.ts), [Path](https://github.com/Effect-TS/effect/blob/1e7909beb05bc740dbd330509e60bb185d7eeed1/packages/effect/src/Path.ts)
- [Crypto 확장 #8749](https://github.com/Effect-TS/effect/pull/8749), [되돌림 #9077](https://github.com/Effect-TS/effect/pull/9077), [taskkill 수정 #9015](https://github.com/Effect-TS/effect/pull/9015)
- [WorkflowEngine encoded](https://github.com/Effect-TS/effect/blob/1e7909beb05bc740dbd330509e60bb185d7eeed1/packages/effect/src/workflow/WorkflowEngine.ts#L414), [Activity](https://github.com/Effect-TS/effect/blob/1e7909beb05bc740dbd330509e60bb185d7eeed1/packages/effect/src/workflow/Activity.ts#L100)
