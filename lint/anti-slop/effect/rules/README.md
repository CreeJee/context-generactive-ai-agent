# rules

## Overview
이 디렉터리는 저장소 전용 Oxlint 플러그인(anti-slop)의 Effect 계열 규칙 구현을 담는다. 유일한 파일 `no-service-constructor-imports.ts`는 `vite-plus/lint/plugins`의 `defineRule`로 만든 규칙이다. 이 규칙은 런타임 코드가 상대 경로 모듈에서 `make<대문자>` 형태의 Effect 서비스 생성자를 import하지 못하게 막는다. 대신 소유 Layer를 import하고 문맥 서비스를 yield해서 요구사항이 composition root까지 전파되도록 유도한다.

## Interface
- `noServiceConstructorImportsRule` — `defineRule`로 정의한 lint 규칙 객체. meta.type은 "problem"이고 messageId는 `serviceConstructorImport`이다. `ImportDeclaration` 방문자에서 위반을 보고한다.

## Invariants
- 상대 경로(`./` 또는 `../`)로 시작하는 import만 검사한다. 패키지 import와 path alias import는 대상이 아니다.
- import 이름이 `/^make[A-Z]/u`에 맞는 named `ImportSpecifier`만 보고한다. default import와 namespace import는 건너뛴다.
- 파일 이름이 `/\.(?:test|spec)\.[cm]?[jt]sx?$/u`에 맞으면 검사를 전부 건너뛴다. 판정 전에 경로의 `\`를 `/`로 바꾼다.
- import된 이름이 문자열 리터럴(`imported.value`)이면 그 값으로, Identifier면 `imported.name`으로 판정한다. 별칭(local 이름)이 아니라 원래 export 이름을 기준으로 한다.
- 설계 의도(JSDoc): 의존성을 지닌 Effect 서비스 생성자는 소유 capability 모듈 안에 머물러야 한다. 런타임 코드는 Layer를 import하고 서비스를 yield해서 요구사항을 composition root로 전파해야 한다.

## Side Effects
- 없음 (순수 함수와 타입만 제공)

## Verification
- Run: `vp lint` (저장소 루트, anti-slop 플러그인을 불러옴)
