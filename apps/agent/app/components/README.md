# components

## Overview

`apps/agent/app/components`는 agent 앱 프론트엔드가 공유하는 컴포넌트를 묶는 디렉터리다. 이 디렉터리에는 직접 소스 파일이 없고, 하위 `ui` 디렉터리가 shadcn 스타일 디자인 시스템 프리미티브를 둔다. 프리미티브는 `@base-ui/react`와 `cmdk`를 감싸고, `cva` variant와 `cn` 클래스 병합으로 Tailwind 스타일을 입힌다. 도메인 로직이나 데이터 접근은 두지 않으며, 앱 컴포넌트는 `~/components/ui/<name>` 경로로 가져다 쓴다.

## Subdirectories & Boundaries

- ui: [`./ui/README.md`](./ui/README.md) - 공유 디자인 시스템 프리미티브 모음이다. `Button`, `Badge`, `Alert`, `AnimatedNumber`, `Attachment*`, `Card*`, `Collapsible*`, `Command*` 등을 내보낸다. `data-slot` 속성으로 서로의 레이아웃을 조정하는 순수 표현 계층이다.
