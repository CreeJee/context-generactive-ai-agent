# 도구 결과·파일 범위 I/O (2026-10-10)

## 확인한 원인과 범위

사용자가 보고한 특정 호출 ID가 없어 실제 지연 전체를 하나의 원인으로 확정하지 않는다. `memory/record.ts:onToolPhaseComplete`가 완료된 결과를 먼저 redaction하고 `Nodes.append`로 SQLite에 저장한다. `agent/compaction.ts`는 이 저장된 ID를 붙인 요약을 만든다. `tools/memory.ts:read_tool_result`는 이미 저장된 ID를 조회하며 도구 실행·백그라운드 완료를 기다리는 경로가 아니다. 모델·스케줄링·redaction·최초 저장 시간은 아래 I/O 측정에 포함하지 않는다.

기존 `read_tool_result`는 `nodes.get`의 권한 확인과 `nodes.read`에서 각각 `SELECT *`로 원문을 전송·디코딩한 뒤 4,000 UTF-16 코드 단위로 slice했다. 새 경로는 SQL에 권한 조건을 포함하고 최대 두 개의 64 KiB UTF-8 블록만 JavaScript로 전송한다. 새 결과는 이미 확보한 원문에서 저장 시 체크포인트를 만든다. 재시작·캐시 탈락으로 인덱스가 없는 결과는 전체 길이를 알아야 하므로 최초에 순차 스캔한다. SQLite `substr(CAST(text AS BLOB), ...)`는 내부적으로 전체 레코드를 로딩·복사할 수 있다. 이 변경은 DB의 물리 디스크 I/O가 완전한 부분 읽기가 되었다는 주장이 아니다.

프로젝트 파일은 기존에도 전체 텍스트와 줄 배열 8개를 캐시했다. 외부 파일은 페이지마다 전체 읽기·해시·줄 분할을 반복했다. 이제 두 경로 모두 최대 64 KiB씩 최초 검증·해시하고 `Uint32Array` 줄 바이트 인덱스만 캐시한다. 이후 페이지는 최대 64,004 바이트의 실제 positional read로 읽는다. dev/inode/size/ctimeNs/mtimeNs를 확인하고 같은 핸들의 변경도 거부한다. 외부 접근 제한과 프로젝트 링크 제한을 유지한다.

일반 줄 검색은 검증한 파일의 범위 페이지를 순차 처리한다. 빈 결과의 binary/invalid UTF-8 skip 의미, 여러 줄 literal 쿼리와 긴 줄의 뒤쪽 매치를 유지하려고 필요한 경우 기존 전체 파일 검색을 사용한다. 이 경우 파일 크기는 2 MiB, 선행 읽기는 기존 32개에서 4개로 제한한다. 문자열 키를 사용하는 캐시의 동등성 계약은 바뀌지 않는다.

디렉터리의 최초 전체 열거와 최종 정렬은 고정 스냅샷·total·offset 계약상 유지한다. `readdir`의 전체 Dirent 배열 대신 `opendir`의 작은 내부 버퍼를 사용한다. 한 디렉터리를 닫고 자식들을 방문하므로 깊은 트리도 디렉터리 핸들을 하나만 유지한다. 50,000 파일 walk 제한과 truncated 표시를 유지한다. 스냅샷은 경로 목록의 고정 뷰이며 파일 내용은 매 호출의 현재 revision을 읽는다.

SDK abortSignal은 Effect 실행으로 전달한다. 취소 불가능한 native positional read는 하나씩 기다린 뒤 닫고, 중단된 Git 프로세스의 close도 기다린다. 취소를 `io_error`로 변환하지 않는다. 비밀 재정리는 결과 인덱스를 무효화하고 이미 진행 중이던 스캔은 Changed로 실패시킨다. `read_evidence` 등 일반 메모리 그래프 조회, DB 스키마, 실행 서버, 사용자 DB와 addon은 변경하지 않는다.

## 재현 가능한 측정

`vp exec node --expose-gc tools/io-range-benchmark.ts`를 실행했다. Node 26.8.2 / Effect 4.0.0, 같은 로컬 임시 fixture와 프로세스에서 각 경우 5회 중앙값이다. 기존 동작을 재현하는 baseline 루틴과 변경한 I/O 함수를 비교한다. 모델, HTTP, UI, SDK 결과 직렬화는 측정하지 않는다. 파일은 1,640,000 바이트·40,000 줄, 저장 결과는 7,600,000 UTF-8 바이트, 디렉터리는 3,500 파일이다. 다른 검증 작업과 병행된 실행이므로 절대 시간은 시스템 부하에 따라 변한다.

| 측정                                                                | 중앙값 (ms) |
| ------------------------------------------------------------------- | ----------: |
| result old: 100 pages, two SELECT * per page                        |    4108.808 |
| result old: first page, two SELECT *                                |      34.376 |
| result new: cold historical first page                              |      71.691 |
| result new: 100 warm pages                                          |      84.806 |
| result new: index at save                                           |      15.894 |
| result new: freshly saved first page (index at save)                |       0.929 |
| outside old: 50 repeated full reads + line slicing                  |     277.756 |
| file new: 50 warm range pages                                       |      42.455 |
| project old: 50 warm cached line slices                             |       0.033 |
| search old: 50 pages, full file per page                            |     227.147 |
| search new: 50 pages, bounded line ranges                           |      18.265 |
| directory old: 3500 entries, readdir array + fixed sorted snapshot  |      16.442 |
| directory new: 3500 entries, scoped opendir + fixed sorted snapshot |      60.834 |

저장 결과 100페이지는 약 48배, 외부 파일 50페이지는 약 6.5배, 검색 50페이지는 약 12배 빨라졌다. 새 결과의 저장 시 인덱스 생성 비용도 별도 표시했다. 역사 결과의 첫 페이지는 전체 UTF-16 길이를 알아야 하므로 기존보다 느릴 수 있으며 이후에는 인덱스를 재사용한다. 기존 프로젝트 메모리 캐시의 warm slice보다 범위 파일 I/O는 느리다. 전체 텍스트·줄 문자열을 계속 보관하는 대신 캐시 메모리를 줄이는 선택이다. `opendir`도 엔트리별 비동기 비용으로 평탄한 디렉터리의 열거 시간은 늘었지만 전체 Dirent 배열과 깊이별 열린 핸들은 제거한다.

Fixture 기준 결과 한 페이지의 JavaScript 전송은 기존 최대 15,200,000 바이트(원문 두 번)에서 최대 131,080 바이트로 제한된다. 파일 100줄 페이지는 4,100 바이트만 읽으며 50페이지는 205,000 바이트이다(최초 검증 1,640,000 바이트 별도). 기존 외부 파일 경로는 동일 50페이지에 82,000,000 바이트를 읽는다. 새 줄 인덱스는 160,000 바이트이며, 원문·줄 문자열은 유지하지 않는다. 가장 조밀한 2 MiB 파일의 줄 인덱스는 약 8 MiB까지 필요할 수 있다. 메모리 수치는 인덱스/전송 크기이며 프로세스 전체 peak RSS 측정은 아니다.

## 검증과 병행 변경 격리

시작 HEAD는 `8fbd...`이며 기존 작업 트리 상태·전체 변경 패치를 /tmp에 보관했다. HEAD archive에 이 I/O 파일만 복사한 /tmp/io-independent에서 검증한다. 이미 설치된 외부 의존성을 재사용하되 workspace package 링크는 격리 디렉터리를 가리키도록 복사했고 addon은 격리 디렉터리에 읽기 전용으로 사용하기 위한 복사본만 뒀다. 설치·모델 평가·실제 서버 재시작·푸시는 실행하지 않는다.

- 관련 테스트는 UTF-8 블록 경계, UTF-16 offsets, surrogate pair, NUL 결과, CRLF, 빈 파일, 긴 줄, 페이지 중복/누락, 파일 변경·삭제·크기 제한, scope close, SDK abort, 기존 검색 skip·snapshot·Git 계약을 검증한다.
- 전체 `vp test --run --maxWorkers=4`도 실행했으나 작업 트리에서는 225 파일/1,277 테스트 통과, 13 파일/51 테스트 실패와 28 unhandled errors였다. 로컬 포트 listen EPERM, Keychain/프로세스 환경 제한, WebGPU adapter 부재, 병행 작업/설치 기준선의 실패를 숨기지 않는다.
- 독립 상태의 offline 종합 검사는 환경 실패/실제 모델 경로를 제외한다. 제외 파일: embedding, agent-chat-owner-process-recovery, kagi, dev-hmr-api-recovery, durable-stream, agent-chat-worker-oauth-owner, oauth-account-login, dev-vite-lifecycle, openai-compatible, runtime, recall-sensor, chunked-password-entry, launch-project, oauth-validation-harness (`*.test.ts`). 이는 검증 CLI의 제외이며 저장소 test 설정이나 테스트 skip을 바꾸지 않는다.
- `vp check`(lint/format/type)와 `vp pack`은 독립 상태에서 통과한다. `vp run memory-agent#typecheck`는 깨끗한 HEAD 기준선과 변경 상태 모두 Effect 경고만 출력하며 exit 1이므로 성공으로 표기하지 않는다. 변경으로 발생한 TS 오류는 남기지 않는다. 실제 작업 트리는 별도 EFX RPC/workflow unstable API 오류도 출력한다.
- `vp env doctor`는 모든 필수 점검을 통과했으며 시스템 Node/fnm PATH 충돌 경고가 있다. 측정은 관리되는 `vp exec node`를 사용했다.

최신 관련 검사 9 파일·55 테스트가 통과했다. 독립 offline 종합 검사에서는 200 파일·1,120 테스트 통과·3 skipped와 cold worker asset 검사 한 건의 5초 timeout이 있었다. 그 실패 케이스만 idle 상태에서 재실행해 3.44초에 통과했다(테스트 1개 실행, 선택하지 않은 17개는 해당 파일의 앞선 종합 실행에서 통과). 앞선 독립 종합 실행은 201 파일·1,120 테스트 통과·3 skipped였다. timeout과 재실행 결과를 별도로 보존한다. 커밋은 작업 완료 응답에 기록한다. EFX/SQLite bridge/사용자 의존성 변경과 기존 docs 변경은 커밋에 포함하지 않는다.
