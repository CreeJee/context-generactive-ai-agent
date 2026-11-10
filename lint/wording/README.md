# wording

## Overview

`lint/wording`은 한국어 문구 정책을 한곳에 모은다. 정책은 `policy.ts` 하나에 있고, 두 도구가 같은 정책을 읽는다.

- **어디에 두는지**: Oxlint JS 플러그인 `wording`(`index.ts`)의 규칙 `wording/no-raw-korean`이 지킨다. 루트 `vite.config.ts`가 `lint.jsPlugins`에 `{ name: "wording", specifier: "./lint/wording/index.ts" }`로 등록하고, `policy.ts`의 `wordingScope`에 `"error"`, `wordingExempt`에 `"off"`를 건다.
- **무엇을 말하는지**: 개발용 CLI `check/main.ts`(명령 이름 `wording-check`)가 Kiwi(`kiwi-nlp`) 형태소 분석으로 금지 표현, 용어집, 말투를 결정론적으로 검사한다. 커밋 hook(`staged`의 `*.{ts,tsx}`)과 Claude Code PostToolUse hook(`.claude/settings.json`)에서 돈다.

문구는 세 곳에만 쓸 수 있다.

| 자리                                                     | 쓰는 것                                     | lint | 검사                                      |
| -------------------------------------------------------- | ------------------------------------------- | ---- | ----------------------------------------- |
| Lingui 메시지 (`` t`…` ``, `msg(…)`, `<Trans>…</Trans>`) | 사람이 읽는 문구. 쓰이는 자리에 그대로 쓴다 | 허용 | `@lingui/native-tools` 추출기로 읽어 검사 |
| `copy.ts` 카탈로그                                       | 아직 Lingui로 옮기지 않은 디렉터리의 문구   | 허용 | oxc-parser로 문자열을 읽어 검사           |
| `prompts.ts`                                             | 사용자 대신 모델에 보내는 문장              | 허용 | 읽지 않음                                 |

테스트 파일(`*.test.ts(x)`, `*.spec.ts(x)`, `*.browser.ts(x)`)은 화면에서 찾을 문구를 직접 쓸 수 있다. 이 저장소가 직접 쓴 코드라 lint·fmt 대상이다.

## Interface

- `policy.ts`
  - 자리: `wordingScope`, `wordingExempt`, `linguiMacroModules`, `catalogFile`, `promptFile`, `testFile`
  - 내용: `phraseRules`(금지 표현), `glossary`(용어집), `registers`(문장 종류별 말투), `finalEndingTag`, `sentenceStopTags`
- `wording/no-raw-korean` (`rules/no-raw-korean.ts`의 `noRawKoreanRule`) — 한글이 든 문자열·템플릿·JSX 텍스트가 Lingui 메시지 안에도, `copy.ts`·`prompts.ts`·테스트 파일에도 없으면 보고한다. Lingui 메시지는 그 파일이 `linguiMacroModules`에서 import한 이름(`t`, `msg`, `Trans` 등, `useLingui`를 import하면 `t`도)의 태그·호출·JSX 요소 안을 말한다.
- `wording-check check <file...>` — 주어진 파일 중 정책 범위 안의 것만 검사한다. `copy.ts`는 문자열을, 매크로를 import한 파일은 Lingui 메시지를 읽는다. 위반을 `파일:줄:열 [규칙] 메시지`로 stderr에 쓰고, 하나라도 있으면 `WordingViolations`로 실패해 종료 코드 1을 낸다.
- `wording-check hook` — Claude Code PostToolUse hook. stdin에서 `tool_input.file_path`를 읽어 그 파일을 검사하고, 위반이 있으면 `{"decision":"block","reason":…}`를 stdout에 써 에이전트에게 돌려준다.
- `check/check.ts`의 순수 함수 `phraseViolations`, `glossaryViolations`, `endingViolations`와, Kiwi를 쓰는 `checkTexts`
- `check/extract.ts`의 `catalogTexts`(copy.ts 문자열)와 `messageTexts`(Lingui 메시지. `{name}` 인자는 `X`로 읽고 `<0>` 태그는 뺀다)

## Invariants

- 정책을 바꿀 때는 `policy.ts`만 고친다. `vite.config.ts`의 lint 범위, 커밋 hook, Claude hook은 모두 이 파일을 따른다.
- 말투: 서술과 요청은 합니다체(`~습니다`, `~해 주십시오`), 질문만 해요체(`~할까요?`)다. 종결어미가 없는 라벨은 마침표로 끝내지 않는다. 문장 끝은 종결어미(EF)와, 마침표·물음표·말줄임표(SF, SE) 앞이나 글 끝의 연결어미(EC)다. `요`로 끝나는 연결어미도 문장 끝으로 본다.
- 용어집의 라틴 표기는 대소문자를 가리지 않고 단어 경계로 맞추고, 한글 표기는 조사가 붙어도 맞춘다.
- Kiwi는 문구가 있는 파일이 있을 때만 적재한다(약 2초, 약 900 MB). 문구가 없는 커밋과 편집은 바로 끝난다.
- 금지 표현은 안정적인 패턴만 둔다. 모델 세대마다 바뀌는 상투어는 목록에 넣지 않는다. LLM 판정은 쓰지 않는다.

## Side Effects

- 네트워크: 처음 쓸 때 Kiwi 모델(v0.24.1, 약 88 MB)을 GitHub release에서 내려받는다.
- 파일: 모델을 sha256과 압축 안 경로를 확인한 뒤 `node_modules/.cache/wording/kiwi-<version>`에 푼다. 임시 디렉터리에 풀고 이름을 바꿔 옮긴다.
- 프로세스: 압축 확인과 풀기에 `tar`를 실행한다.

## Verification

- Run: `vp test lint/wording` (저장소 루트)
- Run: `tsc -p lint/wording/tsconfig.json` (저장소 루트)
- Run: `vp lint` (저장소 루트, 플러그인을 불러옴)
- Run: `node lint/wording/check/main.ts check $(git ls-files apps/agent/app apps/agent/server packages/memory-agent/src)` (저장소 루트)
