# 2026-10-11 dev 시작 조사

사용자가 보고한 `2/4 cache hit (50%), 11.30s saved` 메시지가 기본 `vp run agent#dev`에서 그대로 재현됐다. React Router 및 bundle build는 성공했고 종료 코드는 0이었다. 기존 dev 서버가 5180/5173에서 실행 중이었고, 새 backend는 기존 앱으로 연결을 넘기며 종료했다. 감독 프로세스가 기존 backend의 같은 build ID health를 새 자식의 준비 완료로 받아 UI를 시작한 뒤, backend 종료를 보고 UI도 정리했다. 캐시 메시지는 이 실행의 요약이었다.

`scripts/dev.ts`와 새 `scripts/dev-process.ts`는 포트 충돌을 backend build 전에 확인하고, backend 준비 대기와 자식 종료를 함께 감시한다. 이미 종료된 자식의 완료도 즉시 관찰한다. 기존 서버를 자동 종료하지 않는다. README와 시작 로그의 UI URL을 실제 기본 주소인 `localhost`로 수정했다. 의존성 빌드는 기존 package script에 보존했다.

허가된 재기동에서 기존 감독 PID 94970을 SIGTERM으로 종료하고 두 리스너 및 자식 종료를 확인한 뒤 기본 명령으로 시작했다. 최종 감독 PID 10062, backend PID 10138이며 health의 runtimeInstanceId는 `faeb3d87-1e9d-44f0-9a86-a21db9f7af13`, 상태는 ready였다. UI `http://localhost:5173/`은 HTTP 200이고 UI를 통한 대상 세션의 read-recovery GET도 성공했다. 새 중복 실행은 명확한 EADDRINUSE와 종료 코드 1을 반환하며 기존 서버를 보존했다.

실제 DB는 읽기 전용 확인에서 schema 49, 실행 중 run 0이었다. 기존 두 receipt `7775f335-8a64-44cb-a492-fb0f0e326456`와 `6b6b5774-bc80-4c32-8ce4-97343b9163cf`는 전후 동일했다. 메시지 전송, 모델 호출, run 재생, receipt 재적용, 커밋·푸시는 하지 않았다.

검증 결과:

- 통과: `vp install`, dev 관련 6파일·17테스트, 변경 코드 검사, 실제 backend build/start, UI·health·proxy GET, 중복 실행 종료 코드 검증.
- 통과: `vp check --no-fmt`는 오류 0, 병행 변경 중인 vite.config.ts의 미사용 react import 경고 1이었다.
- 실패: 전체 `vp check`는 기존/병행 파일 3개 포맷 문제(vite.config.ts, native-search-public-service JSON, owner-read-recovery.test.ts)였다. 이 작업 밖 파일을 임의 포맷하지 않았다.
- 실패: `vp run typecheck`는 기존 TS377136 unstable API 오류 117개가 남았다. 다른 코드의 타입 오류는 0이었다.
- 미실행: 전체 저장소 테스트 재실행, Windows packaging(CI 범위), 유료 모델 및 run 재생.

로그는 `/tmp/context-agent-dev-failure-{reproduce,start-final,duplicate-fixed-final,tests-final,check-targeted-final,check-full,lint-final,typecheck-final}.log`에 있다. 처음 재현의 종료 코드는 0, 최종 중복 실행은 1이며 정상 dev 명령은 계속 실행 중이다. Node PATH에는 Homebrew/shim 혼재 경고가 있었지만 Vite+ doctor는 정상이고 실제 Vite+ 실행은 관리되는 Node 26.8.2였다.
