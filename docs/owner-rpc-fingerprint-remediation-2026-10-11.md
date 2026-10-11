# Owner RPC 저장 용량과 원본 수명주기 점검 (2026-10-11)

실제 `agent.db`는 91,404,693,504 bytes였고, `owner_rpc_operations.fingerprint` 2,555개가 88,958,277,073 bytes를 차지했다. 기존 fingerprint는 digest가 아니라 `{ input, operation }`의 canonical JSON 전체였다. middleware마다 전체 context snapshot을 중복 저장한 두 run이 원인이었다. 활성 작업과 자동 재시도 증가는 확인되지 않았다.

## 변경과 검증 계약

- canonical JSON의 기존 키 정렬·숫자 규칙을 유지하여 SHA-256으로 전체 요청을 비교한다. 저장 envelope는 `OwnerRpcFingerprintV1`, `sha256`, `owner-rpc-json-v1`을 명시한다.
- 진단·읽기 복구용 입력은 16,384자까지 보관한다. 큰 middleware 입력에서는 index/hook만 남기고, 나머지 큰 입력은 생략한다. 요청 자체를 잘라서 해싱하지 않는다.
- 구형 레코드와 새 요청은 동일 digest로 비교한다. 권한 검사, run key, operation ID high-water, 응답, pending/uncertain fence를 변경하지 않는다.
- 자동 기동 마이그레이션을 추가하지 않는다. 명시적 offline 변환은 한 레코드씩 commit하며, 불변 읽기 복구 receipt가 참조하는 원래 fingerprint는 유지한다.
- 실제 적용 전 전체 원본 DB의 압축 백업을 생성하고, 전체 해제 스트림의 SHA-256을 원본과 비교한다. 전체 복원 파일을 별도로 만들어 열어본 검증과는 구분한다.
- 실제 적용 전후 모든 테이블의 행 수와 행 내용 digest를 비교한다. 비교에서 제외하는 값은 `owner_rpc_operations.fingerprint` 하나뿐이다. receipt 연결 fingerprint, schema와 user_version은 별도로 비교한다. VACUUM 후에도 검증하며 실패·응답·작업·사용자 기록을 삭제하지 않는다.

## snapshot과 원본 정리

이번 원본은 마이그레이션 이전 DB의 복구 백업이다. 검증과 재기동 확인, 사용자 수용 이후 복구 가능한 정리 대상으로 두며 영구 보관을 요구하지 않는다. 이전의 독립적인 복구 백업은 이번 조치에서 삭제하지 않는다.

현재 앱 snapshot은 모든 원본을 대체하는 독립적인 보관본이 아니다.

- `workflow/completion-evidence.ts:24`의 완료 snapshot은 run/revision/evidence ID를 참조한다. `:172`에서 unresolved owner RPC를 검사하고 `:239`에서 원본 nodes를 확인한다. 완료 증명을 만들었다고 참조 대상이 불필요해지지 않는다.
- `agent/compaction.ts:310`과 `:370`의 대화 압축은 다음 모델 요청의 사본만 줄인다. 원본 conversation과 memory evidence를 그대로 사용한다. 요약 완료는 원본 복원 검증을 의미하지 않는다.
- `agent/owner-rpc-ledger.ts:53`은 기존 응답 replay, `:56`은 high-water, `:59`는 uncertain fence를 읽는다. ledger 삭제는 중복 실행 방지 정보도 없앤다.
- `workflow/owner-workflow-storage.ts:258`은 실행 ID가 존재할 때 기존 결과를 반환한다. 완료 실행과 activity/deferred 결과의 보존 기간 정리 API는 현재 없다. clock 취소만 관련 scheduled clock을 삭제한다.
- `agent/owner-read-recovery.ts:35`의 receipt 판정은 원본 operation·authorization fingerprint, binding, 실패 실행 payload/result를 정확히 비교한다. receipt만 남기고 이 레코드를 삭제하면 복구 판정이 깨진다.

향후 정리 정책은 **완료·권한 폐기·실행자 종료·미해결 효과/승인/clock 부재**, 독립 snapshot의 참조 무결성과 cold restore 검증, UI/기억/복구 참조의 해소를 함께 확인해야 한다. retry가 가능한 동안은 요청 digest와 cached reply를 유지한다. run을 영구 retirement하고 새 예약을 거부하는 tombstone을 도입한 뒤에는 run/binding ID, terminal 상태, high-water, digest, 복구 영수증에 필요한 최소 증명만 보관하고 큰 입력·응답·중간 로그를 정리할 수 있다. 이 정책은 제안이며 아직 자동 GC를 구현하거나 실제 데이터를 삭제하지 않았다.

## 실제 적용 결과

2026-10-11 11:57 UTC에 실제 변환과 VACUUM을 완료했다.

| 항목                   |        적용 전 |       적용 후 |
| ---------------------- | -------------: | ------------: |
| DB 파일 bytes          | 91,404,693,504 | 2,288,922,624 |
| fingerprint 전체 bytes | 88,958,277,073 |       690,799 |
| owner RPC 행           |          2,555 |         2,555 |
| user_version           |             49 |            49 |
| 복구 영수증            |              2 |             2 |

2,551개 fingerprint를 변환하고 불변 영수증이 참조하는 4개는 유지했다. DB 파일에서 89,115,770,880 bytes(약 83.0GiB)를 회수했다. VACUUM 뒤 freelist는 0이며 최대 fingerprint는 1,848 bytes다. 90개 테이블·1,591,786개 행의 내용을 fingerprint 필드 하나만 제외하고 정렬된 행 digest로 전후 비교하여 모두 일치했다. schema, user_version 및 영수증 연결 fingerprint도 일치했다. SQLite integrity_check는 `ok`, foreign_key_check는 0건이었다. 새 연결의 cold reopen에서도 같은 무결성·상태·행 수를 확인했다.

원본 전체의 zstd 백업은 1,492,469,023 bytes(약 1.39GiB)다. 원본과 전체 해제 스트림의 SHA-256은 모두 `b613c912c51962d0d42a130ffee9f94bf9237a3f5f1a95e868ef0e1a6edbf907`이다. 실제 백업 경로는 `/Users/creejee/.context-generactive-agent/backups/agent-before-owner-rpc-fingerprint-v1-20261011T1132Z.db.zst`이며 같은 prefix의 `.manifest.json`과 `.verification.json`에 복구 안내와 전후 검증값을 보관했다. 백업이나 이전 복구 자료를 영구 삭제하지 않았다.

실행·검증 기록은 `/tmp/cga-owner-rpc-migration.log`, `/tmp/cga-owner-rpc-migration-result.json`, `/tmp/cga-owner-rpc-cold-reopen-summary.json`이다. 명시적 maintenance 실행기는 `/tmp/cga-owner-rpc-maintenance.ts`, 재사용하는 변환 코어는 `src/agent/owner-rpc-fingerprint-migration.ts`다.

후속 검증: 새 fingerprint 5개 테스트와 ledger/recovery/run binding 테스트가 통과했다. 이전 timeout 대상 3개 파일은 무거운 DB 작업 종료 후 1 worker에서 41개(27.34초), cold reopen 종료 뒤 2 workers에서 41개(16.88초) 모두 통과했다. 최초 2 workers 실행(16.77초, 41개 통과)은 cold reopen과 일부 겹쳤으므로 독립 부하 검증과 구분한다. 최신 Windows 수정과 fingerprint 코드를 포함한 bundle 5 task도 통과했다. 입력 고정 해시는 `/tmp/cga-owner-rpc-fixed-input-hashes.txt`다.

전체 회귀 최초 실행은 sandbox의 loopback listen EPERM으로 실패하여 해당 Vitest만 SIGINT로 종료했다(exit 130). 코드·timeout을 바꾸지 않고 loopback 허용 환경에서 다시 실행해 **248파일·1,394개 통과·기존 3개 skip, 실패 0, exit 0**을 확인했다(270.65초, `/tmp/cga-owner-rpc-full-regression-loopback.log`). 최종 `vp check`는 825파일 포맷·733파일 lint/type-aware 검사 통과(`/tmp/cga-owner-rpc-check-final.log`). 별도 `vp run typecheck`는 일반 오류 0·기존 Effect 경고 27곳(28회 출력)으로 exit 1이며, fingerprint 변경의 추가 진단은 없다(`/tmp/cga-owner-rpc-types-final.log`). Windows 분기 테스트는 Mac의 주입 분기 검증이며 실제 Windows CI와 구분한다.

2026-10-11 12:09 UTC에 실제 5173 frontend와 5180 backend를 최신 코드로 재기동했다. 두 health는 build ID `117340f3dd0ee15ae83aef45`, runtime instance ID `45ca21b5-fe3c-4c9b-a8c1-bb8afdab144a`, `ready`로 일치한다. backend PID 54096, frontend PID 54107이며 dev 로그는 `/tmp/cga-owner-rpc-real-dev.log`다. 재기동 이후 schema 49, chat runs 1,633, tasks/attempts 각 1,927, owner RPC 2,555, 복구 영수증 2, durable 실행 2, RRSI experiments 3, API usage 19,851이 유지됐고 활성 run은 0이었다.

실제 RRSI 설정이 enabled이므로, 이번 검증의 모델 호출 금지를 지키기 위해 `CONTEXT_AGENT_RRSI_WORKER=1 vp run agent#dev`로 기존 자동평가 guard를 적용했다. 저장된 enabled 설정은 바꾸지 않았다. 이 guard는 현재 dev 프로세스 수명에 적용된다. 평상시 자동평가를 재개하려는 후속 실행은 일반 `vp run agent#dev`를 사용한다. 모델 호출·실패 run 재생·커밋·push·진단 억제를 추가하지 않았다.

사용자가 이후 서버 종료를 요청하여 최종 상태를 **정지**로 변경했다. 재기동 검증에 사용한 dev supervisor PID 54017, backend 54096, frontend 54107과 wrapper/자식 53979·54002·54097·54102를 동일 실행으로 식별했다. 해당 dev 터미널에 SIGINT를 전달하여 정상 종료 경로를 실행한 후 모든 PID의 부재를 확인했다. 5173/5180 및 격리 테스트 15173/15180·16173/16180은 미점유이고 DB 열린 파일과 backend lock도 없다. 다른 프로젝트와 앱은 종료하지 않았으며 자동 재시작하지 않는다. RRSI 환경 guard도 종료한 프로세스와 함께 끝났다. 이번 복구 archive와 메타데이터 파일 권한은 모두 0600이다.
