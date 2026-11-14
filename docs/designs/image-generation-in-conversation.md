# 생성한 이미지를 대화에 남기는 설계

작성 2026-11-15. Plan 011의 산출물이다. 코드는 커밋 `d65cc285` 기준으로 읽었다. 이 문서는 설계만 담고 코드를 고치지 않는다. 사용자가 6절의 질문에 답하면 그 답으로 구현 계획을 따로 쓴다.

코드 경로는 저장소 루트 기준이다. `chat-panel.tsx` 같은 이름만 있는 경로는 `apps/agent/app/entry/chat/`, `use-image-generation.ts`는 `apps/agent/app/entry/media/`, `attachments.ts`와 `previews.ts`는 `packages/memory-agent/src/attachments/`, `image-media.ts`·`image-router.ts`·`image-contracts.ts`는 `packages/memory-agent/src/providers/`, `chat.ts`는 `packages/memory-agent/src/agent/`, `record.ts`와 `nodes.ts`는 `packages/memory-agent/src/memory/`, `loop/store.ts`는 `packages/memory-agent/src/loop/store.ts`, `snapshot.ts`는 `packages/memory-agent/src/chat-state/`, `schema.ts`는 `packages/memory-agent/src/chat-store/`에 있다. `btw/`, `queue/`, `model/`, `work-trace/`, `memory/`로 시작하는 경로는 `packages/memory-agent/src/` 아래다. 로컬 DB 수치는 사용자 한 명의 `~/.context-generactive-agent/agent.db`를 2026-11-15에 읽기 전용으로 센 값이다. 대화 내용과 프롬프트는 읽지 않았다. 이미지 API는 부르지 않았다.

## 1. 요약

만든 이미지는 입력창 위에 한 번 보일 뿐 대화 기록에 들어가지 않는다. 게다가 어디에도 묶이지 않은 첨부로 저장되므로, 코드를 읽은 결과 앱을 다시 시작하면 파일이 지워진다. 모델이 알아서 부르는 도구(방법 B)보다, 사용자가 보낸 프롬프트로 서버가 직접 생성하고 그 결과를 대화에 도구 호출과 결과 모양으로 적는 방법(방법 A)을 권한다. 방법 A는 지금의 승인 창과 `ImageMediaWorkflow`를 바꾸지 않아서 `providers/README.md`의 이미지 불변식 다섯 항목을 그대로 지킨다. 어느 방법이든 먼저 첨부를 대화 node에 묶어야 하며, 같은 원인으로 `draw` skill의 그림도 지워지고 있는 것으로 보인다.

## 2. 지금 동작

### 2.1 이미지 생성 버튼을 켜고 보내면

1. 입력창의 이미지 생성 버튼이 `imageIntent`를 켠다(`chat-composer.tsx:330-364`). 설정에서 이미지 생성을 켜야 눌린다(`chat-composer.tsx:338`).
2. 보내기에서 답변 중이 아니고 이미지 생성 의도가 켜져 있으면 갈린다. 첨부가 있으면 막고, 없으면 "이미지를 만들까요?" 창을 연다(`chat-panel.tsx:957-962`, 창은 `chat-panel.tsx:1197-1225`).
3. "만들기"는 `generateImage`(`chat-panel.tsx:849-855`)를 부르고, 이것이 `useMutation`(`use-image-generation.ts:16-46`)과 `api.generateImage(prompt, true)`(`apps/agent/app/entry/api.ts:777-788`)를 거쳐 `POST /api/media/image`(`packages/memory-agent/src/api/app-api/media.ts:46`)로 간다. 요청 본문에는 대화 id가 없다(`packages/memory-agent/src/api/app-api/media.ts:13-19`).
4. handler는 앱의 기본 선택 모델로 시작 경로 `chat:<provider>:<model>`을 적고 `workflow.generate`를 부른다(`apps/agent/app/.server/api/media.ts:16-29`).
5. `ImageMediaWorkflow.generate`는 이 순서로 한다. 승인 확인(`image-media.ts:250-253`), 경로 고르기(`:282-292`), 이미지 컨텍스트 게이트(`:293-301`), 교차 공급자 동의 확인(`:302-348`), 실행(`:369-377`), 출력 검사(`:378-386`), 첨부 저장 `attachments.save`(`:387-393`), 결과 반환(`:394-405`).
6. 응답은 mutation의 `data`가 되고(`use-image-generation.ts:72`), 입력창 위의 `GeneratedImage`로 그려진다(`chat-composer.tsx:225`, 컴포넌트는 `:41-70`). 성공하면 `clearComposer`가 입력창을 비운다(`chat-panel.tsx:853`, `:842-847`).

### 2.2 대화 기록에 쓰는 것

없다. 위 흐름이 DB에 쓰는 것은 `attachments.save`가 만드는 `attachments` 행과 파일뿐이다(`attachments.ts:301-336`). 워크플로가 받는 서비스에는 노드나 대화 저장소가 없고, 첨부는 `Pick<AttachmentsApi, "save">`로만 받는다(`image-media.ts:219-227`, `:242`). handler도 `ActiveProvider`와 `ImageMediaWorkflow`만 쓴다(`apps/agent/app/.server/api/media.ts:9-11`). 그래서 `chat_thread_messages`, `chat_thread_display_messages`, `nodes` 어느 것에도 쓰이지 않는다.

### 2.3 프롬프트 글자

프롬프트는 요청 본문으로 서버에 가고 어디에도 저장되지 않는다(2.2). 입력창에는 성공할 때만 지워진다. 취소하거나 실패하면 입력창에 그대로 남는다(`chat-panel.tsx:849-855`, `docs/decisions.md:3665`).

### 2.4 채팅 run의 다른 경로 (`chat.ts:1614`)

run이 `forwardedProps.imageIntent === "generate_image"`를 받는 경로가 있다(`chat.ts:1614`). 지금 화면은 이 값을 run에 싣지 않는다. `sendMessage(content)`는 두 번째 인자 없이 불린다(`chat-panel.tsx:955`). `use-agent-chat.ts:102`는 인자를 받을 수 있지만 보내는 곳이 없다. `imageIntent`라는 이름은 스키마(`packages/memory-agent/src/api/chat-api.ts:128`), 이 경로(`chat.ts:1614`), 입력창 props에만 나온다. 값이 오더라도 이미지는 만들어지지 않는다.

- OpenAI 호환 공급자와 리포트 대화는 거절한다(`chat.ts:1615-1618`).
- 설정이 꺼져 있으면 경로를 고르지 않고 이미지 없는 일반 대화로 진행한다(`chat.ts:1620-1635`).
- 켜져 있는데 경로가 없으면 `image_route_unavailable`로 거절한다(`chat.ts:1645-1646`).
- 고른 경로가 직접 실행이면 `image_direct_workflow_required`로 거절한다(`chat.ts:1648-1652`).
- 공급자 도구는 `provider_tool` 경로일 때만 주입된다(`chat.ts:1643-1644`). 그 계약은 unverified이고 비활성이라(`image-contracts.ts:64-72`, `providers/README.md:50`) 부적격 사유로 걸러진다(`image-router.ts:216-218`).

그러므로 지금 실제로 이미지를 만드는 길은 2.1의 직접 생성 하나다.

### 2.5 생성한 이미지는 살아남는가

어디에도 묶이지 않은 첨부를 지우는 문장은 `deleteOrphans`다(`attachments.ts:143-152`). `node_attachments`, `btw_attachments`, `queued_message_attachments` 세 표 중 어디에도 그 첨부의 행이 없으면 지운다. 만든 지 얼마가 지나야 한다는 조건은 없다(`created_at`을 보지 않는다). 파일은 `purgeOrphans`가 함께 지운다(`attachments.ts:417-436`).

- `attachments.save`는 이 세 표에 행을 만들지 않는다(`attachments.ts:301-336`).
- 첨부를 묶는 `link`(`attachments.ts:394`)를 부르는 곳은 사용자 턴을 기록하는 세 곳뿐이다(`chat.ts:1472`, `queue/delivery.ts:63`, `btw/chat.ts:185`).
- 정리가 도는 때는 앱이 시작할 때(`chat.ts:665`), 대화 삭제가 끝났을 때(`chat.ts:2640`), BTW 스레드를 지울 때(`btw/store.ts:201`)다. 계획 문구의 "보관"은 틀렸다. 보관(archive)은 정리를 돌리지 않는다. 정리는 삭제가 끝났을 때만 돈다(`chat.ts:2580-2599`는 보관, `:2640`은 삭제).

**결론**: 생성한 이미지는 앱을 다시 시작하면 지워진다. 근거는 `attachments.ts:143-152`(지우는 조건), `attachments.ts:301-336`(저장은 연결을 만들지 않음), `chat.ts:665`(시작 때 정리)다. 코드를 읽어 낸 결론이고, 실제로 지워지는 것을 재현해 보지는 않았다.

로컬 DB에서 같은 조건으로 센 값은 이렇다. `attachments` 11개, 어디에도 묶이지 않은 것 0개, `node_attachments` 11행이다. 시작 때 이미 비워진 상태이므로 결론과 어긋나지 않지만, 이 숫자만으로 결론이 증명되지는 않는다.

### 2.6 같은 원인으로 draw skill의 그림도 지워진다

`write_file`·`edit_file`이 SVG를 쓰면 `saveDrawing`이 그림을 첨부로 저장하고 결과에 `preview { attachmentId }`를 붙인다(`previews.ts:39-47`, `:65-91`). `saveDrawing`은 `save`를 부를 뿐(`attachments.ts:373`) 어디에도 묶지 않는다. 결정은 "파일이 나중에 고쳐지거나 지워져도 그때 그린 그림이 남아야 한다"였다(`docs/decisions.md:1550`). 정리 조건 때문에 이 뜻이 지켜지지 않는 것으로 보인다. 로컬 DB에는 `preview.attachmentId`를 가진 저장된 도구 결과가 1건 있고, 그 첨부는 `attachments`에 없다. 한 건뿐이라 단정하지는 않는다. 같은 원인으로 보이고, 방법 B는 이 문제를 그대로 물려받는다.

## 3. 방법

두 방법 모두 `ImageMediaWorkflow`를 그대로 쓴다. 다른 점은 누가 부르느냐(사용자가 보낸 요청이 서버 경로로 바로 가는가, 모델이 도구로 부르는가)와 대화 기록에 어떻게 적히느냐다.

저장 계층 확인: 모델이 만들지 않은 메시지를 적는 길은 있다. `RunStore.saveThread(threadId, messages)`는 run과 묶여 있지 않고 메시지 목록 전체를 받아 바뀐 꼬리만 다시 쓴다(`loop/store.ts:251-286`). 시작 때 복원도 run 없이 메시지 행을 넣는다(`packages/memory-agent/src/chat-state/chat-state.ts:65`). 그래서 방법 A의 전제는 성립한다.

### 방법 A. 대화에 묶인 직접 생성

화면은 지금처럼 버튼과 확인 창으로 요청한다. 요청이 대화 id와 페이지 holder를 싣는 새 경로(`POST /api/sessions/:session/images`)로 간다. 서버는 이 순서로 한다.

1. holder가 그 대화를 쥐고 있는지 보고(`chat.ts:1296`), run이 돌고 있으면 `run_in_progress`로 거절한다(`chat.ts:1310`). 생성하는 동안 그 대화를 점유해 run이 끼어들지 못하게 한다(`chat.ts:1553`의 `liveRuns.claim`과 같은 방식).
2. `ImageMediaWorkflow.generate`를 지금과 같은 인자로 부른다.
3. 사용자 node(프롬프트), `tool_call` node, `tool_result` node를 적고(`record.ts:163-236`의 모양), 첨부를 `tool_result` node에 `attachments.link`로 묶는다.
4. `saveThread`로 메시지 세 개를 이어 쓴다. 사용자 메시지(프롬프트), assistant 메시지(도구 호출 `generate_image`, 글은 비움), tool 메시지(결과 JSON에 `preview { attachmentId, mimeType }`와 경로·모델 정보).

모델은 부르지 않는다. 메시지를 도구 호출과 결과 모양으로 적는 까닭은 저장 모양을 바꾸지 않고 지금 화면이 이미 그림을 보이는 길을 쓰기 위해서다. assistant 메시지는 글만 담을 수 있고(`schema.ts:75`), 이미지 부분은 user와 tool 내용에만 있다(`schema.ts:15`, `:26`). 화면은 `preview`가 든 JSON 결과 아래에 그림을 그린다(`message.tsx:269-286`, `:684`, `:700`).

### 방법 B. 채팅 run 안의 도구

이미지 생성을 모델이 부르는 도구 `generate_image`로 둔다. 사용자가 버튼을 켜고 보낸 턴에서만 도구가 보이고, 호출마다 승인 카드를 거친다. 결과는 `draw`처럼 도구 카드 아래에 그림으로 보인다. 화면이 `imageIntent`를 run에 실어야 하고(`chat-panel.tsx:955`), 서버는 지금 거절하는 자리(`chat.ts:1648-1652`)에서 도구를 주입하게 바뀐다.

### 열한 가지 답

| #   | 질문             | 방법 A                                                                                                                                                                                                                                                                                                                                                                                                                                    | 방법 B                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 기록             | `saveThread`로 메시지 세 개를 이어 쓴다(`loop/store.ts:251-286`). 화면 메시지 묶기는 같은 호출이 다시 한다(`:280-283`). 새 메시지 모양은 없다. `ImagePart`는 assistant 메시지에 쓸 수 없다(`schema.ts:15`, `:75`). 화면 메시지 규칙과 맞는다. 사용자 메시지가 새 화면 메시지를 시작하고 assistant와 tool 결과가 한 묶음이 된다(`chat-state/README.md:33-35`, `docs/decisions.md:3863`).                                                   | run이 이미 쓰는 표들에 쓴다. 결과 JSON은 A와 같은 모양이다. 화면 메시지 규칙과 맞는다.                                                                                                                                                                                                                                                        |
| 2   | 첨부             | `tool_result` node에 `link`해서 정리 조건을 벗어난다(`attachments.ts:394`). 대화 삭제는 그 node의 연결을 지우고(`work-trace/store.ts:1413`) 정리가 파일을 지운다. 저장과 연결이 한 요청 안에서 이어진다.                                                                                                                                                                                                                                  | `tool_result` node는 도구가 끝난 뒤 `record.ts:224`에서 생기므로 도구 안에서 묶지 못한다. 기록 쪽에 묶는 단계를 더해야 한다. 저장과 연결 사이가 한 step 길이로 벌어진다.                                                                                                                                                                      |
| 3   | 다시 열기        | 새로고침과 이전 쪽 불러오기에서 보인다. 저장된 메시지를 읽는다(`snapshot.ts:58-77`, `:92-103`). 다른 탭의 읽기 전용 화면은 소유 탭이 run을 시작하거나 끝낼 때만 다시 마운트된다(`apps/agent/app/entry/chat/README.md:11`). 생성은 run이 아니라서 다시 열 때까지 안 보인다.                                                                                                                                                                | 같다. 다만 run이 시작되고 끝나므로 읽기 전용 탭도 따라온다.                                                                                                                                                                                                                                                                                   |
| 4   | 기억             | 사용자 node의 프롬프트는 임베딩 대상이고(`memory/quality.ts:29`) 해석 작업이 생긴다(`nodes.ts:208`, `:385`). 해석은 모델 호출이다. `tool_call`·`tool_result` node는 증거로만 남는다.                                                                                                                                                                                                                                                      | 사용자 턴 node는 같다(`chat.ts:1465-1470`). 도구 node는 `record.ts`가 만든다. 모델의 마지막 답도 node가 된다.                                                                                                                                                                                                                                 |
| 5   | 다음 턴          | 모델은 그림을 못 본다. tool 메시지 내용이 JSON 글자라서 프롬프트와 결과 글자만 본다. 이미지 부분을 넣으면 replay가 이미지를 넣어 주지만(`attachments/model-images.ts:88-110`) 화면이 JSON을 못 읽는다. 이미지 부분은 `[image]` 글자로 바뀐다(`snapshot.ts:58-61`). 첫 버전은 못 보는 것으로 둔다.                                                                                                                                         | 같다. 같은 step 안에서 모델이 결과를 어떻게 받는지는 확인 못 함.                                                                                                                                                                                                                                                                              |
| 6   | 승인과 돈        | 지금의 확인 창이 `approved: true`를 보낸다(`chat-panel.tsx:1197-1225`). 교차 공급자 창도 그대로다(`use-image-generation.ts:23-41`). 워크플로가 그대로라서 불변식 다섯 항목이 모두 유지된다(`image-media.ts:250-253`, `:293-301`, `:302-348`, `:349-377`, `providers/README.md:50-54`). 탈락 아님.                                                                                                                                         | 호출마다 승인 카드로 `approved`를 받으면 지킨다. 교차 공급자 승인은 interrupt 종류가 `tool_call`과 `permission_review` 둘뿐이라(`schema.ts:142-164`) 새 종류가 필요하다. 권한 모드가 full이면 승인 없이 도는 도구가 있으므로(`chat.ts:295`) 이미지 도구는 모드와 상관없이 늘 승인하게 해야 한다. 지킬 수 있지만 새 규칙이 둘 든다. 탈락 아님. |
| 7   | 한 대화 한 run   | 서버가 run이 돌고 있으면 거절하고(`chat.ts:1310`) 생성 동안 점유한다. 화면은 지금처럼 답변 중에 막는다(`chat-panel.tsx:964-967`). 생성 중인 동안 일반 메시지 보내기도 막아야 한다. `chat-panel.tsx`에서 `media.generating`을 쓰는 곳은 입력창 props 전달뿐이라(`chat-panel.tsx:1171`) 보내기에는 이 막음이 없다. 대기열에는 이미지 요청을 넣지 않는다.                                                                                    | 한 run 안이라 겹치지 않는다. 답변 중 요청은 지금처럼 막는다.                                                                                                                                                                                                                                                                                  |
| 8   | 모델 고르기      | Plan 008 전에는 앱의 기본 선택이다(`apps/agent/app/.server/api/media.ts:16-26`). 008이 들어가면 대화의 모델이다. 008은 이 문서를 쓴 시점에 들어가 있지 않다(`packages/memory-agent/src/sessions/sessions.ts`에 모델 필드가 없다). 호환 공급자 대화는 동의 쌍이 없어 `consent_disabled`로 막힌다(`image-media.ts:318-321`). 설정 화면은 `anthropic->openai` 쌍만 보인다(`apps/agent/app/entry/settings/pages/image.tsx:157`). 그대로 둔다. | 호환 공급자는 `chat.ts:1615-1616`이 그대로 거절한다. 도구 호출을 하는 모델이어야만 쓴다. 그대로 둔다.                                                                                                                                                                                                                                         |
| 9   | 화면             | 입력창 위의 `GeneratedImage`와 "생성하고 있습니다…" 줄은 없앤다. 생성 중에는 대화 끝에 임시 줄을 보이고(화면 상태 `media.generating`), 끝나면 대화를 다시 읽어 실제 메시지로 바꾼다. 경로·비용 줄은 도구 카드에서 읽는다.                                                                                                                                                                                                                 | 도구 카드의 진행 상태가 생성 중 표시를 맡는다(`message.tsx`의 `callStatus`). 입력창 위 두 요소는 없앤다.                                                                                                                                                                                                                                      |
| 10  | 바꿀 파일과 크기 | 서버: `chat.ts` 또는 새 서비스 파일(점유·노드·`saveThread`), `api/app-api/sessions.ts`(새 경로), `.server/api` handler, `apps/agent/app/entry/api.ts`. 화면: `use-image-generation.ts`, `chat-panel.tsx`, `chat-composer.tsx`, `message.tsx`(아래 풀이 참고), `toolLabels`. 새 표나 migration 없음. **L**                                                                                                                                 | `record.ts`, `tools/definitions.ts`와 새 도구 서비스, `chat.ts:1648-1652`, interrupt 스키마(`schema.ts:142-164`)와 승인 카드, `chat-panel.tsx:955`, `message.tsx`, 입력창. 새 표나 migration 없음(interrupt payload는 JSON). **L**                                                                                                            |
| 11  | 깨질 수 있는 것  | 생성 직후 다른 대화 삭제가 정리를 돌려 이미지를 지움. `saveThread`가 다른 writer와 겹침(`loop/store.ts:263-265`). 두 탭이 동시에 생성. 모델이 쓰지 않은 도구 호출 기록을 공급자가 받는가(확인 못 함). 시험: 점유와 거절, 메시지 세 개 저장, 정리 뒤에도 남음, 승인 없으면 `image_approval_required`, 기존 워크플로 시험은 그대로.                                                                                                         | 모델이 프롬프트를 바꿈. 모델이 같은 도구를 반복 호출. 도구 호출이 안 되는 모델. 새 interrupt 종류의 재개. 도구 안 묶기 틈. 시험은 이 항목들.                                                                                                                                                                                                  |

### 풀이

**A의 메시지 모양과 화면.** 화면은 도구 결과가 `path`와 `preview.attachmentId`를 가진 JSON일 때만 그림을 그린다(`message.tsx:269-276`). `path`가 필수라서 생성한 이미지에는 `path`를 선택으로 풀어야 한다. 도구 이름 `generate_image`는 `toolLabels`에 새로 넣어야 자연스럽다(`message.tsx:57`, `:125`). 안 넣으면 어떻게 그리는지는 확인 못 함.

**A의 위험.** assistant의 도구 호출 이름 `generate_image`는 그 run의 도구 목록에 없다. 모델 쪽 replay는 `source`가 없는 assistant 메시지를 다른 모델의 것으로 보지 않고 그대로 보낸다(`model/history.ts:43-47`). OpenAI와 Anthropic이 목록에 없는 도구 이름의 과거 호출을 받는지는 확인 못 함. 확인은 돈이 들지 않는 일반 채팅 호출로 할 수 있다. 받지 않으면 replay에서 이 쌍을 일반 글로 바꾸는 방법이 남는다.

**A의 다른 탭.** 생성은 run이 아니라서 읽기 전용 탭이 못 따라온다. 해결하려면 생성도 `chat_runs` 행을 남기는 run으로 만들어야 한다. 이는 첫 버전보다 크다(질문 5).

**B가 얻는 것.** 이미 있는 run 기록, 도구 카드, 읽기 전용 탭 따라오기를 쓴다. 그러나 이미지 생성은 지금도 명시적 의도가 있는 요청에서만 허용된다(`image-feature.ts:41`). 모델이 대화 중에 알아서 부르는 것은 정책이 아니다. B는 이 정책을 바꾸지 않고는 A보다 얻는 것이 적다. 모델이 프롬프트를 다시 쓰고 모델 토큰이 더 드는 것은 B의 값이다.

## 4. 권하는 방법과 까닭

**방법 A를 권한다.** 까닭은 넷이다.

1. 유료 호출의 입력이 사용자가 쓴 글 그대로다. 모델이 끼지 않아서 프롬프트가 바뀌거나 반복 호출될 일이 없다.
2. 워크플로와 승인 흐름을 바꾸지 않는다. 불변식 다섯 항목(`providers/README.md:50-54`)이 그대로 지켜진다. 승인 창과 교차 공급자 동의 창은 이미 있다.
3. 도구 호출을 못 하는 모델이든 어느 모델이든 쓸 수 있다.
4. 방법 B의 큰 몫(새 interrupt 종류, 도구 안 묶기)이 A에는 없다.

A의 값은 둘이다. 대화 기록에 모델이 하지 않은 도구 호출이 적히고, 다른 탭이 다시 열 때까지 못 본다.

**어느 방법이든 먼저 한다**: 도구 결과의 첨부를 node에 묶는 일이다. 방법 A는 새 서비스에서 직접 묶지만, draw 그림은 별도 고침이 필요하다(2.6). 이 고침은 이 설계와 독립된 첫 커밋이다.

## 5. 곁가지

### 5.1 이미지를 붙인 요청 (이미지 고치기)

이번 범위에 넣지 않고 계속 막는다. 직접 실행기는 텍스트 프롬프트만 `images/generations`로 보낸다(`image-media.ts:103-108`). 워크플로는 원본 이미지 수를 항상 0으로 적는다(`image-media.ts:285`). 라우터는 `edit`을 알고 있지만(`image-router.ts:26-28`, `:219-225`) 편집 요청을 보내는 코드가 없다. 문구는 사실에 맞게 "이미지를 붙인 채로는 아직 이미지를 만들 수 없습니다. 첨부를 지우고 다시 보내 주십시오."로 바꾼다. 바꿀 곳은 `chat-panel.tsx:958-959`와 한국어 번역 카탈로그(`lingui extract`가 쓰는 `.po`)다.

### 5.2 사용량 표시

지금은 항상 비어 있다. 실행기는 응답에서 `data`만 읽고(`image-media.ts:34-36`, `:139-147`) 결과에 `usage`를 담지 않는다(`image-media.ts:148-153`). 예상 비용도 라우트 사실이 `estimatedCostUsd`를 주지 않아(`image-router.ts:157-168`) 늘 "예상 비용 미확인"으로 나온다. 그러므로 `JSON.stringify(image.usage)`(`chat-composer.tsx:47`, `:62-66`)로 그리는 줄은 죽은 줄이다. 권하는 처리: 첫 버전에서 사용량 줄을 지우고, 비용 줄은 알 수 있을 때만 보인다. 사용량을 보이려면 실행기가 응답의 사용량을 읽어야 한다. 이미지 모델 응답의 사용량이 이름 → 숫자의 평평한 표인지는 실제 호출 없이는 확인 못 함. 평평하지 않으면 `Schema.Record(Schema.String, Schema.Finite)`(`image-media-contracts.ts:34`)에 안 맞으므로 최상위 숫자 세 개만 읽는 식으로 정한다. 이 일은 구현 순서의 마지막으로 미룬다. 바꿀 파일은 `chat-composer.tsx`다.

### 5.3 키 유무

설정의 상태 응답은 켜짐 여부와 동의 쌍만 담는다(`packages/memory-agent/src/api/app-api/settings.ts:98-102`, 조립은 `apps/agent/app/.server/api/settings.ts:82-87`). OpenAI API 키는 생성할 때 서버 환경 변수에서 읽는다(`image-media.ts:83`). 그런데 경로 카탈로그는 이미 키가 있는지 안다. 직접 경로의 `authentication.verified`가 `Option.isSome(openAIKey)`다(`route-catalog.ts:307-323`, `:335-342`). 권하는 처리: `ImageSettings`에 키가 설정됐는지를 나타내는 불리언 필드 하나를 더하고, 값은 직접 경로의 `authentication.verified`에서 얻는다. 키의 값은 어디에도 싣지 않는다. 설정 화면의 이미지 쪽(`settings/pages/image.tsx:95`, `:130`)에 "키 없음" 배지를 보이고, 입력창 버튼의 안내 문구도 키가 없으면 그렇게 말한다. 키는 앱을 시작한 환경의 변수 `OPENAI_API_KEY`이므로 안내 문구는 그 이름을 말한다. 바꿀 파일은 `settings.ts`(계약), `.server/api/settings.ts`, `settings/pages/image.tsx`, `chat-composer.tsx`다.

### 5.4 켜지 않았을 때의 버튼

지금은 설정이 꺼져도 설정을 읽은 뒤에는 버튼이 꺼진 채 자리를 차지한다(`chat-composer.tsx:330-364`). 권하는 처리: 설정이 꺼져 있으면 버튼을 숨기고, 켜져 있는데 키가 없으면 보이되 꺼 두고 까닭을 말한다. 안내가 필요하면 설정 화면의 설명이 맡는다(`settings/pages/image.tsx:120-124`, `:135-141`). Plan 009가 입력창 아래줄에 선택기를 더하면 이 버튼은 그 줄의 맨 앞이다. 숨기는 규칙은 그 계획과 겹치지 않는다. 바꿀 파일은 `chat-composer.tsx`다.

## 6. 사용자가 정할 것

1. **방법 A와 B 중 어느 쪽인가?** 권하는 답: A. 사용자가 쓴 글 그대로 유료 호출하고, 워크플로와 승인 흐름이 그대로이며, 도구를 못 쓰는 모델에서도 된다.
2. **다음 턴에 모델이 만든 이미지를 보게 할까?** 권하는 답: 첫 버전은 아니오. 보이게 하려면 결과 내용을 JSON 글자에서 이미지 부분으로 바꿔야 하고, 화면의 그림 표시도 함께 바뀐다. 이미지 고치기(5.1)와 같이 다음 단계에서 한다.
3. **프롬프트를 기억에 남기고 해석 모델을 돌릴까?** 권하는 답: 예. 프롬프트는 사용자의 말이라서 사용자 node로 남긴다. 그러면 해석 작업이 생겨 모델을 한 번 더 부른다(`nodes.ts:385`). 도구 호출과 결과 node는 증거로만 남는다. 해석을 원치 않으면 프롬프트를 도구 호출의 인수로만 남기고 사용자 node를 만들지 않는 길이 있다. 그 경우 이미지 프롬프트는 검색에 안 잡힌다.
4. **이미지를 붙인 요청(이미지 고치기)을 이번 범위에 넣을까?** 권하는 답: 아니오. 직접 실행기가 편집 요청을 보내지 못한다(5.1). 문구만 사실에 맞게 바꾼다.
5. **생성을 다른 탭이 따라오게 하려고 run으로 만들까?** 권하는 답: 아니오. 첫 버전은 생성한 탭에서만 바로 보이고 다른 탭은 다시 열면 보인다. 같은 대화를 두 탭에서 쓰는 일이 드물고, run으로 만들면 서버 변경이 커진다.

## 7. 구현 순서 어림

방법 A 기준이다. 사용자가 방법을 고르면 이 순서가 다음 계획의 재료다. 각 단계는 따로 커밋한다.

1. **도구 결과의 첨부를 node에 묶는다 (독립).** draw 그림이 정리에서 지워지는 것을 고친다. 바꿀 파일: `previews.ts`, `record.ts`(결과 node를 만들 때 `preview` 첨부를 그 node에 묶음). 확인: 첨부 정리 시험에서 `preview`가 든 결과의 그림이 `purgeOrphans` 뒤에도 남는다. `vp run memory-agent#test:unit` 중 `attachments`와 `record` 시험.
2. **서버: 세션 이미지 생성.** 점유·holder 확인, `ImageMediaWorkflow.generate` 호출, 사용자·도구 node 기록과 `link`, `saveThread`로 메시지 세 개 쓰기, 새 경로와 `api.ts` 클라이언트. 바꿀 파일: `chat.ts` 또는 새 서비스, `api/app-api/sessions.ts`, `.server/api`, `entry/api.ts`. 확인: 새 서비스 시험(run이 있으면 거절, 메시지 세 개 저장, 정리 뒤에도 남음, 승인 없으면 `image_approval_required`), 기존 워크플로 시험 그대로, `vp run memory-agent#typecheck`.
3. **공급자 호환 확인.** 목록에 없는 도구 이름의 과거 호출이 든 대화를 돈이 들지 않는 일반 채팅으로 OpenAI와 Anthropic에 이어 보낸다. 안 되면 `model/history.ts`의 replay가 이 쌍을 일반 글로 바꾸게 한다. 확인: 실제 호출 결과와 replay 시험.
4. **화면.** 메시지 그림에서 `path` 선택화와 `toolLabels` 추가(`message.tsx`), 생성 중 임시 줄과 다시 읽기(`chat-panel.tsx`, `use-image-generation.ts`), 입력창 위 `GeneratedImage`와 진행 줄 제거(`chat-composer.tsx`), 생성 중 보내기 막기, 문구와 `.po`. 확인: 브라우저 시험(`message.browser.tsx`, `chat-panel.browser.tsx`)과 `vp check`.
5. **곁가지.** 사용량 줄 제거, 키 필드 추가와 배지, 버튼 숨김, 이미지 붙임 문구. 확인: 설정 상태 응답 시험, 입력창 시험(`chat-composer.test.tsx`).
6. **문서.** `docs/decisions.md`에 사용자가 고른 결정을 날짜와 함께 적고, `media`·`attachments`·`providers` README를 고친다. 확인: `node lint/wording/check/main.ts check`.
