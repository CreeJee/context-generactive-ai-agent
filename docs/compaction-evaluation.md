# 긴 대화 compact 평가

2026-09-21에 compact 기본값을 정하기 위해 기존 보수적 프로파일과 현재 프로파일을 같은 결정론적 장기 대화에서 비교했다.

## 프로파일

| 항목             | 기존 보수적 프로파일                     | 채택한 현재 프로파일                          |
| ---------------- | ---------------------------------------- | --------------------------------------------- |
| 요약 블록        | 10 user turns를 한 결합 요약으로 다시 씀 | 4 user turns마다 독립적인 불변 블록 추가      |
| 원문 보존        | 최근 4 user turns                        | 최근 2 user turns                             |
| 완료된 도구 결과 | 요약 임계점까지 원문 유지                | 다음 모델 요청부터 node pointer로 교체        |
| 자동 retrieval   | 없음                                     | 현재 세션 우선, 최대 5개·600 estimated tokens |

현재 기본값은 4턴 요약 블록, 최근 원문 2턴, retrieval 600 estimated tokens를 유지한다.

## 시나리오와 지표

`packages/memory-agent/eval/compaction.ts`는 16·20·26턴 체크포인트가 있는 한국어 장기 대화를 만든다. 대화에는 큰 도구 결과, 초기 결정, 뒤의 정정, 마지막 원문 근거 질문이 포함된다. 실제 `compact()`를 사용해 현재 프로파일의 요청을 만들고 다음을 측정한다.

- 모델 요청의 평균 estimated input tokens
- 연속 요청 사이에서 byte-identical한 메시지 prefix와 2,000-token 고정 system/tool prefix를 합친 cacheable-prefix 비율
- main call과 summary call 수
- retrieval appendix가 최신 정정 user node를 가리키는지
- 오래된 결정 node가 최신 정정으로 함께 노출되지 않는지
- appendix가 600-token 예산 안인지

cacheable-prefix 비율은 provider의 실제 `cachedTokens`가 아니라 wire payload로부터 계산한 결정론적 상한 지표다. 실제 cache hit는 provider 최소 prefix 길이, TTL, 라우팅 및 계정 상태의 영향을 받으므로 앱의 context usage 지표로 별도 관측한다.

## 2026-09-21 결과

| 지표                               |      기존 |             현재 |       변화 |
| ---------------------------------- | --------: | ---------------: | ---------: |
| 평균 입력 토큰                     |     9,244 |            5,556 | **-39.9%** |
| 두 번째 이후 평균 cacheable prefix |     44.9% |            47.7% | **+2.9%p** |
| main provider calls                |         3 |                3 |       동일 |
| summary provider calls             |         2 |                6 |         +4 |
| 최신 정정 원문 node 도달률         | 해당 없음 |             100% |       통과 |
| 정정 반영률                        | 해당 없음 |             100% |       통과 |
| retrieval appendix                 | 해당 없음 | 225 / 600 tokens |       통과 |

프로덕션 검색 구성(`vector(quint8) + trigram + kiwi`)의 기존 recall corpus도 함께 실행했다.

| corpus    | top-1 | top-3 | top-5 |   MRR |
| --------- | ----: | ----: | ----: | ----: |
| decisions | 24/32 | 29/32 | 30/32 | 0.836 |
| technical | 19/27 | 22/27 | 22/27 | 0.759 |

이 값은 compact 변경 전 검색 알고리즘을 바꾸지 않았는지 확인하는 기준선이다. compact 장기 대화 검사는 별도로 최신 정정 node 도달과 원문 ID 일치를 100%로 요구한다.

입력 토큰과 안정 prefix는 개선됐지만 요약 호출 수가 늘어난다. 요약은 가장 낮은 reasoning effort로 run 뒤 백그라운드에서 실행되고 실패해도 대화를 막지 않는다. 이 비용 증가를 감수하고 현재 프로파일을 기본값으로 채택한다. 호출 비용이나 지연이 문제인 환경에서는 향후 블록 크기를 설정으로 노출하는 대신 먼저 실제 usage 자료를 수집한다.

## 재실행

```bash
pnpm --filter memory-agent eval:compaction
pnpm --filter memory-agent eval:recall "vector(quint8) + trigram + kiwi"
pnpm exec vp test packages/memory-agent/tests/compaction-eval.test.ts packages/memory-agent/tests/compaction.test.ts
```

`compaction-eval.test.ts`는 입력 토큰 감소, cacheable-prefix 개선, 원문 node 도달, 최신 정정 반영 및 retrieval 예산을 회귀 기준으로 고정한다. 기존 `eval:recall`은 decision·technical corpus의 검색 품질을 별도로 확인한다.
