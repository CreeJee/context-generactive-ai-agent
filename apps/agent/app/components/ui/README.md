# ui

## Overview

`apps/agent/app/components/ui`는 agent 앱 프론트엔드가 공유하는 shadcn 스타일 디자인 시스템 프리미티브 모음이다. 대부분 `@base-ui/react` 프리미티브(Dialog, Menu, PreviewCard, Collapsible, Input, Separator, Select, Tabs, Tooltip 등)와 `cmdk`를 감싸고, `class-variance-authority`의 variant와 `cn` 클래스 병합으로 Tailwind 스타일을 입힌다. 각 컴포넌트는 `data-slot` 속성을 달아 서로의 CSS 선택자로 레이아웃을 조정한다. 도메인 로직이나 데이터 접근 없이 순수 표현 계층을 이룬다. 위쪽 앱 컴포넌트는 `~/components/ui/<name>` 경로로 가져다 쓴다.

## Interface

- `Button`, `buttonVariants` — `@base-ui/react/button` 래퍼다. variant는 default/outline/secondary/ghost/ghost-muted/destructive/link이고, size는 default/xs/sm/lg/icon/icon-xs/icon-sm/icon-lg이다. attachment, dialog, sheet, input-group가 의존한다
- `Badge`, `badgeVariants` — `useRender` 기반 span 배지다. `render` prop으로 태그를 바꿀 수 있다
- `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction` — `role="alert"` 알림 박스다. variant는 default/destructive이다
- `AnimatedNumber` — `motion/react` spring으로 숫자를 `ko-KR` 형식으로 부드럽게 바꿔 보여 준다. 스크린리더용 sr-only 값을 따로 렌더한다
- `Attachment`, `AttachmentGroup`, `AttachmentMedia`, `AttachmentContent`, `AttachmentTitle`, `AttachmentDescription`, `AttachmentActions`, `AttachmentAction`, `AttachmentTrigger` — 첨부 파일 카드 묶음이다. `state`는 idle/uploading/processing/error/done이고 size·orientation variant를 둔다
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` — 카드 레이아웃이다. size는 default/sm, variant는 default/warning이다
- `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` — Base UI Collapsible 래퍼다
- `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator` — `cmdk` 기반 커맨드 팔레트다. variant는 default/composer이다
- `DataList`, `DataListItem` — `dl`/`dt`/`dd` 2열 grid 키-값 목록이다. 이 파일만 `~/lib/utils`의 `cn`을 쓴다
- `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` — Base UI Dialog 래퍼다. `showCloseButton` 옵션이 있다
- `DropdownMenu` 계열 15개(`DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuShortcut` 등) — Base UI Menu 래퍼다
- `Empty`, `EmptyHeader`, `EmptyMedia`, `EmptyTitle`, `EmptyDescription`, `EmptyContent` — 빈 상태 화면 블록이다
- `Field`, `FieldSet`, `FieldLegend`, `FieldGroup`, `FieldContent`, `FieldLabel`, `FieldTitle`, `FieldDescription`, `FieldSeparator`, `FieldError` — 폼 필드 레이아웃과 오류 표시다. orientation은 vertical/horizontal/responsive이다
- `HoverCard`, `HoverCardTrigger`, `HoverCardContent` — Base UI PreviewCard 래퍼다
- `Input`, `Label`, `Separator`, `Kbd`, `KbdGroup` — 기본 입력, 라벨, 구분선, 키보드 키 표시다
- `InputGroup`, `InputGroupAddon`, `InputGroupButton`, `InputGroupText`, `InputGroupInput`, `InputGroupTextarea` — 입력과 부가 요소 묶음이다. 본문은 예산 때문에 읽지 않았고 export 목록으로만 확인했다
- `PromptInput`, `PromptInputHeader`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputButton` — input-group 위에 만든 채팅 프롬프트 입력이다. 본문은 읽지 않았다
- `Item`, `ItemMedia`, `ItemContent`, `ItemActions`, `ItemGroup`, `ItemSeparator`, `ItemTitle`, `ItemDescription`, `ItemHeader`, `ItemFooter` — 목록 항목 레이아웃이다. 본문은 읽지 않았다
- `Select` 계열(`SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue`, `SelectGroup`, `SelectLabel`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton`) — Base UI Select 래퍼다. 본문은 읽지 않았다
- `Sheet` 계열(`SheetTrigger`, `SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription`, `SheetClose`, `SheetOverlay`, `SheetPortal`) — Base UI Dialog 기반 사이드 시트다. 본문은 읽지 않았다
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `tabsListVariants` — Base UI Tabs 래퍼다. 본문은 읽지 않았다
- `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` — Base UI Tooltip 래퍼다. 본문은 읽지 않았다
- `Marker`, `MarkerIcon`, `MarkerContent`, `markerVariants`, `ScrollArea`, `ScrollBar`, `Spinner`, `Switch`, `Textarea` — 기타 프리미티브다. 본문은 읽지 않았다
- 하위 디렉터리 없음

## Invariants

- 모든 컴포넌트는 `data-slot` 값을 붙이고, 다른 컴포넌트가 이 값을 CSS 선택자로 참조한다. 예: `has-data-[slot=alert-action]:pr-18`, `has-data-[slot=card-action]:grid-cols-[1fr_auto]`, `CommandItem`의 `group-has-data-[slot=command-shortcut]`, `Kbd`의 `in-data-[slot=tooltip-content]`, `CommandItem`의 `in-data-[slot=dialog-content]`, `AttachmentGroup`의 `*:data-[slot=attachment]`. slot 이름을 바꾸면 이 스타일이 조용히 깨진다
- `Attachment`의 `state`는 `"idle" | "uploading" | "processing" | "error" | "done"` 유니온이고 기본값은 `done`이다. 이 값은 `data-state`로 내려가고, 하위 슬롯이 `group-data-[state=...]/attachment`로 shimmer, opacity, 오류 색을 결정한다
- `AttachmentTrigger`는 `render`가 없으면 `type`을 기본 `"button"`으로 둔다. 그래서 form submit이 일어나지 않는다. `render`를 넘기면 전달된 `type`만 쓴다
- `AnimatedNumber`의 애니메이션 span은 `aria-hidden`이다. 스크린리더는 `sr-only` 최종값만 읽는다. `useReducedMotion()`이 true면 `spring.jump`으로 즉시 표시하고, 아니면 `spring.set`으로 이징한다
- `FieldError`는 `children`을 `errors`보다 먼저 쓴다. `errors`는 `message` 기준으로 중복을 제거하고, 1개면 텍스트, 여러 개면 `ul`로 보여 준다. 내용이 없으면 `null`을 렌더하며, truthy 판정은 `../../truthy.ts`의 `isTruthy`로 한다
- `DialogContent`의 `showCloseButton` 기본값은 true다. `DialogFooter`와 `CommandDialog`는 기본 false다. `CommandDialog`는 접근성을 위해 `DialogTitle`/`DialogDescription`을 `sr-only` 헤더로 항상 렌더한다
- `DropdownMenuSubContent`는 `DropdownMenuContent`를 재사용하고, 기본값으로 side=right, alignOffset=-3, sideOffset=0을 쓴다. Portal과 Positioner 구조를 같이 공유한다
- 컴포넌트 사이 의존 방향은 다음과 같다. `command`는 `dialog`, `input-group`에 의존한다. `attachment`/`dialog`/`sheet`/`input-group`는 `button`에 의존한다. `field`는 `label`, `separator`에 의존한다. `prompt-input`은 `input-group`에, `input-group`은 `input`, `textarea`에, `item`은 `separator`에 의존한다. 모두 `~/components/ui/*` alias로 가져온다
- 클래스 병합은 `cn` 모듈 alias로 하고 variant는 `cva`로 정의한다. 예외로 `data-list.tsx`는 `~/lib/utils`의 `cn`을 쓴다. `field.tsx`, `label.tsx`, `separator.tsx`는 파일 맨 위에 `"use client"`를 선언한다

## Side Effects

- `DialogContent`, `DropdownMenuContent`, `HoverCardContent`는 Base UI Portal로 팝업을 문서 body 쪽 DOM에 렌더한다
- `AnimatedNumber`는 `useEffect`에서 `motion/react` spring 값을 바꿔 브라우저 애니메이션 프레임을 돌린다
- 이 밖에 SQLite, 파일 시스템, 네트워크, 환경 변수 접근은 읽은 파일에 없다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
