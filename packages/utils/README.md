# utils

## Overview

워크스페이스 공용 유틸리티를 둘 TypeScript ESM 라이브러리 패키지입니다. Vite+ 라이브러리 템플릿으로 만든 상태라 실제 유틸리티는 아직 없고, 예제 함수 `fn`만 내보냅니다. 저장소의 다른 패키지는 이 패키지를 가져다 쓰지 않습니다.

## Development

저장소 루트에서 의존성을 설치합니다:

```bash
vp install
```

단위 테스트를 실행합니다:

```bash
vp run utils#test
```

라이브러리를 빌드합니다:

```bash
vp run utils#build
```

## Interface

설치·테스트·빌드 명령은 위 `Development` 절 참고.

- `utils` (package.json `exports['.']`) — 빌드 결과물 `./dist/index.mjs`를 내보내는 ESM 패키지 진입점(`src/index.ts`의 `fn`만 들어 있음)
- `./package.json` export — 패키지 매니페스트를 subpath로 노출
- `build` 스크립트 (`vp pack`) — tsdown으로 `dist`를 빌드하고 `tsgo`로 d.ts 생성
- `dev` 스크립트 (`vp pack --watch`) — 감시 모드 빌드
- `test` 스크립트 (`vp test`) — Vitest 실행(`clearMocks: true`)
- `check` 스크립트 (`vp check`) — 포맷·린트·타입 검사
- `prepublishOnly` 스크립트 (`vp run build`) — 배포 전 빌드
- `typecheck` 태스크 (vite.config.ts `run.tasks`) — `tsc` 실행, `cache: false`
- `src` — 패키지 소스 디렉터리. 템플릿 예제 함수 `fn`만 export한다. 계약: [`./src/README.md`](./src/README.md)
- `tests/` — 단위 테스트

## Invariants

- 패키지 진입점은 소스가 아니라 빌드 결과물 `./dist/index.mjs`다. 소비자가 쓰려면 먼저 `vp pack`으로 빌드해야 한다(`files: ["dist"]`, `dist`는 .gitignore 대상).
- `"type": "module"`인 ESM 전용 패키지다. tsconfig는 `module`/`moduleResolution: nodenext`, `verbatimModuleSyntax`, `isolatedModules`, `strict`, `noUnusedLocals`를 강제한다.
- tsconfig는 `noEmit: true`다. 산출물은 tsc가 아니라 `vp pack`(tsdown, dts generator `tsgo`)이 만든다.
- `typecheck` 태스크는 `cache: false`를 유지해야 한다. 주석에 따르면 Vite Task는 TypeScript 7 네이티브 tsc가 읽는 파일을 보지 못해, 캐시하면 새 타입 오류가 가려진다.
- `pack.deps.resolveDepSubpath: true`는 tsdown <0.23 호환용이다. 주석상 지우면 subpath import를 작성한 그대로 유지하는 새 기본 동작이 된다.
- 린트는 `typeAware: true`, `typeCheck: true`로 설정되어 있다.
- devDependencies는 모두 `catalog:` 버전이라 워크스페이스 카탈로그를 따른다.

## Side Effects

- 없음 (순수 함수와 타입만 제공)

## Verification

- Run: `vp run utils#typecheck`
- Run: `vp run utils#test`
