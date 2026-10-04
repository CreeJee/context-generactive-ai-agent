# OpenAI 호환 엔드포인트 검토 (2026-10-04)

LM Studio와 vLLM은 동일한 `openai-compatible` provider로 연결한다. 제품의 provider 식별자는 API 프로토콜이나 서버 제품명을 뜻하지 않는다. LM Studio·vLLM별 provider 식별자를 추가하거나 호환 endpoint를 `openai` 구독 계정으로 취급하지 않는다.

## 연결 계약

| 항목                  | 현재 구현                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| API base URL          | `/v1`을 포함한 URL. LM Studio 예: `http://localhost:1234/v1`, vLLM 예: `http://localhost:8000/v1` (실제 서버 포트·경로에 맞게 설정) |
| 모델 조회             | `GET {baseUrl}/models`의 `data[].id`. 모델 ID 수동 입력도 가능                                                                      |
| 연결 테스트           | 비스트리밍 `POST {baseUrl}/chat/completions`. 응답 choices가 있는지만 확인                                                          |
| 채팅                  | TanStack AI의 OpenAI compatible Chat Completions 어댑터로 SSE 스트리밍                                                              |
| 인증                  | 키가 있으면 Bearer 헤더, 없으면 Authorization 헤더를 생략. 키는 endpoint에 묶어 keychain에 저장                                     |
| 일반 도구             | 설정의 `toolCalling`을 켰을 때 function tool schema 전달 및 tool-call 스트림 처리                                                   |
| 제공자 전용 도구      | OpenAI·Anthropic의 native tool registry만 지원. 프로토콜 호환으로 web search·file search·hosted execution 권한을 추론하지 않음      |
| context window        | 사용자 설정값. 모델 목록에서 서버의 실제 로드 context나 tokenizer를 자동 탐지하지 않음                                              |
| 출력 예산             | `max_tokens`로 전송하고 입력 예산에서 차감                                                                                          |
| reasoning·이미지 입력 | 현재 호환 provider의 모델 계약에서 비활성화. 서버 자체 지원 여부와 구분                                                             |

현재 연결 테스트 성공은 스트리밍·function calling·모델별 context window 검증을 뜻하지 않는다. `signed-in` 상태 역시 endpoint 설정이 존재한다는 의미이며 실제 서버 접속이나 인증 성공의 증거로 사용하지 않는다. Route catalog에서도 인증의 `verified`는 false이며 모델 접근 근거는 `endpoint_configuration`·`unverified`로 표시한다.

## 서버별 확인 사항

[LM Studio 공식 호환 API 문서](https://lmstudio.ai/docs/developer/openai-compat)는 `/v1/models`, `/v1/chat/completions`, `/v1/responses` 등을 제공한다. 현재 제품은 Chat Completions 경로를 사용한다. [도구 호출 문서](https://lmstudio.ai/docs/developer/openai-compat/tools)에 따르면 모델의 template과 출력 형식을 이용해 function call을 파싱한다. 파싱되지 않은 호출은 일반 content로 돌아올 수 있어, endpoint 연결 성공만으로 해당 모델의 도구 호출 능력을 판단할 수 없다.

[vLLM 공식 서버 문서](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)의 Chat Completions API는 chat template이 있는 생성 모델을 대상으로 한다. [자동 도구 호출 문서](https://docs.vllm.ai/en/latest/features/tool_calling/)에 따라 `--enable-auto-tool-choice`와 모델에 맞는 `--tool-call-parser`를 설정하고, 필요하면 tool history를 처리하는 `--chat-template`도 지정해야 한다. parser와 모델에 따라 strict schema·병렬 호출 지원이 다르므로 일괄적인 OpenAI 기능 동등성을 가정하지 않는다.

## 타입 경계

`providers/contracts.ts`의 `ProviderId` schema가 전체 모델 provider의 기준이다. `SubscriptionProviderId`와 `NativeToolProviderId`는 각각 이 schema에서 지원 범위를 `pick`한다. 두 범위는 현재 OpenAI·Anthropic으로 같지만 인증과 도구 지원이라는 서로 다른 계약이다.

- `OAuthProvider`는 `SubscriptionProviderId`의 별칭이다. 구독 catalog·runtime·dependency resolver는 이 범위만 받는다.
- `SubscriptionModelSelection`은 구독 어댑터의 모델 선택 계약이다. 공통 runtime 경계에서 schema로 좁힌 뒤 구독 어댑터에 전달한다.
- `ProviderToolProvider`는 `NativeToolProviderId`의 별칭이다. native 실행 route도 동일한 범위를 사용한다.
- usage·공통 모델 선택·chat route·이미지 승인 요청의 initiator는 전체 `ProviderId`를 사용한다. 이미지 executor의 지원 범위를 넓히지는 않는다.
- chat route의 인증 표시는 구독은 `subscription_oauth`, 호환 endpoint는 `openai_compatible`이다. 직접 이미지 API는 `openai_api_key`를 유지한다.

## 검증 범위

로컬 HTTP fixture에서 모델 조회, Chat Completions 요청 경로·출력 예산·헤더, SSE 텍스트 및 분할 function call 스트림, 도구 비활성화와 context 제한을 검증한다. 모델 provider와 OAuth/native tool provider의 타입·schema 경계, 호환 모델 ID가 OpenAI 모델과 같아도 native tool route가 생기지 않는 동작을 검증한다.

실제 LM Studio·vLLM 서버에 대한 모델 로드, tool result를 포함한 왕복 호출, tokenizer 기준 context 제한, 긴 스트림 취소는 이번 검증에 포함하지 않았다. 서버 및 모델 설정을 지정한 실제 요청으로 확인해야 한다.
