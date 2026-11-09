# copy

## Overview

`lint/copy`는 앱 문구를 어디에 두는지 정하는 저장소 전용 Oxlint JS 플러그인 `copy`다. `index.ts`가 `rules/`의 규칙을 `eslintCompatPlugin({ meta: { name: "copy" }, rules })`로 묶어 default export한다. 루트 `vite.config.ts`가 `lint.jsPlugins`에 `{ name: "copy", specifier: "./lint/copy/index.ts" }`로 등록한다. 규칙은 문구를 카탈로그로 옮긴 디렉터리에만 `overrides`로 `"error"`를 켠다. 문구가 무엇을 말하는지는 이 플러그인이 아니라 [`tools/copy-check`](../../tools/copy-check/README.md)가 검사한다. 이 저장소가 직접 쓴 코드라서 lint·fmt 대상이다.

## Interface

- `copyPlugin` (default export) — 규칙을 묶은 Oxlint 플러그인 객체.
- `copy/no-inline-copy` — `./rules/no-inline-copy.ts`의 `noInlineCopyRule`. 한글이 든 문자열 리터럴, 템플릿 리터럴, JSX 텍스트를 `copy.ts` 밖에서 쓰면 보고한다. 앱은 한국어만 쓰므로 코드 안의 한글은 곧 문구다. 문구를 카탈로그에 모아야 `tools/copy-check`가 전부 읽을 수 있다.

## Invariants

- 이름이 정확히 `copy.ts`인 파일만 카탈로그다. `report-copy.ts`처럼 이름이 `copy.ts`로 끝나기만 하는 파일은 카탈로그가 아니다. 커밋 hook(`staged`의 `**/copy.ts`)과 Claude Code hook도 같은 이름으로 카탈로그를 찾는다.
- 테스트 파일(`*.test.ts(x)`, `*.spec.ts(x)`)은 화면에서 찾을 문구를 직접 쓸 수 있어 보고하지 않는다.
- 규칙은 기능 디렉터리를 하나씩 옮길 때마다 루트 `vite.config.ts`의 `overrides` 목록에 그 디렉터리를 더해 `"error"`로 켠다. 모두 옮기면 전체에 켠다.
- 플러그인 이름 `"copy"`는 `vite.config.ts`의 등록 이름, 규칙 키 접두사와 일치해야 한다.
- 규칙 모듈은 `.ts` 확장자를 붙인 상대 경로로 import한다.

## Side Effects

- 없음 (순수 함수와 타입만 제공)

## Verification

- Run: `vp test lint/copy` (RuleTester로 보고 여부 확인)
- Run: `vp lint` (저장소 루트, 플러그인을 불러옴)
