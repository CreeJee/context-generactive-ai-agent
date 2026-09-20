# TanStack AI Provider Tools inventory

> 조사일 2026-09-20 · 설치 기준 `@tanstack/ai@0.55.0`, `@tanstack/ai-openai@0.22.8`, `@tanstack/ai-anthropic@0.18.7`

## 판정 원칙

근거는 TanStack CLI JSON 문서, 설치 package의 `tools/index.d.ts`, factory declaration/source map, `model-meta.d.ts`, adapter converter다. 도구는 다음 교집합만 노출한다.

1. 설치 adapter의 `/tools` subpath가 factory를 export한다.
2. 선택 model의 `supports.tools`가 kind를 포함한다.
3. 현재 account/API transport/region/beta entitlement가 지원한다.
4. 앱과 사용자 정책이 허용한다.

Model metadata는 allowlist의 상한이지 실제 account availability의 증명이 아니다. Unknown model/account 및 `tools: []`은 fail-closed한다.

`ProviderTool<P,K>`는 일반 `Tool`에 타입 전용 provider/kind brand를 더한 계약이다. Runtime에서는 factory별 tool name과 `metadata.__kind` discriminator를 사용한다(예: OpenAI 이미지 도구는 `name: "image_generation"`, `__kind: "openai.image_generation"`). 타입 brand 자체를 runtime 필드로 가정하지 않는다. Provider Tool factory에는 앱 실행 함수나 `needsApproval` 입력이 없으므로, 노출 전 policy와 caller-loop action 실행 직전 interrupt 승인은 앱 runtime 책임이다.

## OpenAI: export된 11개 Provider Tool factory

| Kind / factory                                         | 주요 입력                                                                    | 실행·결과                                                 | 권한·sandbox 제약                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `custom` / `customTool(config)`                        | provider raw custom grammar/name/format                                      | provider-specific custom input/output                     | 설치 model metadata에 kind가 없으면 fail-closed; 별도 schema·실행 정책    |
| `web_search` / `webSearchTool(config?)`                | external access, allowed domains(최대 100), context size, user location      | provider-hosted; search call/source metadata              | network egress, domain allowlist, query audit                             |
| `web_search_preview` / `webSearchPreviewTool(config?)` | context size, location                                                       | provider-hosted preview                                   | legacy/preview; 정식 search 미지원 모델에만 제한                          |
| `file_search` / `fileSearchTool(config)`               | `vector_store_ids` 필수, filters, max results, ranking                       | hosted vector search; `include: file_search_call.results` | account/vector-store ACL, tenant data boundary                            |
| `image_generation` / `imageGenerationTool(config?)`    | action, fidelity, format, compression, moderation, quality, size, background | hosted image call/result, base64 가능                     | 비용·장기 실행·대용량; direct image adapter route와 분리                  |
| `code_interpreter` / `codeInterpreterTool(config)`     | container id 또는 auto + files/memory limit                                  | hosted sandbox; outputs include 가능                      | file/code egress, budget, provider container lifecycle                    |
| `mcp` / `mcpTool(config)`                              | label, URL/connector, OAuth token, headers, allowed tools, approval policy   | provider가 remote MCP 호출 또는 approval 요청             | trusted servers, scoped token, remote side-effect approval                |
| `computer_use` / `computerUseTool(config)`             | display dimensions, browser/mac/windows/ubuntu                               | **caller-loop** action/screenshot                         | isolated desktop/browser, sensitive-screen deny, action approval          |
| `local_shell` / `localShellTool()`                     | 없음                                                                         | **caller-loop** command/result                            | host 금지, workspace sandbox, allow/deny, timeout                         |
| `shell` / `shellTool(config?)`                         | environment/container reference                                              | **caller-loop** remote/container shell                    | process/network/file limits, approval                                     |
| `apply_patch` / `applyPatchTool()`                     | 없음                                                                         | **caller-loop** patch/result                              | canonical workspace, symlink block, diff approval, optimistic concurrency |

### OpenAI 모델 지원

설치 `OpenAIChatModelToolCapabilitiesByName`의 exact tuple을 runtime table과 동기화한다. 관찰된 패턴:

- full: search/preview, file, image, code interpreter, MCP, computer, local shell, shell, patch (`custom`은 installed model metadata에 없으므로 별도 runtime 증거 전까지 제외)
- hosted subset: search/preview, file, image, code interpreter, MCP
- execution subset: file, code interpreter, MCP, local shell, shell, patch
- `computer-use-preview`: `computer_use`만
- search-preview models: `web_search_preview`만
- 일부 legacy/audio/chat models: `tools: []`

모델 이름으로 capability를 추정하지 않는다. 설치 metadata에는 공식 문서 조회 시점보다 최신 id도 있으므로 account discovery와 반드시 교차 검증한다.

### OpenAI streaming / usage / abort

Responses tool events를 AG-UI `TOOL_CALL_START/ARGS/END/RESULT`와 provider metadata로 정규화한다. Web sources, file results, code outputs, computer screenshot URL은 provider `include`가 있어야 완전할 수 있다. Request `AbortSignal`은 SDK signal로 전달하되 이미 발생한 side effect는 rollback되지 않는다. Input/output/total tokens를 보존하고 도구별 요청/비용은 provider가 제공할 때만 기록하며 추정하지 않는다.

## Anthropic: 8개 factory export 중 native Provider Tool 7개

`customTool`은 `/tools`에서 export되지만 일반 caller-defined `Tool`을 반환하고 Anthropic native runtime discriminator 목록에도 `custom`이 없으므로 모델 capability registry에서는 제외한다. 나머지 converter/read helper export는 factory가 아니다.

| Kind / factory                                           | 주요 입력                                           | 실행·결과                                                  | 권한·sandbox 제약                                                |
| -------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `web_search` / `webSearchTool(config)`                   | versioned config, max uses/domain/location policy   | server tool; `server_tool_use` + search result metadata    | network/query egress, domain policy                              |
| `web_fetch` / `webFetchTool(config?)`                    | factory-fixed type/name + provider URL/filter/limit | server tool; fetch result metadata                         | URL allowlist, private-address/SSRF block                        |
| `code_execution` / `codeExecutionTool(config, options?)` | versioned config; hosted skills 최대 8개            | hosted container; adapter가 beta와 `container.skills` 설정 | file/network/budget policy, skill entitlement                    |
| `computer_use` / `computerUseTool(config)`               | versioned config, display dimensions                | **caller-loop** action/result                              | isolated desktop/browser, action approval                        |
| `bash` / `bashTool(config)`                              | versioned bash config                               | **caller-loop** command/result                             | host 금지, command policy, sandbox, timeout                      |
| `text_editor` / `textEditorTool(config)`                 | versioned editor config                             | **caller-loop** file action/result                         | root/path/symlink guard, patch approval                          |
| `memory` / `memoryTool(config?)`                         | versioned config; default 허용                      | **caller-loop** memory command/result; storage는 앱 제공   | principal namespace, retention, export/delete, injection defense |

### Anthropic 모델 지원

설치 metadata에서 다음 full tuple을 선언한 모델만 7개 전체의 후보가 된다.

`web_search`, `web_fetch`, `code_execution`, `computer_use`, `bash`, `text_editor`, `memory`

Claude 4.1/4.5/4.6/4.7/4.8 계열과 일부 5 계열이 이를 선언한다. 다음은 설치 metadata가 명시적으로 `tools: []`이므로 차단한다.

- `claude-opus-5`
- `claude-opus-5-fast`
- `claude-fable-5-1`

외부 문서나 이름만으로 override하지 않으며 metadata 갱신 또는 별도 runtime capability 증거 전까지 fail-closed한다.

### Anthropic streaming / usage / abort

Web search/fetch의 `server_tool_use`는 `providerExecuted: true`, result block type/result metadata와 함께 저장되어 재개 시 use/result block을 재구성한다. Caller-loop 도구는 일반 tool-use로 stream되고 앱 결과가 후속 message에 들어간다. Request signal은 SDK `signal`로 전달되지만 side-effect 보상은 앱 책임이다. Input/output/total 및 cache write/read tokens를 보존하고 `server_tool_use.web_search_requests`와 `web_fetch_requests`를 `providerUsageDetails.serverToolUse`로 보존한다.

## 앱 capability 매핑

| Capability                 | OpenAI             | Anthropic                              | 최소 정책                                        |
| -------------------------- | ------------------ | -------------------------------------- | ------------------------------------------------ |
| `network.search`           | web search/preview | web search                             | query egress, domains, per-run limit             |
| `network.fetch`            | MCP/caller tool    | web fetch                              | URL allowlist, private-address block             |
| `data.provider_files.read` | file search        | 없음                                   | provider account/vector-store ACL                |
| `execution.hosted_code`    | code interpreter   | code execution                         | files/skills/network/budget                      |
| `execution.shell`          | local shell, shell | bash                                   | app sandbox, host deny, approval                 |
| `computer.control`         | computer use       | computer use                           | isolated session, approval, screenshot redaction |
| `filesystem.write`         | apply patch        | text editor                            | root scope, symlink defense, diff approval       |
| `memory.read/write`        | app tool/MCP       | memory                                 | principal scope, purpose, retention, delete      |
| `media.image.generate`     | image generation   | 없음                                   | chat-tool/direct-adapter route 분리              |
| `integration.mcp.remote`   | MCP                | provider option MCP(별도 factory 아님) | trusted registry, token scope, remote approval   |

## 승인과 sandbox

노출 전 provider/model/account/tenant/user/conversation 정책의 교집합을 계산한다. Credentials, OAuth token, MCP headers는 tool metadata/UI/log에 넣지 않는다. Provider-hosted라도 data egress 또는 고비용 작업은 run-level 승인을 적용할 수 있다.

Action-level interrupt가 필요한 기본 집합:

- OpenAI: `computer_use`, `local_shell`, `shell`, `apply_patch`, remote MCP approval
- Anthropic: `computer_use`, `bash`, `text_editor`, `memory` write/delete

승인의 current source of truth는 `RUN_FINISHED.outcome.type === 'interrupt'`다. Legacy `approval-requested` custom event는 replay 호환으로만 취급한다.

Shell/code/file/computer는 host와 사용자 desktop에서 분리하며 canonical workspace, symlink escape 방지, read/write mount와 env allowlist, CPU/memory/time/output/network budget을 강제한다. Abort/timeout 시 process tree와 browser session을 정리한다. Input, 승인 주체, policy decision, result digest, usage는 감사하되 secret과 image/base64 payload는 redact한다.

## 구현 acceptance checklist

- [ ] 18개 native kind(OpenAI 11 + Anthropic 7)를 registry에 명시한다. 현재 registry의 OpenAI `custom` 누락은 PTOOLS-02에서 보완한다.
- [ ] package factory export와 registry 누락을 type/test로 검출한다. 최신 OpenAI `custom` export 회귀 검사를 PTOOLS-02에서 추가한다.
- [x] model metadata와 account capability 교집합만 노출한다.
- [x] provider-hosted/caller-loop를 구분한다.
- [x] tool별 input validation, result normalization, usage, abort 계약을 둔다.
- [x] tool별 side effect, approval, sandbox, data-egress 정책을 둔다.
- [x] `image_generation` Provider Tool과 direct image adapter route를 분리한다.
- [x] unknown 또는 `tools: []` 모델을 fail-closed한다.
- [x] search/fetch usage 및 source/result metadata를 손실 없이 보존한다.

## TanStack CLI JSON 문서 조회

제거된 TanStack 문서 MCP 대신 공식 CLI의 JSON 출력을 사용한다. 프로젝트에 CLI를 상시 의존성으로 추가하지 않고, 조사한 CLI 버전을 고정해 실행한다.

```sh
pnpm dlx @tanstack/cli@0.71.0 libraries --json
pnpm dlx @tanstack/cli@0.71.0 search-docs \
  "provider tools anthropic openai migration" --library ai --limit 20 --json
pnpm dlx @tanstack/cli@0.71.0 doc ai migration/migration --json
```

`doc`의 문법은 `tanstack doc <library> <path> --json`이다. 따라서 `tanstack doc query framework/react/overview --json`에서 `query`는 subcommand가 아니라 library ID다. AI 문서는 먼저 `search-docs --library ai --json`으로 canonical path를 찾은 뒤 `doc ai <path> --json`으로 가져온다.

자동화는 JSON parse 실패, non-zero exit와 빈 검색 결과를 서로 구분한다. 검색이 비어 있거나 최신 문서만 제공될 때는 설치 package의 `exports`, `.d.ts`, source map과 model metadata를 기준으로 대조하며, 비공식 MCP endpoint를 fallback으로 등록하지 않는다.

## Package family와 Anthropic OAuth 통합 결정

2026-09-20 registry 기준 최신 peer-compatible family는 core `@tanstack/ai@0.55.0`, client `0.32.1`, compaction `0.1.3`, MCP `0.4.0`, OpenAI `0.22.8`, Anthropic `0.18.7`, persistence `0.6.0`, React `0.27.0`이다. Core-coupled packages는 모두 `@tanstack/ai ^0.55.0`을 선언하며 lockfile은 단일 core에 해석된다.

공식 Anthropic adapter는 API key `ClientOptions` 또는 SDK-compatible `beta.messages.create` client를 받는다. 현재 subscription OAuth transport는 access-token refresh, 고정 endpoint, Claude Code session/request headers, provider body 변환과 raw SSE 정규화를 함께 담당하므로 공식 adapter config로 단순 교체하지 않는다. 기존 `SubscriptionTextAdapter`를 보존하고 Provider Tool의 factory metadata와 provider wire format은 별도의 OAuth-preserving Effect bridge에서 명시적으로 변환한다. 공식 adapter의 `createAnthropicChatWithClient`는 향후 SDK-compatible messages client를 완전히 구현했을 때만 대체 후보로 삼는다.

Migration guide 기준 확인 항목은 activity별 adapter 분리, common option flattening, `providerOptions`→`modelOptions`, `toResponseStream`→`toServerSentEventsStream`, sampling option의 `modelOptions` 이동과 Provider Tools의 `/tools` subpath다. OpenAI·Anthropic Provider Tools는 신규 export이므로 기존 import를 깨지 않지만, model metadata에 따른 tool type gating을 적용해야 한다. 자동 적용할 일반 codemod는 확인되지 않아 typecheck와 source 검색으로 마이그레이션한다.

## 2026-09-20 출시 검증 기록

- TanStack 문서 조회는 제거된 MCP endpoint가 아니라 공식 CLI의 `tanstack doc query`, `tanstack search-docs`, `tanstack libraries` JSON 출력으로 전환했다.
- 호환 package family는 `@tanstack/ai@0.55.0`, `@tanstack/ai-openai@0.22.8`, `@tanstack/ai-anthropic@0.18.7`이며 lockfile을 함께 갱신했다.
- Provider Tool은 package export, model metadata, account capability, 앱 정책과 사용자 정책의 교집합만 노출한다. Unknown model/account, 빈 capability 및 미검증 entitlement는 차단한다.
- 전체 이미지 기능은 `CONTEXT_AGENT_IMAGE_GENERATION=1`일 때만 사용할 수 있다. 사용자 이미지 생성 toggle과 별개인 Provider Tool toggle은 기본 비활성이다.
- OpenAI direct image route는 API key만으로 활성화하지 않는다. 운영자가 account/region/결제 자격을 확인한 뒤 `CONTEXT_AGENT_OPENAI_IMAGE_VERIFIED=1`을 설정해야 한다.
- 이미지 turn이 아닌 일반 대화에는 image Provider Tool schema와 workflow prompt를 넣지 않는다. 세 gate가 모두 열린 Provider Tool turn만 공식 schema를 주입한다.
- 기본 이미지 실행은 chat tool context와 분리된 direct media workflow다. 유료 실행 전 명시적 승인을 요구하며, 실패 후 다른 유료 route로 자동 전환하지 않고 대안을 사용자 확인 대상으로 반환한다.
- 생성 payload는 최대 25 MiB와 PNG/JPEG/WebP로 제한하고 durable attachment로 저장한다. UI와 결과에는 initiator chat model, executor media route/model, execution mode, 예상 비용, provider usage/request id를 가능한 범위에서 구분해 기록한다.
- Anthropic은 설치 adapter에 image generation factory가 없어 이미지 실행 route를 제공하지 않는다. OpenAI에서도 account verification 또는 capability가 없으면 route 상태는 unavailable이다.
- 모델 의존 기능의 rollout은 설정 UI에서 global → provider → capability 순서로 켠다. 저장된 설정은 매 모델 요청과 실행 직전에 다시 읽으므로 프로세스 재시작이 필요 없고, ON은 다음 메시지부터 적용된다.
- rollback은 capability, provider 또는 global flag를 끄는 방식으로 수행한다. OFF는 다음 요청의 schema/route 후보를 제거하며 이미 노출됐지만 아직 실행되지 않은 호출도 같은 서버 정책의 실행 직전 재검증에서 거절한다. 진행 중인 provider 요청의 입력은 소급 변경하지 않는다.
- 환경 변수 기반 build/runtime capability(`CONTEXT_AGENT_IMAGE_GENERATION`, 검증된 image entitlement)는 서버 시작 시 읽으므로 이 값만 변경할 때는 재시작이 필요하다. 저장형 사용자 flag만 바꿀 때는 재시작하지 않는다.

## Cross-provider media consent

Anthropic 대화에서 OpenAI 이미지 adapter를 실행하는 것은 Anthropic native 이미지 기능이 아니다. Initiator는 Claude chat route이고 executor와 usage 귀속은 OpenAI media route/account다. 이미지 프롬프트가 OpenAI로 전송되므로 로그인과 entitlement만으로 실행 동의를 추론하지 않는다.

저장 키는 `initiatorProvider -> executorProvider : capability`의 exact tuple이고 현재 capability는 `media.image.generate`다. 기본값과 누락/읽기 실패는 `disabled`로 fail-closed한다.

- `disabled`: route scoring 전에 후보에서 제거한다.
- `ask`: 선택 결과에 승인이 필요함을 표시하고, run id + initiator chat route + executor media route + exact capability에 묶인 이번 실행 승인만 받는다. 다른 run/route/capability 승인과 조작된 값은 거절한다.
- `always`: exact provider pair와 capability에만 저장하며 다른 media capability로 확장하지 않는다.

실행 직전에 저장 consent를 다시 읽는다. 승인 이후 철회됐거나 읽기에 실패하면 provider 요청 전에 중단한다. 실패 후 다른 유료 route로 조용히 fallback하지 않는다. 설정 UI와 실행 승인 UI는 Claude가 이미지를 생성한다고 표현하지 않으며, OpenAI로의 prompt 전송과 OpenAI 계정 usage 귀속을 승인 전에 표시한다.

실제 유료 API smoke는 2026-09-20의 기존 OpenAI 이미지/OpenAI 검색/Anthropic streaming 성공 근거를 재사용한다. Cross-provider consent 검증은 contract/integration test로 수행하며 별도 사용자 승인 없이 추가 과금 호출을 실행하지 않는다.

- capability matrix는 위 OpenAI 11개/Anthropic 7개 표와 설치 package exports를 기준으로 한다. 미등록 capability, model metadata에 없는 tool, 미확인 account entitlement, unknown cost의 비용 제한 route는 fail-closed다.
- 최종 `pnpm ready`가 format/lint/typecheck, 전체 테스트, client/server build와 darwin-arm64 packaging을 모두 통과했다. 별도 전체 workspace 실행에서도 63개 test file, 414개 test가 통과했다.
