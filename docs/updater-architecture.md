# 설치·자동 업데이트 아키텍처

> 상태: 단계별 제품 경계 기준선 · 2026-09-21

이 문서는 GitHub Releases에서 배포하는 Context Agent 실행 파일의 설치와 자동 업데이트 경계를 정의한다. 현재 제품은 Node SEA 단일 실행 파일이며 `context-agent [폴더]`는 로컬 웹 서버와 브라우저를, `context-agent acp`는 에디터용 stdio ACP를 제공한다.

## 불변식

1. 사용자의 명시적 동의 없이 최초 실행 파일을 이동하거나 PATH를 변경하지 않는다.
2. portable 실행과 설치된 실행을 모두 지원하되, 자동 교체는 설치된 실행에만 제공한다.
3. 실행 중인 core 바이너리를 덮어쓰지 않는다. 버전별 core를 설치하고 고정 진입점의 `current`만 전환한다.
4. 정상 상태에서는 현재 버전과 직전 정상 rollback 버전 하나를 보존한다.
5. CLI, ACP, 이후 추가할 macOS `.app`은 동일한 `current` core와 사용자 저장소를 사용한다.
6. GitHub와 체크섬 파일만 업데이트 신뢰의 근거로 삼지 않는다. 설치된 앱은 내장 공개 키로 서명된 릴리스 매니페스트를 검증한다.
7. 자체 릴리스 서명은 OS 코드 서명을 대신하지 않는다. 미서명 배포 기간에는 Gatekeeper와 SmartScreen 경고를 숨기거나 자동 우회하지 않는다.

## 1단계: CLI core 설치와 업데이트

1단계 릴리스의 제품 표면은 다음과 같다.

- 기존 Node SEA 실행 파일
- `context-agent [폴더]` 로컬 서버 및 브라우저 실행
- `context-agent acp` stdio ACP 실행
- portable SEA가 제공하는 명시적 사용자 단위 설치 및 제거
- PATH에 노출되는 고정 `context-agent` 진입점
- GitHub Releases의 서명된 매니페스트 확인, 다운로드 및 검증
- 사용자 승인 후 버전 전환과 재시작
- 시작 health check 실패 시 직전 정상 버전으로 rollback
- current와 rollback 두 세대 외의 core 및 관련 runtime 정리

1단계에는 Finder/Dock 전용 UI, `.app` 번들, Applications 드래그앤드롭 설치가 포함되지 않는다. SEA를 현재 위치에서 실행하는 portable 모드는 계속 지원하지만, portable 파일은 자동으로 덮어쓰지 않고 설치 또는 수동 다운로드를 안내한다.

### 실행 소유권

설치 관리자는 버전별 core와 `current`/`rollback` 상태를 소유한다. 고정 CLI 진입점은 선택된 core에 인자, 환경, stdin/stdout/stderr, signal, 종료 코드를 보존하여 전달한다. 특히 `context-agent acp`의 stdout에는 ACP 프로토콜 외 출력을 추가하지 않는다.

사용자 데이터와 설치 파일은 별도 수명주기를 가진다. 기존 `~/.context-generactive-agent`의 설정, SQLite, 인덱스와 다운로드 모델은 설치·업데이트로 이동하거나 삭제하지 않는다. 제거 시에도 사용자 데이터 삭제는 별도의 명시적 선택이다.

## 2단계: 서명·공증된 macOS `.app`

2단계는 1단계 core가 안정화되고 Developer ID 서명과 공증을 릴리스 게이트로 운영할 수 있을 때 시작한다.

`.app` launcher가 추가하는 제품 표면은 다음과 같다.

- DMG에서 Applications로 드래그하는 macOS 표준 설치 UX
- Finder, Spotlight, Launchpad 및 Dock에서 실행
- 최근 프로젝트 표시 또는 폴더 선택
- 동일 core를 통한 서버 시작과 브라우저 열기
- core 미설치·손상·rollback 상태에 대한 안내

`.app`은 별도 core를 포함해 독립적으로 업데이트하거나 별도 `current`를 관리하지 않는다. 설치 관리자가 소유한 동일한 core와 `current`를 찾아 실행하는 얇은 launcher다. ACP stdio와 명령행 프로젝트 경로 전달은 계속 고정 CLI 진입점이 담당한다. 따라서 `.app`의 이동이나 이름 변경이 CLI 실행을 깨뜨리지 않아야 한다.

## portable SEA 사용자의 마이그레이션

기존 사용자가 다운로드한 SEA를 실행하면 현재처럼 앱을 사용할 수 있다. 앱은 portable 상태를 감지한 뒤 설치의 효과를 설명하고 설치 여부를 묻는다.

설치를 승인하면 다음 순서로 전환한다.

1. 현재 SEA의 버전과 플랫폼을 확인한다.
2. 사용자 단위 설치 루트의 해당 버전 디렉터리에 SEA를 복사한다.
3. 복사본의 크기와 SHA-256을 다시 검증한다.
4. 완전한 버전 디렉터리만 보이도록 staging 디렉터리를 rename한다.
5. 기존 current가 없으면 설치 버전을 current로 지정한다. 기존 설치가 있으면 일반 업데이트·다운그레이드 규칙을 적용한다.
6. 고정 CLI 진입점을 설치하고, PATH 변경은 별도의 동의를 받는다.
7. 기존 `~/.context-generactive-agent`를 그대로 사용해 대화, 설정, 프로젝트와 모델을 이어간다.
8. 설치된 core의 정상 시작을 확인한 뒤 다운로드한 portable 파일은 사용자가 직접 보관하거나 삭제하도록 안내한다. 원본을 자동 삭제하지 않는다.

설치를 거부하면 현재 portable 실행을 계속하며 파일과 PATH를 변경하지 않는다. 나중에 명시적 설치 명령으로 같은 전환을 다시 시작할 수 있다.

## 사용자 단위 설치 계약

설치 파일은 기존 데이터 루트 `~/.context-generactive-agent`와 분리한다.

| 항목          | macOS                                                 | Windows                                             |
| ------------- | ----------------------------------------------------- | --------------------------------------------------- |
| 설치 루트     | `~/Library/Application Support/context-agent/install` | `%LOCALAPPDATA%\ContextAgent\install`               |
| 버전별 core   | `<root>/versions/<SemVer>/context-agent`              | `<root>\versions\<SemVer>\context-agent.exe`        |
| 설치 상태     | `<root>/state/install-state.json`                     | 동일                                                |
| staging       | `<root>/staging/<uuid>`                               | 동일                                                |
| 고정 진입점   | `~/.local/bin/context-agent`                          | `%LOCALAPPDATA%\ContextAgent\bin\context-agent.exe` |
| 사용자 데이터 | `~/.context-generactive-agent`                        | `%USERPROFILE%\.context-generactive-agent`          |

`install-state.json`은 current와 optional rollback을 한 세대로 묶고 각각의 target, core 상대 경로, SHA-256과 runtime hash를 기록한다. 모든 상대 경로를 설치 루트 안의 real path로 다시 검증한 후 사용한다. 심볼릭 링크만으로 current 상태를 표현하거나 current와 rollback을 별도 파일로 갱신하지 않는다.

### 설치 명령과 멱등성

- portable SEA의 `context-agent install`은 변경 예정 설치 루트, core 버전, 고정 진입점과 PATH 변경 여부를 먼저 표시하고 확인을 받는다. `--yes`는 표시를 생략하지 않고 확인만 비대화형으로 대체한다.
- 최초 설치는 staging에 복사·검증한 뒤 버전 디렉터리로 원자적 rename하고, current 상태 파일을 temp-write + fsync + rename으로 게시한다.
- 같은 버전·target·digest가 이미 설치되어 있으면 core를 다시 쓰지 않는다. 누락되거나 달라진 고정 진입점과 상태 파일만 복구하고 결과는 동일한 상태에 수렴한다.
- 같은 SemVer에 다른 digest가 있으면 공급망 충돌로 취급해 자동 교체하지 않는다. 명시적인 제거 후 재설치 또는 더 높은 버전을 요구한다.
- 설치된 core와 portable core는 `current.json`이 가리키는 검증된 경로와 실행 파일 real path가 같은지로 구분한다. 파일명이나 실행 디렉터리만으로 설치 상태를 추측하지 않는다.

### PATH 정책

기본 설치는 고정 진입점을 만들되 shell profile이나 사용자 PATH를 자동 변경하지 않는다. 설치 전후에 추가할 정확한 디렉터리와 되돌리는 방법을 표시한다.

- macOS: `~/.local/bin`이 PATH에 없으면 사용 중인 shell에 맞는 한 줄을 안내한다. 사용자가 `--add-to-path`를 명시한 경우에만 `# context-agent begin/end` marker block을 사용자 profile에 추가한다. 기존 줄을 수정하지 않으며 제거 시 해당 block만 지운다.
- Windows: `%LOCALAPPDATA%\ContextAgent\bin`이 사용자 PATH에 없으면 안내한다. `--add-to-path`를 명시한 경우에만 사용자 범위 PATH를 갱신하고 환경 변경 알림을 보낸다. machine PATH와 관리자 권한은 사용하지 않는다.
- 이미 PATH에 같은 이름의 다른 실행 파일이 먼저 있으면 그 경로를 표시하고 성공으로 가장하지 않는다. `context-agent doctor`가 실제 해석 경로, current core와 버전을 함께 보여준다.

### 재설치와 제거

`context-agent install`은 언제든 repair로 다시 실행할 수 있다. 실행 중인 core는 건드리지 않고, 완료된 버전 디렉터리와 고정 진입점만 복구한다. `context-agent uninstall`은 고정 진입점, 설치 상태와 core/runtime만 제거하고 `~/.context-generactive-agent` 및 OS keychain 항목은 기본적으로 보존한다.

사용자 데이터 삭제는 별도 `--delete-data` 선택과 데이터 루트의 정확한 경로 표시 후 두 번째 확인이 필요하다. 비대화형 실행에서는 `--delete-data --yes`를 모두 지정하지 않으면 거부한다. 설치 루트나 데이터 루트 밖의 경로, 현재 실행 파일 또는 다른 프로세스가 사용하는 core는 삭제하지 않고 재시작 후 정리 대상으로 남긴다.

## 업데이트 정책과 사용자 UX

기본 채널은 `stable`이며 `prerelease`는 명시적으로 opt-in한다. 채널을 바꿔도 이전 버전으로 자동 이동하지 않는다. 다운그레이드는 별도의 `--allow-downgrade <exact-version>`과 위험 확인을 요구한다.

### 확인 시점과 명령

- 설치된 core는 정상 서버 시작 후 현재 실행을 막지 않는 background task로 업데이트를 확인한다. 성공한 확인으로부터 24시간 동안 다시 확인하지 않으며 시작 시 0–30분 jitter를 둔다.
- 실패는 앱 시작·CLI·ACP를 실패시키지 않는다. 마지막 성공/실패 시각과 짧은 원인을 상태에 남기고, 1시간부터 최대 24시간까지 backoff한다.
- `context-agent update check`는 주기 제한 없이 수동 확인하고 결과만 보고한다. `update status`는 채널, current/rollback, 마지막 확인, 준비된 버전과 오류를 네트워크 없이 표시한다.
- ACP mode는 stdout/stderr에 임의의 업데이트 알림을 쓰지 않는다. 웹 UI의 비차단 banner와 명시적 update 명령만 사용자에게 알린다.
- portable mode의 background 확인과 자동 다운로드는 꺼져 있다. `update check`를 실행하면 설치 명령 또는 GitHub Releases의 수동 다운로드를 안내하고 자기 파일을 교체하지 않는다.

### 다운로드·검증·적용 승인

새 stable 버전을 찾으면 release notes, 용량, 현재→대상 버전, 재시작 필요 여부를 보여준다. `나중에`, `이 버전 건너뛰기`, `다운로드`를 제공하며 확인만으로 다운로드하거나 재시작하지 않는다.

다운로드는 설치 루트의 새 UUID staging에만 저장한다. 다음 순서를 모두 통과해야 `ready` 상태가 된다.

1. HTTPS 응답의 최종 host와 redirect 수를 제한하고 signed manifest의 URL과 일치하는 target asset만 받는다.
2. manifest 서명, schema version, 채널, SemVer 상승, 최소 updater, target과 DB 호환성을 확인한다.
3. 선언한 byte 크기와 안전한 최대 크기를 넘기지 않도록 stream하며 SHA-256을 계산한다.
4. 크기와 digest를 constant-time 비교하고 archive의 절대 경로, `..`, symlink/hardlink와 예상 밖 파일을 거부한다.
5. 추출된 core의 내장 version/channel/target이 manifest와 일치하고 실행 권한과 platform 형식이 맞는지 확인한다.
6. 완전한 staging만 버전 디렉터리로 rename한다. 하나라도 실패하면 staging을 폐기하고 current를 바꾸지 않는다.

미서명 과도기에는 준비된 업데이트도 사용자의 `재시작하고 적용` 또는 `context-agent update apply` 승인 없이 current를 바꾸거나 프로세스를 종료하지 않는다. 적용 직전에 버전·채널·digest를 다시 표시한다. 서버가 작업 중이면 새 작업 수락을 멈추고 진행 중 작업의 종료 또는 사용자의 강제 적용 결정을 기다린다. 강제 적용은 기본값이 아니다.

검증 불일치와 동일 SemVer digest 충돌은 일반 네트워크 재시도로 숨기지 않고 보안 오류로 표시한다. 해당 자산을 삭제하고 같은 manifest를 자동 재시도하지 않는다. 다음의 더 높은 signed manifest 또는 사용자의 명시적 수동 확인까지 현재 버전을 계속 실행한다.

## 원자적 전환과 health check

고정 진입점과 설치 관리자는 core와 별도 프로세스다. 실행 중인 core 파일은 macOS와 Windows 모두 열어 둔 채 수정·삭제하지 않는다. 적용은 새 버전 디렉터리가 완성된 뒤 단일 `install-state.json`의 current/rollback 쌍만 바꾸며, updater lock으로 설치·적용·제거를 직렬화한다.

### 전환 protocol

N에서 N+1로 적용할 때 다음 순서를 지킨다.

1. lock을 잡고 기존 install state, 실행 파일 real path와 준비된 N+1의 identity를 다시 검증한다.
2. transaction ID, 이전 state 전체, candidate identity와 phase를 `<root>/state/transactions/<id>.json`에 temp-write + file fsync + rename + parent-directory fsync로 기록한다.
3. 현재 서버가 새 작업 수락을 멈추고 child command와 DB transaction을 정리하도록 요청한다. 정상 종료 timeout은 30초이며, 이후에도 실행 중이면 사용자에게 취소 또는 강제 종료를 다시 묻는다.
4. `{ current: N+1, rollback: N, generation: old+1 }`을 단일 새 install state로 같은 fsync/rename protocol을 통해 게시한다. 별도 current/rollback 파일이나 실행 파일 in-place 교체는 없다.
5. 고정 launcher가 candidate를 격리 health mode로 시작한다. 성공 전에는 브라우저를 열거나 일반 요청, ACP session, background update check를 받지 않는다.
6. health 성공을 transaction에 기록하고 N을 rollback으로 확정한 뒤 원래 사용자가 요청한 server 또는 ACP mode를 N+1로 시작한다.
7. 실패하거나 전체 120초 timeout을 넘기면 DB schema가 N의 지원 범위 안일 때만 이전 install state 전체를 새 generation으로 원자 복원하고 N을 다시 시작한다. 호환되지 않으면 N을 실행하지 않고 P5의 backup restore 또는 forward recovery로 전환한다. 실패한 candidate를 rollback으로 사용하지 않는다.

중단 복구는 transaction과 install-state generation을 함께 읽는다. state가 이전 snapshot이면 candidate는 아직 current가 아니므로 계속 사용하지 않는다. state가 candidate를 가리키지만 success record가 없으면 health를 한 번 재개하거나 이전 snapshot으로 rollback한다. 어떤 경우에도 부분 JSON, 존재하지 않는 core 또는 generation을 추측해 가장 높은 버전을 선택하지 않는다.

### 정상 판정

health mode는 localhost의 임의 port와 transaction별 nonce를 사용하며 다음을 모두 만족해야 한다.

- candidate의 내장 version/channel/target과 파일 SHA-256이 transaction과 같다.
- 서버가 `127.0.0.1`에 bind하고, 기존 instance와 구분된 nonce를 응답한다.
- 사용자 저장소와 SQLite를 열고 migration을 완료하며, 필요한 lock과 read/write probe를 통과한다.
- SEA runtime을 완전히 준비하고 manifest hash를 확인하며 필수 native addon을 load할 수 있다.
- 최소 내부 health API가 version, DB schema, runtime hash와 nonce를 기대값으로 반환한다.
- server health는 30초, runtime/DB를 포함한 전체 health는 120초 안에 끝난다. timeout 연장은 자동 성공으로 취급하지 않는다.

DB 호환성 때문에 이전 core가 새 schema를 읽지 못하는 경우에는 4단계 전에 binary rollback을 비활성화하고 P5의 backup/forward-recovery 경로를 사용한다.

### launcher 투명성과 오류 보고

일반 실행에서 launcher는 인자, cwd, 환경, stdin/stdout/stderr와 종료 코드를 그대로 전달한다. macOS는 state 검증 후 가능한 경우 `exec`로 core를 대체한다. Windows launcher는 inherited standard handles와 Job Object/console control forwarding을 사용하고 child 종료 코드를 그대로 반환한다. 어느 플랫폼에서도 `context-agent acp` stdout에 launcher 또는 update log를 쓰지 않는다.

실패 시 현재 모드가 허용하는 UI 또는 명령 stderr에는 transaction ID와 짧은 원인만 표시한다. 상세 log는 `<root>/logs/update-<id>.log`에 두며 URL token, 환경 변수, 사용자 데이터 내용을 기록하지 않는다. `context-agent update status`가 rollback 결과와 log 경로를 보여준다.

## 두 세대 core와 runtime 정리

정리는 업데이트 health 성공과 rollback 확정 뒤에만 실행한다. N→N+1 성공 시 N+1이 current, N이 rollback이다. 이어 N+1→N+2가 성공하면 한 번의 install-state 게시로 N+2를 current, N+1을 rollback으로 만든 다음에만 N core와 N만 참조하던 runtime을 정리한다. 새 candidate가 실패한 경우 current/rollback 세대에는 변화가 없고 실패 candidate만 정리 대상이다.

각 launcher/core process는 `<root>/state/processes/<pid>-<nonce>.json`에 자신의 core real path와 runtime hash를 기록하고 해당 lease lock을 프로세스 수명 동안 보유한다. 시작 시 `process.execPath` real path가 기록값 및 install state와 일치하는지 검사한다. 정리는 다음 보호 집합을 매번 lock 안에서 새로 계산한다.

- install state의 current core와 runtime
- install state의 rollback core와 runtime
- 현재 정리 프로세스의 `process.execPath` real path
- lock을 실제로 보유 중인 모든 process lease의 core와 runtime
- 미완료 transaction이 참조하는 이전 state와 candidate

PID 존재 여부나 오래된 timestamp만으로 실행 중이 아니라고 판단하지 않는다. lease lock을 얻을 수 없는 항목은 사용 중으로 보고 다음 시작으로 미룬다. 따라서 장시간 실행 중인 이전 core가 있으면 일시적으로 세 세대 이상 남을 수 있지만, 모든 이전 process가 끝난 정상 수렴 상태에는 완전한 core와 runtime이 current/rollback 최대 두 세대뿐이다.

### 안전한 삭제 protocol

1. 삭제 후보는 `versions/<SemVer>`의 직접 자식 또는 `runtimes/<hash>`의 직접 자식이어야 한다. lexical normalize와 realpath가 모두 설치 루트 안이고 symlink/reparse-point를 통과하지 않는지 확인한다.
2. install state generation, `process.execPath`, process leases와 transaction 참조를 삭제 직전에 다시 읽는다. 하나라도 보호 집합에 들어오면 건너뛴다.
3. 후보를 같은 parent의 `.deleting-<uuid>`로 원자적 rename한다. Windows에서 공유 위반이 나면 강제 삭제하지 않고 미룬다.
4. rename 뒤에도 경계와 파일 종류를 다시 검사한 후 재귀 삭제한다. rename 시점의 journal을 fsync하고 성공 후 지운다.
5. 중단 뒤 시작할 때 `.deleting-*`은 어떤 state도 참조할 수 없는 이름이다. 그러나 process lease와 경계를 다시 검증한 뒤 삭제를 재개한다. 미참조 staging도 활성 transaction이 없고 24시간이 지난 경우 같은 protocol로 정리한다.

runtime 보호는 저장된 refcount를 신뢰하지 않고 보호된 core 및 process lease의 runtime hash에서 매번 계산한다. 현재 `unpackRuntime`의 “현재 hash 외 즉시 삭제” 동작은 설치 모드에서 비활성화하고 이 collector로 통합한다. portable mode는 update 세대를 갖지 않으므로 현재 실행 runtime을 보호한 범위에서 기존 단일 runtime 정리를 유지할 수 있다.

사용자 데이터 루트, DB, 모델, 설정, keychain과 설치 루트 밖 경로는 이 collector의 입력 자체가 아니다. 경계 검증에 실패하면 삭제보다 누수를 선택하고 `doctor`에 복구 가능한 경고를 남긴다.

## DB migration과 rollback 호환성

현재 DB는 `PRAGMA user_version`을 사용하고 각 migration을 `BEGIN IMMEDIATE` transaction으로 적용한다. 릴리스마다 다음 계약을 빌드에서 생성해 binary와 signed manifest 양쪽에 넣고, 두 값이 다르면 적용을 거부한다.

- `db.readMin`, `db.readMax`: 이 binary가 안전하게 열 수 있는 schema 범위
- `db.writeCurrent`: health/migration 성공 뒤 만드는 schema
- `db.rollbackMin`, `db.rollbackMax`: 이 버전으로 binary rollback할 수 있는 schema 범위
- `db.migrationKind`: `none | additive | destructive`

기본 정책은 migration 배열 끝에 단계만 추가하고 기존 migration을 수정하지 않는 것이다. additive migration도 이전 binary의 `readMax/rollbackMax`가 새 schema를 포함한다고 명시되고 실제 호환성 test를 통과한 경우에만 자동 binary rollback이 가능하다. SQLite가 더 새 schema를 우연히 열 수 있다는 이유만으로 호환으로 간주하지 않는다.

### 업데이트 전 판단과 backup

1. DB lock을 잡고 WAL checkpoint 후 현재 `user_version`, `foreign_key_check`, quick integrity check를 기록한다.
2. 현재 schema가 candidate의 read 범위 밖이면 적용하지 않는다.
3. candidate의 `writeCurrent`가 rollback binary의 rollback 범위 안이면 migration 뒤에도 binary rollback 가능하다고 transaction에 기록한다.
4. 범위 밖이거나 migration이 destructive이면 SQLite backup API로 DB, WAL 상태와 schema metadata의 일관된 snapshot을 `<data-root>/backups/update-<transaction-id>/`에 만든다. 같은 filesystem의 temp에 쓰고 검증 후 rename한다. 단순 파일 copy는 사용하지 않는다.
5. backup을 read-only로 열어 `user_version`, `integrity_check`, `foreign_key_check`와 핵심 row counts를 확인한 뒤에만 migration을 시작한다. 공간 부족 또는 검증 실패면 current를 바꾸지 않는다.

health mode에서는 일반 요청과 background writer를 막은 상태로 migration한다. 각 step은 기존처럼 transaction이며, 전체 migration 중간에 실패하면 candidate를 중지한다. 여러 step 중 일부가 이미 commit되어 rollback binary 범위를 벗어났다면 이전 binary를 실행하지 않고 검증된 backup을 원래 위치에 원자 복원한 다음 N을 health check한다.

새 버전이 정상 서비스로 전환된 뒤 사용자 write를 받았다면 pre-update backup을 자동 복원하지 않는다. 새 data를 잃을 수 있기 때문이다. 이후 장애에서 rollback binary가 현재 schema와 호환되지 않으면 current를 `recovery-required`로 표시하고 다음 호환 버전으로 forward recovery하거나, 사용자에게 backup 시각과 post-update data 손실 가능성을 명시한 수동 복구만 제공한다.

install state의 rollback 항목은 core가 존재하는지만이 아니라 현재 schema에서 `eligible: true|false`와 이유를 기록한다. launcher는 매 시작 시 실제 `user_version`으로 이를 다시 확인한다. `eligible: false`인 binary는 자동·수동 `update rollback` 모두 실행하지 않는다.

### migration 검증 matrix

각 release candidate는 최소 다음 fixture를 현재 및 직전 두 supported schema에 대해 실행한다.

- 각 schema → candidate migration 후 `integrity_check`, `foreign_key_check`, 핵심 row counts와 대표 read/write query
- candidate schema를 rollback binary가 열고 대표 read/write query를 수행하는 declared-compatible case
- declared-incompatible case에서 이전 binary 실행 거부와 backup restore 후 digest/schema/row count 일치
- 각 migration step 직전·직후 강제 종료에서 old 전체 또는 migrated 전체로만 복구
- migration 성공 뒤 새 row를 쓴 상태에서 자동 backup restore가 금지되고 forward-recovery 상태가 되는지 확인

파괴적 migration은 stable에 바로 내지 않는다. backup/restore와 forward recovery를 prerelease에서 검증하고, release notes에 rollback 제한과 예상 추가 디스크를 표시한다. backup은 다음 stable update 성공 또는 사용자가 확인한 보존 기간까지 유지하며 core/runtime 두 세대 collector가 삭제하지 않는다.

## OS 보안 경고와 코드 서명 단계

Ed25519 release manifest는 설치된 신뢰 키에서 다음 자산의 일관성을 검증하지만 OS가 인식하는 publisher identity는 아니다. 최초로 받은 미서명 binary 자체가 바뀌었다면 그 안의 공개 키도 바뀔 수 있으므로 bootstrap 위험이 남는다. SHA-256 sidecar도 같은 GitHub 계정에서 함께 바뀔 수 있어 독립적인 신뢰 근거가 아니다.

### 현재 미서명 과도기

- macOS 패키징의 ad-hoc signature는 Apple Developer ID가 아니며 notarization할 수 없다. 브라우저로 받은 quarantine binary는 “개발자를 확인할 수 없음” 경고로 차단될 수 있다. 사용자가 공식 release URL과 표시된 version/hash를 확인한 뒤 Finder의 `열기` 또는 시스템 설정 → 개인정보 보호 및 보안의 `확인 없이 열기`처럼 macOS가 제공하는 1회 수동 승인만 선택할 수 있게 안내한다.
- Windows는 Publisher가 `Unknown publisher`로 표시되고 Microsoft Defender SmartScreen의 “Windows의 PC 보호”가 나타날 수 있다. 사용자가 공식 release와 hash를 확인하고 위험을 이해한 경우에만 `추가 정보` → `실행`을 직접 선택하도록 안내한다. SmartScreen 평판은 release manifest 서명만으로 생기지 않는다.
- 앱과 문서는 `xattr -d`, `spctl --master-disable`, Gatekeeper 비활성화, Defender/SmartScreen 예외 추가, PowerShell execution policy 완화 또는 quarantine 자동 제거를 실행·권장하지 않는다.
- OS가 malware, signature 손상 또는 revocation을 보고하면 우회 절차를 제시하지 않고 설치를 중단한다. 보안 도구 오탐 여부는 별도 release incident로 조사한다.

이 기간의 자동 업데이트는 signed manifest 검증 후에도 download/apply/restart를 분리하고 사용자의 명시적 적용 승인을 유지한다. 초기 배포는 opt-in prerelease cohort에서 시작해 crash/rollback/update signature 지표를 확인한 뒤 stable에 확대한다.

### macOS 서명·공증 gate

2단계 `.app`/DMG 전에 Apple Developer ID를 확보하고 launcher, 포함된 helper와 배포되는 SEA core를 hardened runtime과 secure timestamp로 서명한다. 동일 Team ID를 요구하고 entitlement는 최소화한다. notarization 성공 후 DMG에 ticket을 staple하며 release job은 최소 다음을 통과해야 한다.

- `codesign --verify --deep --strict --verbose=2 <app-or-binary>`
- `spctl --assess --type execute --verbose=4 <app>`
- `xcrun stapler validate <dmg>` 및 격리된 clean machine의 offline 설치·실행
- updater가 다운로드 후 Ed25519 manifest에 더해 Apple trust chain, Team ID, designated requirement를 확인

한 항목이라도 실패한 `.app`/DMG는 GitHub Release에 publish하지 않는다. 인증서 만료·폐기와 Team ID 변경은 key rotation과 별도의 release incident로 취급한다.

### Windows Authenticode gate

1단계는 미서명 경고를 명시한 채 제공하되, Authenticode 인증서를 확보하면 launcher와 모든 SEA `.exe`를 RFC 3161 timestamp와 함께 서명한다. release job에서 `signtool verify /pa /all /v`와 pinned publisher subject/chain을 확인하고, updater도 manifest 검증 뒤 Authenticode와 expected publisher를 검사한다. 검증 실패 자산은 publish/apply하지 않는다.

Authenticode 도입 직후에도 SmartScreen reputation이 즉시 충분하지 않을 수 있음을 안내한다. 서명 도입 뒤에는 unsigned 새 버전으로 자동 fallback하지 않으며, 인증서 교체는 old/new publisher overlap release와 clean-VM 검증을 거친다.

## 2단계 macOS `.app` launcher

`Context Agent.app`은 Swift/SwiftUI 기반의 작은 GUI launcher이며 Node runtime, web assets, DB migration 또는 별도 core를 번들하지 않는다. 위치나 bundle 이름을 기준으로 core를 찾지 않고 항상 사용자 설치 루트의 동일한 `install-state.json`을 검증해 CLI와 같은 current core를 실행한다. `/Applications`, 사용자 Applications 또는 다른 폴더로 앱을 옮겨도 CLI와 core 경로는 바뀌지 않는다.

### Finder 실행 흐름

1. launcher 자체의 signature/Team ID와 설치 state generation을 확인한다.
2. core가 없으면 `CLI core 설치가 필요합니다` 화면에서 설치 위치와 공식 서명된 다운로드를 설명하고, Terminal에 복사할 설치 명령 또는 공식 download page 열기만 제공한다. 앱 번들 안에 숨은 다른 core를 실행하지 않는다.
3. current가 유효하면 core의 제한된 launcher protocol을 시작해 최근 프로젝트 목록과 상태를 요청한다. `.app`이 SQLite schema를 직접 읽거나 migration하지 않는다.
4. 사용자는 최근 프로젝트 또는 macOS folder picker로 폴더를 선택한다. 선택한 security-scoped URL/bookmark는 launcher에 필요한 최소 범위로만 보관하고 core에는 정규화한 프로젝트 경로를 전달한다.
5. core를 `--launcher-mode --no-open <project>`로 시작하고 nonce가 일치하는 localhost ready 응답을 기다린 뒤 시스템 기본 브라우저를 연다. ready 전에 임의 URL을 열지 않는다.
6. 앱이 종료되어도 명시적으로 시작한 server를 같이 종료할지 background로 둘지 묻고, 종료를 선택하면 P4의 graceful shutdown을 사용한다.

`.app`은 ACP를 중계하지 않는다. 에디터의 `context-agent acp`, terminal 인자·stdio·signal·exit code는 계속 고정 CLI launcher가 담당한다.

### 손상·rollback·업데이트 UX

- install state가 없거나 current core가 없으면 설치/repair 안내를 표시한다.
- current digest, target, Apple signature 또는 runtime 검증이 실패하면 실행하지 않고 `context-agent doctor` 결과와 repair 경로를 보여준다.
- current health가 실패하고 rollback이 DB-compatible/eligible이면 버전과 데이터 조건을 보여준 뒤 이전 정상 버전으로 복구할지 묻는다. eligible하지 않으면 오래된 binary를 실행하지 않고 recovery-required 안내와 log 위치를 제공한다.
- `.app`은 별도 core channel, current 또는 rollback을 만들지 않는다. core update banner와 적용은 1단계 updater state를 그대로 사용한다.
- manifest가 요구하는 최소 launcher보다 앱이 오래되면 core 적용을 막고 서명·공증된 새 DMG 교체를 안내한다. launcher 자체의 교체는 core 전환과 섞지 않는다.

### DMG 설치와 제거

DMG에는 서명·공증된 `Context Agent.app`, Applications alias, 짧은 설치/제거 안내만 둔다. 사용자는 앱을 Applications로 drag하고 DMG를 eject한다. 첫 실행과 offline 실행은 stapled ticket으로 Gatekeeper gate를 통과해야 한다.

앱을 휴지통으로 옮기면 GUI launcher만 제거되며 CLI/core와 사용자 데이터는 그대로 남는다고 표시한다. 완전 제거는 앱의 `CLI core 제거…`가 고정 launcher의 `uninstall` flow를 호출하고, 사용자 데이터는 다시 별도 선택·두 번째 확인을 요구한다. `.app` 이름 변경이나 이동, DMG 제거는 `~/.local/bin/context-agent`를 수정하지 않는다.

## 종단 test와 점진 배포

1단계 최초 지원 target은 현재 CI 자산과 같은 `darwin-arm64`와 `win32-x64`다. 다른 target은 동일 matrix를 native runner/clean VM에서 통과하고 signed manifest에 추가될 때까지 unsupported로 명확히 실패한다. host와 다른 target 자산으로 자동 fallback하지 않는다.

### 1단계 release gate

단위·fault-injection test는 manifest canonicalization/signature/키 회전, archive traversal, path boundary, install-state generation, transaction recovery, process lease, cleanup 보호 집합과 DB compatibility matrix를 다룬다. 이어 각 지원 OS의 매번 초기화되는 일반 사용자 VM에서 실제 packaged SEA로 다음을 검증한다.

1. portable 최초 실행 거부 시 원본, 설치 루트와 PATH가 바뀌지 않는다.
2. install preview와 동의, PATH 안내 및 opt-in 변경/되돌림, Unicode·space 경로, 반복 install/repair가 같은 상태에 수렴한다.
3. 고정 launcher의 server/browser와 ACP fixture가 cwd, 인자, stdin/stdout/stderr, signal/console event와 종료 코드를 보존한다.
4. offline/timeout/404는 현재 실행을 방해하지 않고, signature·size·hash·target·embedded-version 손상은 staging을 폐기한다.
5. N→N+1 성공 뒤 `{current:N+1, rollback:N}`, N+1→N+2 성공 뒤 `{current:N+2, rollback:N+1}`이며 N core와 N-only runtime만 삭제된다.
6. download, extract, state temp-write/rename, health, rollback, `.deleting` 각 지점의 강제 종료 뒤 이전 또는 새 완전 상태로 수렴한다.
7. health bind/DB/runtime/API 실패가 compatible N으로 rollback하고 log를 남기며, Windows에서 실행 중/locked core는 삭제하지 않는다.
8. DB compatible migration, incompatible migration의 backup restore, service write 후 forward-recovery와 data integrity matrix가 통과한다.
9. uninstall이 core/PATH marker만 제거하고 data/keychain을 보존하며, `--delete-data` 이중 확인만 데이터를 지운다.
10. N+2 종료 후 collector를 다시 실행했을 때 protected current, rollback, 실행 중 core/runtime 외 완전 세대가 없다.

### 2단계 추가 gate

실제 quarantine attribute가 있는 notarized DMG를 clean macOS machine에서 offline 설치해 stapled ticket, drag-to-Applications, Finder/Spotlight/Dock 실행을 검사한다. 앱 이동·이름 변경, core 없음/손상, compatible/incompatible rollback, 최근 프로젝트와 folder picker, ready 뒤 browser open, app/CLI version 일치를 포함한다. `codesign`, `spctl`, `stapler` 검증과 CLI ACP regression을 모두 통과해야 한다.

### 승격 순서

1. CI가 한 commit에서 target 자산을 한 번만 빌드하고 hash를 고정한다.
2. maintainer dogfood용 prerelease에서 install/update/rollback과 security logs를 확인한다.
3. 같은 bytes를 재빌드하지 않고 public prerelease로 확대한다. 사용자가 명시적으로 보낸 진단 외 unique device ID나 강제 telemetry를 rollout에 쓰지 않는다.
4. 정해진 soak 기간에 새 blocker, data loss, signature/rollback 실패가 없고 위 matrix가 모두 통과해야 동일 asset hash를 stable manifest로 승격한다.
5. stable은 처음에는 수동 `update check` release note로 공지한 뒤 기본 24시간 check에 노출한다. 문제 발생 시 잘못된 manifest를 조용히 바꾸지 않고 더 높은 signed recovery release를 낸다.

모든 gate 결과는 release에 target, asset hash, schema 범위, test run과 signing/notarization 상태로 기록한다. prerelease 실패 자산을 stable tag에서 다시 서명하거나 교체해 이력을 덮어쓰지 않는다.

## 단계 전환 조건

1단계 완료 조건:

- 지원 플랫폼에서 portable → 설치 마이그레이션이 멱등적이다.
- CLI와 ACP가 고정 진입점을 통해 기존과 동일하게 동작한다.
- N → N+1 → N+2 업데이트, 실패 rollback, current/rollback 두 세대 정리가 검증된다.
- DB migration 호환성에 따라 자동 rollback 허용 여부를 판단한다.
- 미서명 배포의 OS 경고와 사용자의 명시적 승인 흐름이 문서화되어 있다.

2단계 진입 조건:

- 1단계 설치·업데이트 계약이 안정화되어 `.app`이 재사용할 수 있다.
- Apple Developer ID 서명, notarization, stapling과 Gatekeeper 검증이 릴리스 게이트다.
- `.app`과 CLI가 동일한 current core를 사용한다는 종단 테스트가 있다.
- DMG 설치, 앱 이동, core 미설치, 손상 및 rollback 상태의 UX가 정의되어 있다.

## 릴리스·버전·신뢰 계약

릴리스 태그는 `v<SemVer>` 형식이다. 패키징 작업은 태그에서 선행 `v`를 제거한 실제 버전, 채널과 `<platform>-<arch>` target을 SEA의 `release/info.json` 자산으로 주입한다. `context-agent --version`은 이 값들을 출력한다. 수동 workflow artifact는 `0.0.0-dev`, `prerelease`로 식별해 stable 업데이트 후보가 되지 않는다.

지원 자산 이름은 다음과 같이 결정적으로 만든다.

- `context-agent-v<VERSION>-darwin-arm64.tar.gz`
- `context-agent-v<VERSION>-win32-x64.zip`

`release-manifest.json`은 schema version, SemVer, stable/prerelease 채널, 게시 시각, 최소 updater 버전, DB 호환성, target별 이름·URL·byte 크기·SHA-256을 담는다. 키를 정렬한 canonical JSON bytes 전체를 Ed25519로 서명하고 `{ keyId, signature }`를 `release-manifest.json.sig`로 배포한다. updater는 내장된 `keyId → public key` 집합으로 먼저 서명을 검증한 뒤 채널, 다운그레이드, 최소 updater와 target 정책을 적용한다.

키 교체는 기존 릴리스에서 기존 키와 다음 공개 키를 함께 신뢰하도록 updater를 먼저 배포한 뒤 다음 키로 서명하는 2단계로 한다. 정상 회전 중에는 두 공개 키를 한 릴리스 이상 겹쳐 유지한다. 개인 키 유출 시에는 해당 key ID를 폐기한 새 updater를 OS 코드 서명된 복구 배포로 제공하며, 유출 키로 서명된 일반 자동 업데이트를 신뢰 회복 수단으로 사용하지 않는다. 개인 키는 저장소와 릴리스 자산에 두지 않는다.

## 책임 경계

| 구성 요소         | 책임                                                          | 책임지지 않는 것                                        |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| portable SEA      | 현재 위치 실행, 명시적 설치 시작                              | 무단 자기 이동, 무단 PATH 변경, 자기 파일 자동 덮어쓰기 |
| 설치 관리자       | 버전별 core, current/rollback, 고정 진입점, 제거              | 사용자 데이터의 암묵적 삭제                             |
| core              | 웹 서버, 브라우저 실행, ACP, 업데이트 확인·검증·health report | 실행 중 자기 바이너리 덮어쓰기                          |
| CLI 진입점        | current core 실행, 인자·stdio·종료 코드 전달                  | 별도 앱 상태 또는 별도 업데이트 채널                    |
| macOS `.app`      | Finder/Dock 실행, 프로젝트 선택, 서버·브라우저 시작           | 별도 core, ACP stdio, 독립적인 current                  |
| 릴리스 파이프라인 | 플랫폼 자산, 매니페스트 및 서명, 코드 서명 게이트             | GitHub 체크섬만으로 업데이트 신뢰 확립                  |
