# api

## Overview

`apps/agent`의 `/api/*` React Router 리소스 라우트다. API는 거의 모두 Effect HttpApi 계약(`memory-agent/chat-api`의 `ChatApi`, `memory-agent/app-api`의 `AppApi`)으로 선언되어 있다. 이 디렉터리에는 그 계약으로 넘기는 splat 라우트 하나와, 계약으로 옮기지 않은 첨부 라우트 둘만 남는다(`docs/httpapi-migration.md`).

계약 endpoint의 경로·상태·거부 code는 `packages/memory-agent/src/api/README.md`에, handler는 `app/.server/api/README.md`에 있다.

## Interface

- `$.tsx` `loader`/`action` — 라우트 파일이 없는 `/api/*` 요청을 `~/.server/api`의 `serveApi`로 넘긴다. `ChatApi`와 `AppApi`가 web handler 하나로 답한다. React Router는 정적 경로를 splat보다 먼저 고르므로 아래 두 파일은 그대로 답한다.
- `attachments._index.tsx` `action` — POST /api/attachments: 원시 이미지 바이트를 content hash로 저장하고 201 `{ id, mimeType, bytes }`를 돌려준다(PNG/JPEG/GIF/WebP, 최대 `maxAttachmentBytes`). 거부는 `{ error: "attachment_rejected", reason }`이다.
- `attachments.$attachment.tsx` `loader` — GET /api/attachments/:attachment: 저장된 이미지 바이트를 immutable 캐시 헤더로 돌려준다. 실패 태그는 404 `attachment_not_found`, 500 `attachment_unreadable`이다.
- 하위 디렉터리 없음.

## Invariants

- 첨부는 HttpApi로 옮기지 않는다. 업로드는 본문을 읽기 전에 `Content-Length`를 `maxAttachmentBytes`와 비교해 413으로 거절한다. HttpApi는 handler보다 먼저 payload를 디코드하므로 큰 본문을 다 읽은 뒤에야 거절할 수 있다. 다운로드는 `<img src>`가 부르므로 계약으로 얻는 client가 없다.
- 업로드 `action`은 맨 먼저 `rejectCrossSite(request)`를 호출한다(`~/.server/http`, `SameSite` middleware와 같은 `crossSiteRefusal`). 다운로드 loader도 `Sec-Fetch-Site: cross-site`이면 403을 돌려준다. 이미지는 공개 자산이 아니라 대화 evidence다.
- 첨부는 content-addressed다. 같은 id는 같은 바이트이므로 `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`을 붙인다. `AttachmentRejected` reason이 `too_large`이면 413, 그 밖은 422다.
- 라우트는 Promise 경계일 뿐이다. 도메인 로직은 `~/.server/agent`의 `agent.runPromise` 안의 Effect로 실행한다.

## Side Effects

- 첨부 파일을 저장소에 쓰고 읽는다(`Attachments.save`, `Attachments.read`).
- `$.tsx`가 넘긴 요청의 부수 효과는 `app/.server/api/README.md`에 있다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
