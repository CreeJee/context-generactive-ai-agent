# attachments

## Overview

`packages/memory-agent/src/attachments`는 대화에 올린 이미지 첨부를 다룬다. 첨부는 바이트의 sha256 주소로 저장하고, 메타데이터는 SQLite `attachments` 표에 둔다. 모델에 보낼 축소 WebP 사본도 만든다.

`model-images.ts`는 `RunHook`을 제공한다. 이 hook은 모델 요청 직전에 저장된 transcript의 `/api/attachments/<id>` 이미지 URL을 inline base64 데이터로 바꾼다. `previews.ts`는 `DrawingPreviews` 서비스를 제공한다. `write_file`/`edit_file` 도구가 SVG를 쓰면 이 서비스가 그 그림을 첨부로 저장하고 결과에 `preview`를 덧붙인다. `urls.ts`는 브라우저와 서버가 공유하는 첨부 URL 규약이다.

## Interface

- `Attachments` — `Context.Service` 클래스. 대화에 올린 이미지를 다룬다. `Attachments.layer`로 제공하고 `make`로 만든다
- `AttachmentsApi` — `Attachments` 서비스 API 타입. 확인한 멤버는 `get(id)`(없거나 id 형식이 틀리면 null), `forModel(attachment)`(모델용 `ModelImage`), `dataUrl(image)`(base64 data URL), `saveDrawing(svg)`(SVG를 그림 첨부로 저장, `previews.ts`가 사용)이다. 업로드 저장, purge 등 나머지 멤버는 scout가 읽지 않았다
- `Attachment` — Schema.Struct `{ id(sha256 hex), mimeType, bytes, createdAt }`와 같은 이름의 타입. `AttachmentMimeType`과 함께 서버 코드를 import하지 않는 `contracts.ts`에 있고, `attachments.ts`가 다시 내보낸다
- `AttachmentMimeType` — `image/png`·`image/jpeg`·`image/gif`·`image/webp` Schema.Literals
- `AttachmentRejected` — TaggedError. reason은 `empty` | `too_large` | `unsupported_type`
- `AttachmentStorageFailed` — TaggedError. operation은 `save` | `purge` | `convert`, cause는 Defect
- `sniffImageType(bytes)` — 파일 시그니처 바이트로 실제 이미지 타입을 판별한다. 일치하지 않으면 null
- `isAttachmentId(id)` — `/^[0-9a-f]{64}$/` 검사
- `maxAttachmentBytes` — 업로드 최대 크기 20MiB
- `modelImageEdge` (2048) / `maxModelImageBytes` (2MiB) — 모델용 사본의 최대 변 길이와 목표 바이트 상한
- `maxDrawingBytes` — 그림으로 바꿀 SVG의 최대 크기 2MiB
- `ModelImage` — 모델로 보낼 이미지 `{ path, mimeType }` 인터페이스
- `modelImagesHook(attachments)` — `RunHook`. `request` 단계에서 history의 비-assistant 메시지 이미지 URL 파트를 inline data 이미지로 바꾼다. 첨부가 없으면 `[Attached image is unavailable.]` 텍스트로 바꾼다
- `DrawingPreviews` — `Context.Service`(`memory-agent/attachments/previews/DrawingPreviews`). `DrawingPreviews.layer`로 제공하며 `Attachments`와 `FileSystem`이 필요하다. API는 `withPreviews(project, tools)`
- `DrawingPreview` — `{ attachmentId, mimeType }` 인터페이스. 도구 결과의 `preview` 필드 모양이다
- `attachmentUrl(id)` — `/api/attachments/<id>` URL을 만든다
- `attachmentIdOf(url)` — 이 접두사와 64자리 hex id일 때만 id를 돌려주고, 아니면 null
- 하위 디렉터리 없음

## Invariants

- 첨부 id는 바이트의 sha256 hex(64자)다. `isAttachmentId`를 통과하지 못한 id는 파일시스템과 DB에 닿지 않는다. `get`은 바로 null을 돌려준다
- 선언된 MIME 타입은 믿지 않는다. 실제 타입은 `sniffImageType`의 시그니처 판별로 정한다. WebP는 offset 0의 RIFF와 offset 8의 WEBP가 모두 맞아야 한다
- 고아 첨부 삭제(`deleteOrphans`)는 판단과 삭제를 한 SQL 문(`DELETE ... WHERE NOT EXISTS node_attachments AND NOT EXISTS btw_attachments RETURNING *`)으로 한다. 그 사이에 추가된 링크의 blob이 지워지지 않게 하기 위해서다. 첨부를 참조하는 표는 `node_attachments`와 `btw_attachments` 두 곳이다
- 모델용 사본 파일 경로는 `<id>.model.webp`다. 변환해도 이득이 없었다는 marker는 `<id>.model-original` 빈 파일이다. GIF는 애니메이션 보존을 위해 변환하지 않고 원본을 쓴다
- 변환 결과가 원본 바이트 이상이면 marker를 남기고 원본을 보낸다. 기존 사본이 `maxModelImageBytes`보다 크면 지우고 다시 만든다
- 적응형 인코딩은 2048/q86, 1600/q78, 1280/q70, 1024/q64 순서로 시도한다. 작은 시도는 앞 결과가 아직 `maxModelImageBytes`를 넘을 때만 실행한다
- Sharp 변환은 프로세스 공용 Semaphore(`maxConcurrentImageConversions` = 2)로 동시성을 제한한다
- 같은 첨부의 동시 변환은 `SynchronizedRef<HashMap<id, Fiber>>`로 하나의 fiber로 합친다. 변환 fiber는 서비스 `Scope`에 fork하고 uninterruptible로 돌린다(중간 중단이 안전하지 않아서). map에서는 ensuring으로 제거한다
- 파일 publish는 고유 임시 파일(`<dest>.<uuidv4>.tmp`, flag `wx`, mode 0o600)에 쓴 뒤 rename으로 원자적으로 바꾼다. 임시 파일은 release에서 지운다. 이 과정 전체가 uninterruptible이다
- 변환 실패 시에는 원본을 보낸다. 로그에는 `attachment_conversion_failed`와 operation 태그만 남긴다. 경로나 Sharp 메시지는 로그에 남기지 않는다
- 첨부 디렉터리는 `<StorageRoot>/attachments`(mode 0o700)이고 파일은 mode 0o600이다
- `make`에는 `Scope.Scope`, `SqlClient`, `StorageRoot`, `FileSystem`, `Path`, `Crypto`가 필요하다
- `DrawingPreviews`는 SVG를 도구와 같은 `resolveProjectPath`/`readFileBytesEffect({checkLeaf: true})` 검사로 다시 읽는다. 그래서 나중에 바꿔 끼운 링크는 거부된다
- preview는 부가 정보다. 실패하면 `drawing_preview_unavailable` debug 로그만 남긴다. 도구 원래 결과의 다른 필드는 바꾸지 않고 `preview`만 덧붙인다
- preview는 쓴 시점의 스냅샷이다. 노드가 불변이므로 파일이 나중에 수정되거나 삭제되어도 그림은 바뀌지 않는다
- 저장된 transcript는 브라우저용 상대 URL(`/api/attachments/<id>`)을 유지한다. inline 데이터 변환은 모델로 가는 사본에만 적용한다. 같은 id는 dedupe 후 한 번씩 병렬로 읽는다

## Side Effects

- SQLite 읽기: `attachments`, `node_attachments`, `nodes`(session_id, kind='user') 조회
- SQLite 쓰기: `attachments`에서 고아 행을 `DELETE ... RETURNING`으로 지운다. 업로드 저장 경로의 INSERT 여부는 scout가 확인하지 않았다
- 파일시스템: `<StorageRoot>/attachments` 디렉터리 생성
- 파일시스템: 모델용 `.model.webp` 사본과 `.model-original` marker 쓰기·삭제, 임시 파일 write/rename/remove, 원본 파일 stat/read
- 파일시스템: 도구가 쓴 프로젝트 SVG 파일 읽기(previews)
- 네이티브 모듈: `requireRuntime("sharp")`로 Sharp를 불러 이미지 회전·리사이즈·WebP 인코딩
- 동시성: Semaphore(2) 허가, 서비스 Scope에 변환 fiber fork, SynchronizedRef 상태
- 암호: `Crypto.randomUUIDv4`로 임시 파일 이름 생성
- 로그: `attachment_conversion_failed`(warning), `drawing_preview_unavailable`(debug)

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
