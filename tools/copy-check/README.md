# copy-check

## Overview

`tools/copy-check`는 앱 문구 카탈로그(`copy.ts`)의 문구를 결정론적으로 검사하는 개발용 CLI(`main.ts`, 명령 이름 `copy-check`)다. 문구를 어디에 두는지는 lint 규칙(`lint/copy`의 `copy/no-inline-copy`)이 맡고, 이 도구는 문구가 무엇을 말하는지만 본다. `oxc-parser`로 파일을 파싱해 한글이 든 문자열·템플릿·JSX 텍스트를 뽑는다. 그다음 금지 표현, 용어집, 문장 끝 말투를 검사한다. 말투는 Kiwi(`kiwi-nlp`) 형태소 분석으로 종결어미를 찾아 판정한다. 앱과 실행 파일에는 들어가지 않는다.

## Interface

- `copy-check check <file...>` — 주어진 `copy.ts` 파일을 검사한다. 위반을 `파일:줄:열 [규칙] 메시지` 형식으로 stderr에 쓰고, 하나라도 있으면 `CopyViolations`로 실패해 종료 코드 1을 낸다.
- `copy-check hook` — Claude Code PostToolUse hook. stdin의 hook 입력에서 `tool_input.file_path`를 읽어 이름이 `copy.ts`인 파일만 검사한다. 위반이 있으면 `{"decision":"block","reason":...}`을 stdout에 써서 에이전트가 바로 고치게 하고, 종료 코드는 0이다.
- `rules.ts`
  - `phraseRules` — 규칙 id별 금지 표현(`pattern`)과 고칠 방법(`message`). 번역투, 이중 피동, 과한 경어, 줄표, 느낌표, 이모지처럼 모델 세대가 바뀌어도 변하지 않는 패턴만 둔다.
  - `glossary` — 개념별로 쓸 말(`use`)과 피할 표기(`avoid`). 정한 용어만 넣고, 결정은 `docs/decisions.md`에 남긴다.
  - `registers` — 문장 종류(`Mood`: `statement`, `question`)별로 허용하는 종결어미. 서술과 요청은 합니다체(`~니다`, `~시오`)와 상태 라벨의 명사형(`음`/`ᆷ`), 질문은 해요체(`~요`, `죠`)다. `~습니까?`는 쓰지 않는다.
- `check.ts`
  - `phraseViolations(text)`, `glossaryViolations(text, entries?)`, `endingViolations(text, morphemes)` — 문구 하나의 위반을 돌려주는 순수 함수.
  - `checkCopy(file, texts)` — 세 검사를 합쳐 위치가 붙은 `Finding` 목록을 만든다. `Morphemes`가 필요하다.
- `extract.ts` — `extractCopy(file, source)`: 한글이 든 문구와 시작 줄·열. 템플릿 리터럴은 식 자리를 `X`로 바꿔 한 문장으로 읽는다. 파싱 오류는 `CopyParseFailed`.
- `morphemes.ts` — `Morphemes` 서비스(`tokenize`)와 `Morphemes.layer`. 모델을 받거나 불러오지 못하면 `MorphemeModelUnavailable`.

## Invariants

- 종결어미는 Kiwi 태그 `EF`이거나, 문장 부호(`S*`) 바로 앞이나 문구 끝의 연결어미(`EC*`)다. Kiwi가 `저장 중입니다…`의 `ᆸ니다`를 연결어미로 읽기 때문이다.
- 물음표가 바로 뒤따르거나 어미에 `까`가 들어 있으면(`~할까요`, `~습니까`) 질문으로 본다.
- 종결어미가 하나도 없는 문구는 라벨로 보고, 마침표로 끝나면 `label-period`로 보고한다.
- 용어집의 라틴 문자 표기는 라틴 문자·숫자 경계에서만, 대소문자 없이 맞춘다(`Plan`은 `Plan을`에 맞고 `Planner`에는 맞지 않는다). 한글 표기는 조사가 붙어도 맞도록 부분 문자열로 찾는다.
- Kiwi 모델 버전은 카탈로그의 `kiwi-nlp` 버전과 같아야 한다(`kiwiModel`). 둘은 함께 올린다.
- Kiwi는 검사할 `copy.ts`가 있을 때만 불러온다. 적재에 약 2초, 메모리 약 900 MB가 들어서, hook은 다른 파일을 고칠 때 0.3초 안에 끝나야 한다.

## Side Effects

- 네트워크: 처음 쓸 때 GitHub 릴리스에서 Kiwi 모델(약 88 MB)을 받는다.
- 파일: 모델을 sha256과 압축 안 경로를 확인한 뒤 `node_modules/.cache/copy-check/kiwi-<version>`에 푼다. 임시 디렉터리에 풀고 이름을 바꿔 옮긴다.
- 프로세스: 압축을 확인하고 풀 때 `tar`를 실행한다.

## Verification

- Run: `vp test tools/copy-check` (저장소 루트)
- Run: `tsc -p tools/copy-check/tsconfig.json` (저장소 루트)
- Run: `node tools/copy-check/main.ts check $(git ls-files '*/copy.ts')` (저장소 루트)
