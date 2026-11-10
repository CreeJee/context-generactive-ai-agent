# wording

## Overview

`lint/wording`은 한국어 문구 정책을 한곳에 모은다. 문구를 어디에 어떻게 쓰는지는 Lingui가 맡고, 이 디렉터리는 Lingui가 보지 않는 것, 곧 문구가 무엇을 말하는지만 맡는다.

- **쓰는 법**: Lingui 메시지(`<Trans>`, `` t`…` ``, `msg`)로 쓰는 자리에 쓴다. 매크로 고르기, 추출, 번역자 주석은 공식 skill(`.agents/skills/lingui-best-practices`, `enhanced-message-context`, `find-unwrapped-strings`)과 `lingui` CLI를 따른다. 서버 코드(빌드 없이 도는 `packages/memory-agent/src`, `apps/agent/server`)는 런타임 매크로(`@lingui/core/runtime-macro`)를 쓴다.
- **어디에 두는지**: 공식 `eslint-plugin-lingui`를 Oxlint JS 플러그인으로 불러 지킨다. 루트 `vite.config.ts`가 `policy.ts`의 `wordingScope`에 권장 규칙과 `no-unlocalized-strings`를 켜고, `wordingExempt`에서 끈다. 앱은 한국어만 쓰므로 한글이 없는 문자열은 문구가 아니다(`notWording`).
- **카탈로그가 소스와 맞는지**: 각 패키지의 `i18n:check` 작업(`lingui check sync --clean`)이 본다. 커밋 hook이 돌린다.
- **무엇을 말하는지**: Oxlint JS 플러그인 `wording`(`index.ts`)의 규칙 `wording/content`가 메시지의 금지 표현, 용어집, 말투를 Kiwi(`kiwi-nlp`) 형태소 분석으로 결정론적으로 검사한다. 에디터, `vp lint`, `vp check`(커밋 hook 포함)에서 lint 오류로 나온다. 범위는 위 공식 규칙과 같다.
- **카탈로그와 Claude 편집**: oxlint가 읽지 못하는 카탈로그(`.po`)의 화면 문구(`msgstr`)는 개발용 CLI `check/main.ts`(명령 이름 `wording-check`)가 커밋 hook(`*.po`)에서 같은 규칙으로 검사한다. Claude Code PostToolUse hook(`.claude/settings.json`)도 이 CLI로 고친 파일을 바로 검사해 에이전트에게 돌려준다.

## Interface

- `policy.ts`
  - 범위: `wordingScope`, `wordingExempt`(모델에 보내는 `prompts.ts`, 테스트, 마이그레이션 SQL 주석, 검색 fixture), `notWording`, `wordingCatalogs`, `linguiCoreMacroModules`, `linguiJsxMacroModules`
  - 내용: `phraseRules`(금지 표현), `glossary`(용어집), `registers`(문장 종류별 말투), `finalEndingTag`, `sentenceStopTags`
- `wording/content` (`rules/content.ts`의 `contentRule`) — Lingui 매크로 모듈을 import한 파일의 메시지를 검사해, 위반마다 메시지 위치에 `"문구": 메시지 [규칙]`을 보고한다. 검사할 수 없으면(모델을 받지 못함 등) 파일 첫머리에 `unchecked`를 보고한다.
- `checkSource(request)` (`rules/checker.ts`) — oxlint 규칙은 동기로 답해야 하므로, 처음 쓸 때 `check/worker.ts`를 worker thread로 띄우고 파일을 넘긴 뒤 `Atomics.wait`로 답을 기다린다. 메시지 추출과 Kiwi는 worker에서 돈다. 한 파일에 5분을 넘기면 `Unchecked`를 돌려준다.
- `wording-check check <file...>` — `wordingCatalogs`의 카탈로그(`.po`)는 메시지마다, `wordingScope` 안의 소스 파일은 그 파일이 선언한 메시지를 검사한다. 나머지 파일은 건너뛴다. 위반을 `위치 "문구" [규칙] 메시지`로 stderr에 쓰고, 하나라도 있으면 `WordingViolations`로 실패해 종료 코드 1을 낸다.
- `wording-check hook` — Claude Code PostToolUse hook. stdin에서 `tool_input.file_path`를 읽어 그 파일을 검사하고, 위반이 있으면 `{"decision":"block","reason":…}`를 stdout에 써 에이전트에게 돌려준다. 추출 전이라도 고친 소스의 메시지를 바로 본다.
- `check/messages.ts`
  - `catalogMessages(file, source)` — `@lingui/format-po`의 `parsePoFile`로 카탈로그를 읽는다. 화면에 나오는 번역(`msgstr`, 비었으면 원문)을 읽고 폐기된 항목은 건너뛴다.
  - `sourceMessages(file, source)` — `lingui extract`가 쓰는 네이티브 추출기(`@lingui/native-tools`의 `extractMessages`)로 소스 파일의 메시지를 읽는다. 카탈로그는 쓰지 않는다.
  - 둘 다 `{name}` 인자를 `X`로 읽고 `<0>` 태그를 뺀다.
- `check/check.ts`의 순수 함수 `phraseViolations`, `glossaryViolations`, `endingViolations`와, Kiwi를 쓰는 `checkMessages`

## Invariants

- 정책을 바꿀 때는 `policy.ts`만 고친다. `vite.config.ts`의 lint 범위, 커밋 hook, Claude hook은 모두 이 파일을 따른다.
- 말투: 서술과 요청은 합니다체(`~습니다`, `~해 주십시오`), 질문만 해요체(`~할까요?`)다. 종결어미가 없는 라벨은 마침표로 끝내지 않는다. 문장 끝은 종결어미(EF)와, 마침표·물음표·말줄임표(SF, SE) 앞이나 글 끝의 연결어미(EC)다. `요`로 끝나는 연결어미도 문장 끝으로 본다.
- 용어집의 라틴 표기는 대소문자를 가리지 않고 단어 경계로 맞추고, 한글 표기는 조사가 붙어도 맞춘다.
- Kiwi는 메시지가 있는 파일을 처음 만날 때만 적재한다(약 2초, 약 900 MB). 매크로를 import하지 않은 파일은 worker도 띄우지 않는다. 저장소 전체 lint는 이 규칙이 있어도 약 1초 늘어난다.
- 금지 표현은 안정적인 패턴만 둔다. 모델 세대마다 바뀌는 상투어는 목록에 넣지 않는다. LLM 판정은 쓰지 않는다.

## Side Effects

- 네트워크: 처음 쓸 때 Kiwi 모델(v0.24.1, 약 88 MB)을 GitHub release에서 내려받는다.
- 파일: 모델을 sha256과 압축 안 경로를 확인한 뒤 `node_modules/.cache/wording/kiwi-<version>`에 푼다. 임시 디렉터리에 풀고 이름을 바꿔 옮긴다.
- 프로세스: 압축 확인과 풀기에 `tar`를 실행한다.
- 스레드: lint 규칙은 lint를 돌리는 프로세스 안에 worker thread 하나를 띄운다(`unref`라 lint가 끝나면 함께 끝난다). 답을 기다리는 동안 lint 스레드는 멈춘다.

## Verification

- Run: `vp test lint/wording` (저장소 루트)
- Run: `tsc -p lint/wording/tsconfig.json` (저장소 루트)
- Run: `vp lint` (저장소 루트, `eslint-plugin-lingui`와 `wording` 플러그인을 불러옴)
- Run: `vp run agent#i18n:check` / `vp run memory-agent#i18n:check`
- Run: `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po apps/agent/server/locales/ko.po packages/memory-agent/src/locales/ko.po` (저장소 루트)
