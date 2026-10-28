# packages

## Overview

`packages`는 앱(`apps/agent`)이 가져다 쓰는 워크스페이스 패키지를 묶는 디렉터리다. 이 디렉터리에는 직접 소스 파일이 없고, 하위 패키지 세 개를 둔다.

- `memory-agent`: Node 전용 에이전트 서버 로직 패키지다. `package.json`의 `exports`가 모든 subpath와 worker 스크립트를 `src/*.ts` TypeScript 원본으로 가리킨다.
- `turbovec`: 양자화 벡터 인덱스와 읽기 전용 SQLite 읽기 세션을 Node에 노출하는 로컬 N-API 바인딩 패키지다. 이전 POC의 네이티브 모듈이고, `memory-agent` worker thread가 `loadTurbovec()`로 쓴다.
- `utils`: Vite+ 스타터 템플릿으로 만든 TypeScript ESM 라이브러리 패키지다. 실제 유틸리티 코드는 아직 없고 예제 함수 `fn`만 내보낸다.

## Subdirectories & Boundaries

- memory-agent: [`./memory-agent/README.md`](./memory-agent/README.md) - 에이전트 로직 패키지. 루트 `memory-agent` export(`./src/index.ts`)는 앱의 `.server` 모듈과 API 라우트에서만 쓰는 Node 전용 진입점이다. 브라우저용 도구 정의는 `memory-agent/definitions`로 따로 내보낸다. 그 밖에 `memory-agent/testing`, 채팅 API(`chat-api`, `chat-session`, `chat-view`, `btw-thread`), provider 계약(`provider-contracts`, `compatible-config`), `memory-agent/acp`, 런타임 플랫폼 모듈(`native-effect`, `node-platform`, `synchronous-path`, `host-system`)을 내보낸다. 네이티브 패키지를 부르는 `requireRuntime`는 `memory-agent/runtime-resources`에 있다.
- turbovec: [`./turbovec/README.md`](./turbovec/README.md) - `turbovec` 네이티브 바인딩 패키지(private, ESM). `index.js`의 `loadTurbovec()`가 cargo로 빌드한 `memory-turbovec.node`를 로드해 `VectorIndex`, `MemoryReadSession`, `SearchControl`, `CacheLease`를 돌려준다. `vp run build`로 애드온을 만들지 않았으면 `loadTurbovec()`는 throw한다. `build-turbovec.ts`는 애드온을 원자적으로 교체하고, 산출물은 로컬 머신 전용이다.
- utils: [`./utils/README.md`](./utils/README.md) - `utils` ESM 패키지. `vp pack`(tsdown)으로 만든 `./dist/index.mjs`를 `exports['.']`로 내보낸다. 스크립트는 `build`(`vp pack`), `dev`(`vp pack --watch`), `test`(`vp test`), `check`(`vp check`), `prepublishOnly`(`vp run build`)이고, `vite.config.ts`의 `typecheck` 태스크가 `tsc`를 실행한다.
