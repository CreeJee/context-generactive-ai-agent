# wasm-check

## Overview

`packages/turbovec/wasm-check`는 `memory-turbovec-wasm-check` 크레이트(`publish = false`)를 담는 디렉터리다. 이 크레이트는 런타임 로직이 없는 컴파일 전용 프로브이며, git rev가 고정된 상위 `turbovec` 크레이트가 wasm 대상으로 빌드되는지 확인한다. wasm 빌드의 JS 엔트로피 브리지는 상위 `Cargo.toml`에서 켜는 `getrandom` 0.2의 `js` 기능이 제공한다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 크레이트의 유일한 소스다. `turbovec::IdMapIndex`를 `pub use`로 다시 내보내 컴파일 확인에만 쓴다.
