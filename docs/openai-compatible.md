# OpenAI 호환 엔드포인트 검토 (2026-10-04)

LM Studio와 vLLM은 동일한 `openai-compatible` provider로 연결한다. 제품의 provider 식별자는 API 프로토콜이나 서버 제품명을 뜻하지 않는다. LM Studio·vLLM별 provider 식별자를 추가하거나 호환 endpoint를 `openai` 구독 계정으로 취급하지 않는다.

## 연결 계약

| 항목             | 현재 구현                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| API base URL     | `/v1`을 포함한 URL. LM Studio 예: `http://localhost:1234/v1`, vLLM 예: `http://localhost:8000/v1` (실제 서버 포트·경로에 맞게 설정) |
| 모델 조회        | `GET {baseUrl}/models`의 `data[].id`. 모델 ID 수동 입력도 가능                                                                      |
| 연결 테스트      | 비스트리밍 `POST {baseUrl}/chat/completions`. 응답 choices가 있는지만 확인                                                          |
| 채팅             | TanStack AI의 OpenAI compatible Chat Completions 어댑터로 SSE 스트리밍                                                              |
| 인증             | 키가 있으면 Bearer 헤더, 없으면 Authorization 헤더를 생략. 키는 endpoint에 묶어 keychain에 저장                                     |
| 일반 도구        | 설정의 `toolCalling`을 켰을 때 function tool schema 전달 및 tool-call 스트림 처리                                                   |
| 제공자 전용 도구 | OpenAI·Anthropic의 native tool registry만 지원. 프로토콜 호환으로 web search·file search·hosted execution 권한을 추론하지 않음      |
| context window   | 사용자 설정값. 모델 목록에서 서버의 실제 로드 context나 tokenizer를 자동 탐지하지 않음                                              |
| 출력 예산        | `max_tokens`로 전송하고 입력 예산에서 차감                                                                                          |
| reasoning 출력   | 서버의 `reasoning_content`·`reasoning` 스트림을 추론 내용으로 표시하고 저장·복원                                                    |
| reasoning 강도   | 모델별 공개 metadata로 옵션 자동 조회. 서버 기본값은 `reasoning_effort` 생략                                                        |
| 이미지 입력      | 현재 호환 provider의 모델 계약에서 비활성화                                                                                         |

현재 연결 테스트 성공은 스트리밍·function calling·모델별 context window 검증을 뜻하지 않는다. `signed-in` 상태 역시 endpoint 설정이 존재한다는 의미이며 실제 서버 접속이나 인증 성공의 증거로 사용하지 않는다. Route catalog에서도 인증의 `verified`는 false이며 모델 접근 근거는 `endpoint_configuration`·`unverified`로 표시한다.

## 서버별 확인 사항

[LM Studio 공식 호환 API 문서](https://lmstudio.ai/docs/developer/openai-compat)는 `/v1/models`, `/v1/chat/completions`, `/v1/responses` 등을 제공한다. 현재 제품은 Chat Completions 경로를 사용한다. [도구 호출 문서](https://lmstudio.ai/docs/developer/openai-compat/tools)에 따르면 모델의 template과 출력 형식을 이용해 function call을 파싱한다. 파싱되지 않은 호출은 일반 content로 돌아올 수 있어, endpoint 연결 성공만으로 해당 모델의 도구 호출 능력을 판단할 수 없다.

[vLLM 공식 서버 문서](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)의 Chat Completions API는 chat template이 있는 생성 모델을 대상으로 한다. [자동 도구 호출 문서](https://docs.vllm.ai/en/latest/features/tool_calling/)에 따라 `--enable-auto-tool-choice`와 모델에 맞는 `--tool-call-parser`를 설정하고, 필요하면 tool history를 처리하는 `--chat-template`도 지정해야 한다. parser와 모델에 따라 strict schema·병렬 호출 지원이 다르므로 일괄적인 OpenAI 기능 동등성을 가정하지 않는다.

## 타입 경계

`ProviderId`는 저장된 모델 연결을 찾는 식별자다. 세 문자열을 회사 이름의 집합으로 해석하지 않는다. 도메인 코드는 `providerConnection(id)`로 연결 정보를 해석한 뒤 태그에 따라 분기한다.

| 개념                         | 표현                                                                   | 의미                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 저장된 모델 연결             | `ProviderId`                                                           | 기존 설정·DB·API가 사용하는 연결 식별자                                               |
| 구독 연결                    | `{ type: "subscription", accountProvider }`                            | OAuth account를 제공하는 vendor가 존재                                                |
| 호환 endpoint 연결           | `{ type: "compatible-endpoint", protocol: "openai-chat-completions" }` | API 프로토콜만 알려져 있고 구독 account vendor는 없음                                 |
| 회사·native schema namespace | `ProviderVendor`                                                       | `openai` 또는 `anthropic`. OpenAI 프로토콜을 쓰는 서버가 OpenAI 회사가 되는 것은 아님 |
| 전용 도구 지원               | `{ type: "vendor-native", vendor }` 또는 `{ type: "unsupported" }`     | 연결 종류·일반 function calling과 별도로 결정                                         |

`ProviderConnection`은 서로소 유니온이다. 호환 endpoint variant에 `accountProvider`가 없으므로 OAuth 계정으로 사용할 수 없다. 채팅 runtime은 연결 종류로, route catalog는 `nativeTools.type`으로 `switch` 분기한다. 현재 호환 endpoint의 전용 도구 지원은 `unsupported`다.

`SubscriptionAccountProvider`는 구독 구현이 받는 account vendor namespace이며 `OAuthProvider`가 이를 사용한다. `ProviderToolVendor`는 native tool schema의 vendor namespace다. 기존의 `SubscriptionProviderId`·`NativeToolProviderId`라는 연결 ID 부분집합 이름은 제거했다.

`SubscriptionModelSelection`은 구독 어댑터의 선택 계약이며 usage·공통 모델 선택·chat route·이미지 승인 initiator는 저장된 전체 연결 ID를 사용한다. chat route 인증 표시는 구독 `subscription_oauth`, 호환 endpoint `openai_compatible`, 직접 이미지 API `openai_api_key`다.

## 검증 범위

로컬 HTTP fixture에서 모델 조회, Chat Completions 요청 경로·출력 예산·헤더, SSE 텍스트 및 분할 function call 스트림, 도구 비활성화와 context 제한을 검증한다. 모델 provider와 OAuth/native tool provider의 타입·schema 경계, 호환 모델 ID가 OpenAI 모델과 같아도 native tool route가 생기지 않는 동작을 검증한다.

앞선 구현에서 실제 LM Studio의 전용 metadata 조회와 `reasoning_effort: none`을 지정한 짧은 스트리밍 완료 응답을 확인했다. 현재 구현은 전용 metadata 조회를 제거했으며 `/models` 정보만 사용한다. 모델 로드, tool result를 포함한 왕복 호출, tokenizer 기준 context 제한, 긴 스트림 취소와 실제 vLLM 서버 호출은 이번 검증에 포함하지 않았다.

## 추론 지원 범위

서버가 별도 reasoning 필드를 보내는 경우를 지원한다. 일반 content에 포함된 `<think>` 태그를 임의로 추론으로 파싱하지 않는다. 서버 기본값(`default`)은 추론 비활성화가 아니며, 추론 토큰도 최대 출력 예산을 사용한다.

[vLLM 추론 문서](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)의 최신 필드는 `reasoning`이고 이전 필드는 `reasoning_content`다. 모델에 맞는 `--reasoning-parser`와 chat template 설정이 필요하다. LM Studio의 모델별 추론 활성화는 서버 설정을 따른다. 추론 출력 지원과 강도 선택 지원을 구분하며, 강도 목록이 없더라도 서버가 보내는 추론 내용은 표시·저장한다.

### 서버 구현과 모델 지원 정보 탐지

[OpenAI `/models` 표준](https://developers.openai.com/api/reference/resources/models/methods/list)은 추론 강도나 서버 구현을 열거하지 않는다. `owned_by`는 모델 소유자다. 따라서 포트·모델 이름·`organization_owner`로 서버를 추측하지 않는다.

`/models` 응답을 먼저 확인하며, 비표준 확장 `capabilities.reasoning.allowed_options`가 있으면 알려진 Chat Completions 강도를 직접 사용한다. [OpenRouter처럼 `supported_parameters`를 제공하는 서버](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)는 추론 지원 여부만 확인하고, 그 필드만으로 레벨이나 요청 파라미터 변환을 만들어내지 않는다.

모델별 강도 정보가 없으면 `reasoning_effort`를 보내지 않고 서버 기본 동작을 따른다. 강도를 선택할 수 없을 때 UI의 강도 선택기를 숨긴다. 서버 종류를 URL·포트·소유자 필드로 추측하거나 LM Studio `/api/v1/models`를 자동 조회하지 않는다. 이전 전용 조회에서 저장된 강도 정보도 사용하지 않으며, 다음 모델 목록 조회 성공 시 정리한다.
