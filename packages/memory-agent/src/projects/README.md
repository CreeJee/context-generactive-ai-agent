# projects

## Overview

`packages/memory-agent/src/projects`는 UI에서 등록한 프로젝트 루트 폴더를 SQLite `projects` 표에 두고 관리하는 `Projects` Effect 서비스 하나(`projects.ts`)만 담는다. 세션·메모리·권한 grant는 모두 한 프로젝트에 속한다. 이 서비스는 프로젝트 목록 조회, 숨김과 복원, cross-recall 제외, 권한 모드(ask/auto/full) 설정을 맡는다. 루트를 새로 등록하면 파일·셸 도구가 닿는 범위가 넓어지므로, 등록 전에 실경로·디렉터리 여부·저장소 루트와의 겹침을 검사한다.

## Interface

- `Projects` — `Context.Service` 태그(`"memory-agent/projects/projects"`). 메서드는 `list`, `listAll`, `get(id)`, `add(requestedRoot)`, `setHidden(id, hidden)`, `setCrossRecallExcluded(id, excluded)`, `setPermissionMode(id, mode)`
- `Projects.layerNoDeps` — `Layer.effect(Projects, make)`. 필요한 의존성은 `FileSystem`, `Path`, `Crypto`, `SqlClient.SqlClient`, `StorageRoot`
- `Projects.layer` — `layerNoDeps`에 `NodeCrypto.layer`, `NodeFileSystem.layer`, `NodePath.layer`를 제공한 layer. `SqlClient`와 `StorageRoot`는 여전히 바깥에서 제공해야 함
- `Project` — 도메인 Schema(`id`, `root`, `name`, `crossRecallExcluded`, `permissionMode`, `createdAt`, `hiddenAt`)와 같은 이름의 타입
- `PermissionMode` — `Schema.Literals(["ask","auto","full"])`와 타입. ask는 매 호출을 사용자가 승인, auto는 분류기가 허용·질문·차단, full은 승인 없이 즉시 실행
- `ProjectRootRejected` — TaggedError. `reason`은 `not_found` | `not_directory` | `overlaps_storage` | `already_registered`
- `ProjectNotFound` — TaggedError(`id`). id로 조회하거나 바꿀 때 행이 없으면 실패
- `ProjectHostFailed` — TaggedError(`root`, `reason: ProjectHostReason`). 호스트 파일시스템이나 암호 API가 실패할 때 쓰임
- `ProjectHostReason` — `Schema.TaggedUnion`(`RealPathFailed` | `StatFailed` | `IdentityFailed`, 각각 `cause: Schema.Defect()`)
- 하위 디렉터리 없음

## Invariants

- DB는 `full` 권한 모드를 `permission_mode='auto'`과 `permission_full=1`의 조합으로 저장한다. 행을 읽을 때는 `permission_full===1`이면 `full`로, 아니면 `permission_mode`(ask/auto) 값으로 복원한다. `setPermissionMode`도 같은 매핑을 따른다.
- `cross_recall_excluded`, `permission_full` 컬럼은 0/1 정수다. 행 Schema(`ProjectRow`)는 이 컬럼을 `Schema.Literals([0,1])`로 디코드한다.
- `add` 흐름: `path.resolve`, `fs.realPath`(NotFound이면 `not_found`), `stat`(Directory가 아니면 `not_directory`), 저장소 루트 겹침 검사(`overlaps_storage`), UUIDv4 생성, INSERT 순서로 진행한다.
- `add`는 루트가 저장소 루트를 포함하거나 저장소 루트 안에 있으면 등록을 거부한다. 비교는 정규화한 실경로끼리 `path.relative`로 한다.
- 저장소 루트(`StorageRoot.path`)는 layer를 만들 때 한 번 정규화한다. 경로가 아직 없으면 존재하는 부모까지 올라가 `realPath`를 구한 뒤 남은 basename을 다시 붙인다.
- `projects.root`에는 UNIQUE 충돌 대상이 있어야 한다. INSERT가 `ON CONFLICT(root)`에 의존하기 때문이다. 숨긴 프로젝트를 다시 add하면 `hidden_at`만 NULL로 되돌린다(un-hide). 숨기지 않은 기존 루트를 add하면 RETURNING이 비어 `already_registered`로 실패한다.
- 숨기거나 cross-recall에서 제외한 프로젝트도 메모리를 그대로 가진다. 숨긴 프로젝트는 계속 검색되고, 제외한 프로젝트는 다른 프로젝트에서 검색되지 않는다(R08). `list`는 `hidden_at IS NULL`인 행만, `listAll`은 importer용으로 숨긴 행까지 돌려준다.
- 목록은 `ORDER BY created_at, id` 순서로 정렬된다.
- `id`는 `Crypto.randomUUIDv4`, 시각은 `Clock.currentTimeMillis`를 `DateTime.formatIso`로 바꾼 ISO 문자열이다.
- 새 프로젝트의 기본값은 `permissionMode: "ask"`, `crossRecallExcluded: false`이고, `name`은 루트의 basename이다(비어 있으면 root 전체).

## Side Effects

- SQLite `projects` 표 읽기: `SELECT * FROM projects`(id 조회, 전체 목록, 숨기지 않은 목록)
- SQLite `projects` 표 쓰기: `INSERT ... ON CONFLICT(root) DO UPDATE SET hidden_at = NULL ... RETURNING *`, `UPDATE`로 `hidden_at`, `cross_recall_excluded`, `permission_mode`/`permission_full` 변경
- 파일시스템 읽기: `fs.realPath`(layer 생성 때 저장소 루트를 정규화하고, add 때 요청 루트를 정규화), `fs.stat`(디렉터리 여부 확인)
- `Crypto.randomUUIDv4`로 프로젝트 id 생성
- `Clock.currentTimeMillis`로 `created_at`, `hidden_at` 시각을 읽음

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
