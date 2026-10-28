# kagi

## Overview

`kagi` 디렉터리는 선택 기능인 Kagi Search/Extract API(R19)를 감싸는 Effect 서비스 `Kagi` 하나를 둔다. 사용자가 키체인(`SecretStore`)에 API 키를 등록하고 `GlobalConfig`의 `kagiEnabled`를 켜야만 `https://kagi.com/api/v1`의 `/search`·`/extract`로 POST를 보낸다. 응답은 SDK 모델 중 도구가 넘기는 필드만 Schema로 검증한다. 실패는 `KagiFailed`의 reason 리터럴로 정규화해 돌려주고, 재호출 여부는 모델이 판단한다. 설정 화면용 상태 조회·키 등록/삭제·활성화 토글도 같은 서비스가 맡는다.

## Interface

- `Kagi` — `Context.Service`("memory-agent/kagi/kagi"). `status`, `registerKey`, `removeKey`, `setEnabled`, `search`, `extract`를 제공한다
- `Kagi.layer(options?: KagiOptions)` — `Layer.effect(Kagi, make(options))`에 `FetchHttpClient.layer`를 붙인다. `GlobalConfig`와 `SecretStore`는 여전히 요구한다
- `Kagi.status` — `Effect<KagiStatus, SecretStoreFailed | GlobalConfigFailed>`. 키 등록 여부와 활성 여부를 돌려주며, 키 값은 돌려주지 않는다
- `Kagi.registerKey(key)` — 키를 trim해 `kagi-api-key`로 키체인에 저장한다. 등록만으로 Kagi가 켜지지 않는다
- `Kagi.removeKey` — `kagiEnabled: false`로 설정을 바꾼 뒤 키체인에서 키를 지운다
- `Kagi.setEnabled(enabled)` — 키 없이 켜려 하면 `KagiKeyMissing`으로 실패한다. 그 밖에는 설정을 갱신하고 `status`를 돌려준다
- `Kagi.search(input: KagiSearchInput, signal?)` — POST `/search`. `{ query, limit }`를 보내고 `SearchResponse`(data.search/news/directAnswer)로 decode한다
- `Kagi.extract(urls, signal?)` — POST `/extract`. `{ pages: [{url}], format: "markdown" }`를 보내고 `KagiExtractResponse`로 decode한다
- `kagiBaseUrl` — 상수 `"https://kagi.com/api/v1"`
- `maxExtractUrls` — 상수 10. Extract 요청 하나에 넣을 수 있는 최대 URL 수다(Kagi API 문서 기준)
- `KagiStatus` — `{ keyRegistered: boolean; enabled: boolean }` interface
- `KagiKeyMissing` — `Schema.TaggedError`. 키 없이 활성화를 요청하면 난다
- `KagiFailed` — `Schema.TaggedError`(`reason: KagiFailureReason`, `status: Int | null`). `message`는 `kagi_<reason>: <설명>` 형식이다
- `KagiFailureReason` — `Schema.Literals`: not_enabled, invalid_request, unauthorized, forbidden, rate_limited, server_error, unavailable, invalid_response
- `KagiSearchResult` — 검색 결과 항목 타입 `{ url, title, snippet?, time? }`
- `KagiExtractResponse` — Extract 응답 타입 `{ data: [{ url, markdown?, error? }], errors?: [{ code, url, message? }] }`
- `KagiSearchInput` — `{ query: string; limit: number }` interface
- `KagiOptions` — `{ baseUrl?: string }`. 테스트에서 로컬 서버를 가리킬 때 쓴다
- 하위 디렉터리 없음

## Invariants

- Kagi 요청은 재시도하지 않는다. 실패 reason을 모델에 넘기고, 다시 부를지는 모델이 정한다(R19 주석)
- `post`는 매 호출 직전에 설정과 키를 다시 읽는다. 그래서 키를 지우거나 끄면 바로 다음 호출이 `not_enabled`로 실패한다
- 키체인을 읽지 못하면(`SecretStoreFailed`) `post`는 키가 없는 것으로 보고 `not_enabled`로 실패한다
- `kagiEnabled`가 truthy가 아니거나 키가 null이면 네트워크 요청을 보내지 않는다
- 자격 증명은 리다이렉트하지 않는다. `FetchHttpClient.RequestInit`을 `{ redirect: "error" }`로 강제한다
- 호출자가 준 `AbortSignal`은 `AbortSignal.any`로 클라이언트 자체 signal과 합친다. 클라이언트의 인터럽트 제어는 그대로 유지된다
- HTTP 상태 매핑: 400은 invalid_request, 401은 unauthorized, 403은 forbidden, 429는 rate_limited, 5xx 이상은 server_error, 그 밖의 2xx가 아닌 상태는 invalid_response다. 전송 오류는 unavailable(status null)이다
- 응답 JSON 파싱이나 Schema decode가 실패하면 `invalid_response`가 된다
- `status`와 오류 메시지는 API 키 값을 절대 노출하지 않는다. `keyRegistered`/`enabled` 불리언만 돌려준다
- `removeKey`는 `kagiEnabled`를 false로 바꾼 뒤에 키를 지운다
- `setEnabled(true)`는 키가 등록돼 있어야 한다. 키가 없으면 `KagiKeyMissing`으로 실패한다
- 키체인 항목 이름은 `"kagi-api-key"`로 고정이다
- 응답 스키마는 도구가 넘기는 필드만 담는다(SDK `models/*.ts` 일부)

## Side Effects

- `SecretStore`(키체인)의 `kagi-api-key`를 읽고(`get`), 쓰고(`set`), 지운다(`remove`)
- `GlobalConfig`를 읽고(`config.read`), `kagiEnabled` 값을 갱신한다(`config.update`)
- 네트워크: `HttpClient`/`FetchHttpClient`로 `${baseUrl}/search`와 `${baseUrl}/extract`에 HTTPS POST를 보낸다. 헤더는 `Authorization: Bearer <key>`와 `Accept: application/json`이고, 본문은 JSON이다
- 요청 범위마다 `Effect.scoped`로 HTTP 응답 리소스를 관리한다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
