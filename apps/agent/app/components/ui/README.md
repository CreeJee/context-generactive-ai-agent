# ui

## Overview

`apps/agent/app/components/ui`는 agent 앱 프론트엔드가 공유하는 shadcn 스타일 디자인 시스템 프리미티브 모음이다. 대부분 `@base-ui/react` 프리미티브(Dialog, Menu, PreviewCard, Collapsible, Input, Separator, Select, Tabs, Tooltip 등)와 `cmdk`를 감싸고, `class-variance-authority`의 variant와 `cn` 클래스 병합으로 Tailwind 스타일을 입힌다. 각 컴포넌트는 `data-slot` 속성을 달아 서로의 CSS 선택자로 레이아웃을 조정한다. 도메인 로직이나 데이터 접근 없이 순수 표현 계층을 이룬다. 위쪽 앱 컴포넌트는 `~/components/ui/<name>` 경로로 가져다 쓴다.

## Interface

- `Button`, `buttonVariants` — `@base-ui/react/button` 래퍼다. variant는 default/outline/secondary/ghost/ghost-muted/destructive/link이고, size는 default/xs/sm/lg/icon/icon-xs/icon-sm/icon-lg이다. attachment, dialog, sheet, input-group가 의존한다
- `Badge`, `badgeVariants` — `useRender` 기반 span 배지다. `render` prop으로 태그를 바꿀 수 있다
- `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction` — `role="alert"` 알림 박스다. variant는 default/destructive이다
- `AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogFooter`, `AlertDialogMedia`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogOverlay`, `AlertDialogPortal` — Base UI AlertDialog 래퍼다. 되돌릴 수 없는 동작을 확인받는다. `AlertDialogContent`의 size는 default/sm이다
- `Sidebar` 계열(`SidebarProvider`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupAction`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuAction`, `SidebarMenuBadge`, `SidebarMenuSkeleton`, `SidebarMenuSub*`, `SidebarInset`, `SidebarInput`, `SidebarRail`, `SidebarSeparator`, `SidebarTrigger`, `useSidebar`) — 접히는 앱 사이드바다. 넓은 화면에서는 offcanvas로 접히고 ⌘B/Ctrl+B로 토글한다. 768px 미만에서는 `Sheet`로 열린다
- `Skeleton` — 불러오는 중인 자리를 채우는 `animate-pulse` 블록이다
- `Progress`, `ProgressTrack`, `ProgressIndicator`, `ProgressLabel`, `ProgressValue` — Base UI Progress 래퍼다. `Progress`는 `value`·`max`를 받아 트랙과 막대를 직접 그린다
- `Toggle`, `toggleVariants` — 눌림 상태를 가진 Base UI Toggle 버튼이다. variant는 default/outline, size는 default/sm/lg이다
- `ToggleGroup`, `ToggleGroupItem` — Base UI ToggleGroup 래퍼다. `multiple`이 없으면 하나만 눌린다. `spacing={0}`이면 붙은 세그먼트 모양이 된다
- `ButtonGroup`, `ButtonGroupText`, `ButtonGroupSeparator`, `buttonGroupVariants` — 이웃한 버튼을 `role="group"`으로 묶고 맞닿은 모서리를 지운다. 분할 버튼(동작 + 메뉴)에 쓴다
- `Message`, `MessageGroup`, `MessageAvatar`, `MessageContent`, `MessageHeader`, `MessageFooter` — 채팅 메시지 한 줄의 틀이다. `align="end"`면 오른쪽에 붙고, `MessageContent` 안의 slot 요소도 오른쪽으로 민다
- `Bubble`, `BubbleGroup`, `BubbleContent`, `BubbleReactions` — 말풍선이다. variant는 default/secondary/muted/tinted/outline/ghost/destructive이고, 색은 안쪽 `BubbleContent`에 입힌다
- `Trace`, `TraceLine`, `TraceIcon`, `TraceTitle`, `TraceDescription`, `TraceCollapsible`, `TraceCollapsibleTrigger`, `TraceCollapsibleContent` — 에이전트가 한 일(도구 호출, 추론)을 한 줄씩 보여 준다. `TraceLine`의 `status`는 running(제목에 shimmer)/error/pending이다. 접는 행은 끝에 회전하는 chevron을 붙인다
- `CodeBlock`, `CodeBlockHeader`, `CodeBlockTitle`, `CodeBlockActions`, `CodeBlockCopyButton`, `CodeBlockContent`, `CodeBlockLine`, `CodeBlockFooter` — 코드·로그 블록이다. variant는 default/destructive, size는 default/sm이다. `CodeBlockContent`의 `wrap`은 긴 줄을 접고, `lineNumbers`는 줄 번호를 단다. 칠하기는 하지 않는다. 채팅의 도구 블록은 Streamdown의 하이라이터(`entry/chat/markdown.tsx`의 `codeHighlighter`)로 칠한 토큰을 `CodeBlockLine`에 넣는다
- `MessageScrollerProvider`, `MessageScroller`, `MessageScrollerViewport`, `MessageScrollerContent`, `MessageScrollerItem`, `MessageScrollerButton`, `useMessageScroller`, `useMessageScrollerScrollable`, `useMessageScrollerVisibility` — `@shadcn/react/message-scroller` 래퍼다. Provider의 `autoScroll`이면 맨 아래에서 `scrollEdgeThreshold` 안일 때 새 내용을 따라 내려간다. `MessageScrollerContent`의 직계 자식이 하나하나 항목이고, 첫 항목이 뒤로 밀리면 위에 끼운 것으로 보고 보이던 항목의 자리를 지킨다. `MessageScrollerButton`은 맨 끝(또는 처음)에서 멀어지면 나타난다
- `useIsMobile` (`~/hooks/use-mobile`) — 768px 미만인지 `matchMedia`로 따라가는 훅이다. 첫 렌더는 false다
- `AnimatedNumber` — `motion/react` spring으로 숫자를 `ko-KR` 형식으로 부드럽게 바꿔 보여 준다. 스크린리더용 sr-only 값을 따로 렌더한다
- `Attachment`, `AttachmentGroup`, `AttachmentMedia`, `AttachmentContent`, `AttachmentTitle`, `AttachmentDescription`, `AttachmentActions`, `AttachmentAction`, `AttachmentTrigger` — 첨부 파일 카드 묶음이다. `state`는 idle/uploading/processing/error/done이고 size·orientation variant를 둔다
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` — 카드 레이아웃이다. size는 default/sm, variant는 default/warning이다
- `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` — Base UI Collapsible 래퍼다
- `Combobox`, `ComboboxInput`, `ComboboxContent`, `ComboboxList`, `ComboboxItem`, `ComboboxGroup`, `ComboboxLabel`, `ComboboxCollection`, `ComboboxEmpty`, `ComboboxSeparator`, `ComboboxChips`, `ComboboxChip`, `ComboboxChipsInput`, `ComboboxTrigger`, `ComboboxValue`, `useComboboxAnchor` — Base UI Combobox 래퍼다. `ComboboxInput`은 input-group 안에 열기 버튼(`showTrigger`, 기본 true)과 지우기 버튼(`showClear`)을 둔다. `ComboboxContent`는 `anchor`가 있으면 `data-chips`로 칩 입력 너비를 따른다
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
- 컴포넌트 사이 의존 방향은 다음과 같다. `command`는 `dialog`, `input-group`에 의존한다. `combobox`는 `button`, `input-group`에 의존한다. `attachment`/`dialog`/`sheet`/`input-group`는 `button`에 의존한다. `field`는 `label`, `separator`에 의존한다. `prompt-input`은 `input-group`에, `input-group`은 `input`, `textarea`에, `item`은 `separator`에 의존한다. 모두 `~/components/ui/*` alias로 가져온다
- `sidebar`는 `button`, `input`, `separator`, `sheet`, `skeleton`, `tooltip`, `~/hooks/use-mobile`에 의존하고, `alert-dialog`는 `button`에 의존한다. 두 파일과 `skeleton`, `use-mobile`은 `shadcn add sidebar alert-dialog`로 받았다. 이미 있던 `button`·`input`·`separator`·`tooltip`·`sheet`는 CLI가 덮어쓴 것을 되돌렸다
- `progress`, `toggle`, `toggle-group`, `button-group`은 `shadcn add progress toggle-group button-group`으로 받았다. CLI가 덮어쓴 `separator`는 되돌렸다. `toggle-group.tsx`는 `--gap`을 `CSSProperties`에 길이(`calc(var(--spacing) * N)`)로 선언해 `as` 단언을 없앴고, `gap-(--gap)`이 그 값을 읽는다
- `sidebar.tsx`는 아래 임의 값 치환 말고는 CLI 원본과 다음만 다르다. 저장소 lint를 통과하려고 `--sidebar-width`·`--sidebar-width-icon`·`--skeleton-width`를 `CSSProperties`에 선언해 `as` 단언을 없앴다. `setOpen`은 boolean만 받는다. `SidebarMenuButton`의 `tooltip`은 `ReactNode`다. `SidebarSeparator`는 `data-horizontal:w-auto`를 쓴다. 원본의 `w-auto`는 `Separator`의 `data-horizontal:w-full`에 져서 사이드바 밖으로 8px 넘쳤다
- `message`, `bubble`은 `shadcn add message bubble`로, `trace`는 `shadcn add trace`로 받았다. 아래 임의 값 치환만 CLI 원본과 다르다. `trace`는 `collapsible`에 의존하고, CLI가 덮어쓴 `collapsible`은 되돌렸다
- `code-block`은 `shadcn add code-block`으로 받았다. CLI가 함께 준 `~/hooks/use-highlighted-code`·`~/lib/highlighter`와 의존성 `shiki`는 지웠고, CLI가 덮어쓴 `button`은 되돌렸다. `code-block.tsx`는 저장소 lint를 통과하려고 `typeof` 대신 `Predicate.isString`을 쓰고, 줄 번호 시작값을 inline `counterReset` 대신 `CSSProperties`에 선언한 `--code-block-line-start`로 넘기는 것만 CLI 원본과 다르다
- `message-scroller`는 `shadcn add message-scroller`로 받았고, 아래 임의 값 치환만 CLI 원본과 다르다. 의존성 `@shadcn/react`가 catalog에 들어갔고, CLI가 덮어쓴 `button`은 되돌렸다. 앱 코드는 `MessageScrollerContent`에 여백·간격을 줄 수 있다(루트 `vite.config.ts`의 `no-restyle` contract)
- 이 폴더는 shadcn의 `no-restyle`만 받지 않는다(루트 `vite.config.ts`의 override). 컴포넌트끼리 클래스로 조합하므로 @shadcn/lint 문서가 컴포넌트 폴더에 권하는 설정이다. anti-slop 규칙, 나머지 shadcn 규칙, Effect 언어 서비스 진단은 그대로 받는다. CLI로 받은 파일이 규칙에 걸리면 그 파일을 고치고 CLI 원본과 다른 점을 여기에 적는다
- CLI 원본의 임의 값은 테마 값으로 바꿨다(`no-arbitrary-values`). 새로 받은 파일도 같은 표로 바꾼다
  - 같은 값: `text-[0.625rem]` → `text-3xs`, `ring-[3px]` → `ring-3`, `p-[3px]` → `p-0.75`, `py-[calc(--spacing(1.25))]` → `py-1.25`, `rounded-[2px]` → `rounded-xs`, `rounded-[inherit]` → `rounded-inherit`(`app.css`의 utility)
  - 가장 가까운 반경 단계: `rounded-[calc(var(--radius-sm)-2px)]` → `rounded-xs`(2.32px → 2px), `rounded-[calc(var(--radius-sm)+2px)]` → `rounded-md`(6.32px → 5.76px). `rounded-[min(var(--radius-md),8px)]`는 지금 반경에서 `rounded-md`와 같아, 이미 `rounded-md`인 base에 맡기고 지웠다
  - `transition-[…]`: 크기·위치를 움직이는 것은 `transition-all`, 색·그림자·이동·투명도는 `transition`
  - 색은 `app.css`의 토큰이다. `color-mix(…, var(--foreground) 5%)` hover는 `secondary-hover`·`muted-hover`, `tinted` Bubble의 `oklch(from var(--primary) …)`는 `primary-tint`·`primary-tint-hover`다. 다크 값은 `.dark`의 `--primary-tint`가 맡아 `dark:` 클래스를 지웠다
  - `shadow-[0_0_0_1px_…]` → `shadow-sidebar-outline`·`shadow-sidebar-outline-hover`, `ease-[cubic-bezier(…)]` → `ease-in-expo`·`ease-out-quint`
  - `InputGroupButton`은 cva 대신 `data-size` 선택자로 크기를 고른다. 클래스 목록이 정적이어야 `require-static-classes`가 검사할 수 있다
- 클래스 병합은 `cn` 모듈 alias로 하고 variant는 `cva`로 정의한다. 예외로 `data-list.tsx`는 `~/lib/utils`의 `cn`을 쓴다. `field.tsx`, `label.tsx`, `separator.tsx`, `combobox.tsx`는 파일 맨 위에 `"use client"`를 선언한다

## Side Effects

- `DialogContent`, `DropdownMenuContent`, `HoverCardContent`, `ComboboxContent`는 Base UI Portal로 팝업을 문서 body 쪽 DOM에 렌더한다
- `AnimatedNumber`는 `useEffect`에서 `motion/react` spring 값을 바꿔 브라우저 애니메이션 프레임을 돌린다
- 이 밖에 SQLite, 파일 시스템, 네트워크, 환경 변수 접근은 읽은 파일에 없다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
