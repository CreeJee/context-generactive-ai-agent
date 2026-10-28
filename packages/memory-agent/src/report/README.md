# report

## Overview

`packages/memory-agent/src/report`는 사용자 버그 리포트 기능의 백엔드다. 세션 증거 번들을 모으고(비밀정보 가림, 길이 제한, 로컬 id 해시화), 사용자가 고른 모델로 번들을 진단하고, 검토된 리포트와 런타임 결함 알림을 개발자의 Discord execute-webhook(`DISCORD_WEBHOOK_URL`)으로 보낸다. `*-contract.ts` 파일은 앱(`apps/agent`)과 주고받는 Effect Schema 계약을 정의하고, 나머지 파일은 이 계약을 구현하는 Effect 서비스와 레이어다.

## Interface

- `ReportBundle` / `BundleEvent` / `BundleRun` / `BundleText` / `BundleSectionStatus` / `BundleIntegration` / `BundleBoard` / `BundleDefect` — 증거 번들 Schema(`version: 1`, 섹션별 status/items/truncated, TaggedUnion 이벤트 Message·ToolCall·Approval·Trace)
- `ReportDeliveryFailure` / `ReportDeliveryResult` / `ReportDeliveryStatus` — 전송 실패 사유 리터럴, 결과 TaggedUnion(`delivered`·`duplicate`·`uncertain_duplicate`), 웹훅 설정 상태 Schema
- `ReportDiagnosisInput` / `ReportDiagnosis` / `ReportDiagnosisFailure` — 진단 입력(symptom ≤4000자 등, bundle nullable), 진단 결과(summary·observations·hypotheses), 실패 사유 Schema
- `collectReportBundle(project, session)` — `Effect.fn("ReportBundle.collect")`; 한 세션의 증거 번들을 수집한다
- `bundleLimits` — 번들 한도 상수(runs 30, eventsPerRun 60, textChars 1500, failureChars 6000, unlinked 20)
- `loopHealthText` — `LoopHealth`를 텍스트(`Healthy`, `Retrying a/b`, `Exhausted (e)`, `Defected`)로 변환한다
- `diagnosisDigest(bundle)` — 진단 모델에 줄 `DigestItem[]`(environment, timeline 개요, 최신 실패 run 최대 10개)를 만든다
- `bundlePlaces(bundle)` — observation이 인용할 수 있는 place id 집합(`environment`, `timeline`, `run-N`, `run-N/call-M`)
- `runPlace` / `runHasFailure` / `digestLimits` / `DigestItem` — run place 이름, 실패 run 판정, digest 한도, digest 항목 타입
- `ReportDiagnoser` — `Context.Service`(`diagnose(input)`), `ReportDiagnoser.layer`로 제공; 선택된 모델로 리포트 초안을 진단한다
- `parseDiagnosis(answer, evidenceIds)` — 모델 JSON 답을 디코드하고 인용 없는 observation을 hypotheses로 옮긴다
- `diagnosisInstructions` — 진단 모델 system 프롬프트 문자열
- `ReportDiagnosisError` — `Schema.TaggedError`(reason: `ReportDiagnosisFailure`, cause optional)
- `ReportDelivery` — `Context.Service`(`status`, `send`, `sendNotice`), `ReportDelivery.layer(options?: ReportDeliveryOptions)`로 제공; Discord webhook 전송
- `ReportDeliveryError` — `Schema.TaggedError`(reason, httpStatus?, retryAfterSeconds?); URL·토큰·응답 본문을 담지 않는다
- `parseWebhookUrl` — dual 함수; Discord execute-webhook URL만 허용(loopback은 테스트용 옵션), 실패 시 `null`
- `webhookConfigKey` / `maxReportBytes` / `maxEvidenceBytes` / `ReportSend` / `ReportDeliveryOptions` — 설정 키 `DISCORD_WEBHOOK_URL`, 리포트 1_000_000B·증거 4_000_000B 한도, 전송 입력(text, evidence) 타입, 레이어 옵션(`allowLoopback`)
- `defectReportsLayer` — `Layer.effect(DefectReporter, make)`; 결함을 Discord로 보내고 최근 결함 목록을 유지한다
- `admitDefect` / `noDefectsSent` / `AdmissionState` / `fingerprintWindow` / `messagesPerMinute` — 결함 알림 rate-limit 순수 로직(dual)과 상태, 10분 fingerprint 창, 분당 5건

## Invariants

- 번들의 모든 텍스트는 `SecretRedactor`를 거치고 한도로 잘린다. `BundleText.cut`은 원문이 잘렸는지 표시한다. 일괄 가림 결과가 개수와 맞지 않으면 한 텍스트씩 다시 가리고, 그것도 실패하면 `[비밀정보 확인 실패로 숨김]`으로 대체한다.
- 로컬 id(goal_instance_id, sessionId, goalInstanceId 등)는 SHA-256 hex 앞 12자로만 밖에 나간다. 해시 실패 시 `unhashed`를 쓴다.
- 한 섹션 소스가 실패하면 그 섹션만 `status: "failed"`가 되고 번들은 계속 만들어진다(`guarded` + `fallbackLogged("report_bundle_section_failed")`).
- `ReportBundle.version`은 `Schema.Literal(1)`이다. environment에는 provider·model 종류만 담고 자격증명·endpoint는 담지 않는다.
- place id 형식(`run-N`, `run-N/call-M`, `environment`, `timeline`)은 `bundle-digest.ts`, `diagnosisInstructions`, `parseDiagnosis`가 공유한다. 바꾸면 세 곳을 함께 바꿔야 한다.
- `parseDiagnosis`는 `bundlePlaces`에 있는 id를 인용한 observation만 남기고, 인용 없는 observation은 hypotheses로 옮긴다. 각 항목 최대 6개·600자, summary 최대 1200자다. 셋이 모두 비면 `invalid_answer`로 실패한다.
- 진단은 선택된 provider의 auth가 `signed-in`일 때만 하고, 아니면 `model_unavailable`로 실패한다. 모델 호출은 120_000ms 제한이다. 진단 실패는 일반 리포트를 막지 않는다.
- API 사용량은 `sourceSessionId`가 비어 있지 않을 때만 `purpose: "report-diagnosis"`로 기록한다.
- webhook URL의 토큰은 비밀이다. `Redacted`로 감싸고, 오류에 넣지 않고, 요청은 `redirect: "error"`와 `HttpClient.TracerDisabledWhen`으로 리다이렉트와 span 기록을 막는다.
- webhook URL은 https와 Discord 호스트(`discord.com`, `discordapp.com`, `ptb.discord.com`, `canary.discord.com`)와 `/api(/vN)/webhooks/{id}/{token}` 경로만 허용한다. 사용자명·비밀번호가 있으면 거부한다. loopback http는 `allowLoopback`(테스트)일 때만 허용한다.
- webhook 설정은 레이어 생성 시 한 번만 읽고 브라우저로 보내지 않는다. status에는 webhook id 끝 4자리만 노출한다. Config 읽기 오류는 invalid로 취급한다.
- Discord 메시지 content는 2000자 제한이다. 리포트 전문은 항상 `context-agent-report.txt` 첨부로, 증거 번들은 `context-agent-evidence.json` 두 번째 첨부로 보낸다. `allowed_mentions: { parse: [] }`로 멘션을 막는다.
- 같은 텍스트의 전송 시도는 텍스트 SHA-256을 키로 서버 프로세스 메모리에 기억한다(재시작 전까지). 이미 보낸 텍스트는 `duplicate`, 도달 여부가 불확실한 시도는 `uncertain_duplicate`로 돌려준다.
- 429는 Discord가 5초 이하 대기를 요구할 때만 최대 2회 재시도한다. 요청 타임아웃은 30초다.
- 결함 알림은 같은 fingerprint(`tag@location`)를 10분에 한 번, 전체로 분당 5건까지만 보낸다. 다음 메시지에 억제된 횟수를 합산한다.
- 결함 알림에는 tag·위치·버전·플랫폼·해시된 id·횟수·가린 요약(300자)·스택 상위 5줄만 담고 2000자로 자른다. 프롬프트·모델 답·자격증명은 보내지 않는다.
- 결함 전송은 결함을 낸 쪽을 막지 않는다. `Queue.dropping(64)`이 가득 차면 새 항목을 버린다. 전송 실패는 `defect_report_failed`로 로그만 남긴다.
- webhook이 설정되지 않아도 최근 결함 목록(최신순, 최대 20개, tag+location으로 합산)은 유지해 사용자 리포트에 싣는다. 실제 전송은 시작 시 webhook이 configured이고 전송 시점 설정 `defectReports !== false`일 때만 한다.
- `collectReportBundle`은 `SqlClient`, `SecretRedactor`, `Crypto`, `ActiveProvider`, `GlobalConfig`, `McpServers`, `ExternalAgents`, `Importer`, `DefectReporter`, `BoardHealth` 서비스를 요구한다(`WorkTraceStore`도 import한다). `defectReportsLayer`는 `ReportDelivery`, `GlobalConfig`, `SecretRedactor`, `Crypto`를 요구한다. `ReportDiagnoser.layer`는 `ActiveProvider`, `ApiUsage`, `Crypto`를 요구한다.

## Side Effects

- SQLite 읽기: `collectReportBundle`이 `kanban_goals`, `kanban_cards`(JOIN)를 session_id로 조회한다. run·node·approval 행(`RunRow`, `NodeRow`, `ApprovalRow`)도 조회한다.
- 환경·설정 읽기: `CONTEXT_AGENT_RELEASE`(기본 `0.0.0-dev`, 오류 시 `unknown`), `DISCORD_WEBHOOK_URL`(Redacted), `GlobalConfig.read`(kanbanConcurrency, defectReports), `process.versions.node`, `hostPlatform`.
- 네트워크: `ReportDelivery`가 Discord webhook URL로 `?wait=true` multipart POST를 보낸다(리포트 `send`, 서버 알림 `sendNotice`).
- LLM 호출: `ReportDiagnoser.diagnose`가 `singleAnswer`로 선택된 모델을 호출하고 `recordUsage`로 API 사용량을 기록한다.
- 프로세스 메모리 상태: `ReportDelivery`의 전송 시도 `Ref<Map<hash, Attempt>>`, `defectReportsLayer`의 rate-limit `Ref<AdmissionState>`와 최근 결함 `Ref<RecentDefect[]>`.
- 백그라운드 fiber: `defectReportsLayer`가 `Queue.dropping(64)`을 소비하는 Stream을 `Effect.forkScoped`로 띄운다(동시성 2).
- 로깅: `fallbackLogged`(`report_bundle_section_failed`, `report_bundle_model_unknown`, `report_bundle_settings_unknown`), `logFailure("defect_report_failed")`.
- 시계·암호: `Clock.currentTimeMillis`, `DateTime.now`, `Crypto.digest(SHA-256)`, `crypto.randomUUIDv4`(진단 threadId).

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
