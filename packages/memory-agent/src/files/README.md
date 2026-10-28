# files

## Overview

`packages/memory-agent/src/files`는 에이전트 파일 도구(`list_files`, `search_files`, `read_outside_file`, 승인 게이트 쓰기 등)가 쓰는 호스트 파일 접근 계층이다. 프로젝트 상대 경로와 외부 절대 경로를 lstat·inode·자격증명 이름 규칙으로 검증한다(`paths.ts`). Git(`git ls-files`/`git grep`) 또는 디렉터리 순회로 파일 목록과 후보를 만든다(`listing.ts`, `git-grep.ts`). 2 MiB 이하 UTF-8 텍스트를 링크를 따르지 않고 읽고, sha256 낙관적 동시성으로 생성·원자적 교체·삭제한다(`text.ts`). 리터럴 줄 검색은 페이지 단위와 base64url 커서로 이어 간다(`search.ts`).

## Interface

- `PathRejected` — 경로 거부 TaggedError, reason은 `invalid_path`/`credential`/`git_internal`/`inside_project`/`outside_tool_root`/`symlink`/`hard_link`/`not_found`/`not_file`/`not_directory`
- `isCredentialPath` — 자격증명 디렉터리·파일명·`.env`·확장자·secret 단어 세그먼트로 비밀 경로인지 판정하는 이름 기반 가드
- `pathsOverlap` — 두 절대 경로가 같거나 한쪽이 다른 쪽을 포함하는지 철자로 비교(dual)
- `canonicalPathEffect` — realPath로 심볼릭 링크를 풀고, 없는 접미부는 가장 가까운 존재 부모를 거쳐 정규 경로를 만듦
- `resolveProjectPath` / `ProjectPath` — 프로젝트 상대 경로를 세그먼트마다 lstat으로 해석, kind `file`/`directory`/`new-or-file` (dual: root를 마지막 인자로)
- `resolveOutsidePath` / `OutsidePath` — 외부 도구용 절대 경로 해석, 철자와 정규 대상 모두 자격증명 검사, 프로젝트·저장소 루트 내부는 거부
- `resolveFencedOutsidePath` / `ToolFence` / `Fenced<P>` — `resolveOutsidePath` 뒤에 `deniedRoots`와 같거나 아래·위인 대상을 거부(칸반 카드 같은 fenced 실행)
- `gitEnvironment` — git 폴더와 시스템 폴더만 PATH에 둔 helper 환경(사용자 경로 제외)
- `gitNames({ stdout, limit })` — Git `-z` 출력에서 이름을 `limit + 1`개까지만 읽어 `{ names, truncated }`를 반환. git grep과 ls-files가 함께 쓴다
- `gitGrepFilesEffect({ root, directory, query, caseSensitive, limit })` — `git grep --untracked -z -l -F`로 질의를 포함한 파일 후보 HashSet 반환, 사용할 수 없거나 일치 파일이 `limit`개를 넘으면 null
- `listProjectFilesEffect` — Git(`ls-files --cached --others --exclude-standard`) 또는 순회로 프로젝트 정규 파일 목록과 glob 필터, `FileListing` 반환
- `listOutsideFilesEffect` — 외부 디렉터리를 Git 무시 규칙 없이 순회해 절대 경로 목록 반환
- `FileListing` / `walkLimit` — 목록 결과 타입(`paths`, `source: git|walk`, `excluded`, `truncated`)과 순회·Git 목록 공통 상한 50_000
- `createSnapshots` / `Snapshot` — UUIDv4 id로 최근 목록을 Ref에 보관(기본 용량 32)하는 `add`/`get(id, root)` 저장소, 페이지 간 고정 파일 집합 제공
- `searchTextFilesEffect` / `SearchTextInput` / `SearchPage` / `SearchMatch` / `SearchSkip` / `SearchPosition` / `SearchOptions` — 고정 파일 목록에 대한 한 페이지 리터럴 줄 검색, `candidates`로 열 파일 제한, 선택적 `readPage` 경로
- `encodeSearchCursor` / `decodeSearchCursor` / `SearchCursor` — snapshot·query·caseSensitive·file·line을 JSON+base64url 불투명 토큰으로 인코딩/디코딩(디코딩 실패는 undefined)
- `FileReadPlatform` — `windows`|`posix` Context.Reference, 기본값은 `process.platform`, OS 경계를 테스트에서 바꾸기 위함
- `maxTextBytes` — 파일 도구가 읽기·검색·재작성하는 최대 크기 2 MiB
- `TextFileRejected` / `TextFileRejectedReason` / `textFileRejectedReasonName` — `too_large`/`binary`/`invalid_utf8`/`changed`/`exists` 거부 오류와 이름 변환
- `TextFileIoFailed` / `TextFileIoReason` — 실패한 연산(`open`,`stat`,`read`,`mkdir`,`write`,`sync`,`close`,`rename`,`remove`)과 시스템 code를 담은 I/O 오류
- `readFileBytesEffect` / `FileBytes` — 플랫폼별 원시 바이트 읽기, `checkLeaf`로 열린 핸들의 정규 파일·단일 링크 검사
- `decodeTextEffect` / `readTextFileEffect` / `TextFile` — NUL 포함 시 binary, fatal UTF-8 디코드, text·sha256·bytes·mode 반환
- `createTextFileEffect` — 부모를 만들고 `wx` 플래그·0o644로 새 파일 생성, 이미 있으면 `exists`
- `replaceTextFileEffect` / `deleteTextFileEffect` — `expectedSha256`이 맞을 때만 임시 파일+rename으로 원자적 교체하거나 삭제
- `LinePage` / `linePage` / `linePageOf` / `splitLines` / `readPageCharacters` / `createTextPageReader` — 줄 범위 페이지(content, startLine, endLine, totalLines, nextStartLine, lineTruncated), 16_000자 페이지, 호출 간 오프셋과 digest만 남기는 페이지 리더(`createTextPageReader`는 리더 함수를 만드는 Effect)
- `sha256` — `../runtime/synchronous-crypto.ts`에서 재수출
- 하위 디렉터리 없음

## Invariants

- 자격증명처럼 보이는 경로(`isCredentialPath`)는 어떤 승인으로도 열리지 않는다(R04/R05 주석). 목록에서는 제외하고 개수를 `excluded`로 센다. 해석 시 `credential`로 거부한다.
- `.git` 세그먼트(대소문자 무시)는 `git_internal`로 거부하고 목록에서도 뺀다. 순회는 `.git`, `node_modules` 디렉터리로 내려가지 않는다.
- `resolveProjectPath`는 절대 경로, 백슬래시, 제어 문자, 빈·`.`·`..`·앞뒤 공백 세그먼트를 `invalid_path`로 거부한다. 각 세그먼트를 lstat한다. 어느 단계든 SymbolicLink면 `symlink`로 거부한다. file 계열은 nlink가 정확히 1이어야 하며 아니면 `hard_link`이다. 주석상 동시 디렉터리 교체를 막는 OS 샌드박스는 아니다.
- `resolveOutsidePath`는 철자와 정규 대상 모두에 자격증명 검사를 한다. 프로젝트나 앱 저장소 루트 내부를 가리키면 `inside_project`로 거부한다. fenced 실행은 denied root의 같은 경로·하위·상위를 모두 거부한다. 상위를 목록화하면 거부된 트리가 보이기 때문이다.
- `canonicalPathEffect`는 NotFound일 때만 부모로 올라가 해석한다. 권한·I/O 실패를 추측 경로로 바꾸면 안 된다.
- `isSameOrBelow`는 철자가 아닌 dev+inode로 비교한다. 대소문자 무시 볼륨 우회를 막기 위함이다. ino가 없으면 `invalid_path`로 거부한다.
- POSIX 읽기·생성·임시 파일은 `noFollow: true`로 연다. Windows는 O_NOFOLLOW가 없다. 대신 lstat으로 관찰된 링크 leaf를 거부하며, 주석상 원자적 보장은 아니다.
- 텍스트 파일은 `maxTextBytes`(2 MiB) 이하여야 한다. stat 크기와 실제 읽은 바이트 모두 검사한다. NUL 바이트가 있으면 binary, fatal UTF-8 디코드 실패는 invalid_utf8이다.
- 교체·삭제는 읽은 시점의 sha256(`expectedSha256`)과 현재 내용이 같을 때만 진행한다. 교체는 임시 파일을 쓰고 sync한다. 그 핸들 scope를 닫은 뒤 다시 확인하고 rename한다. rename은 uninterruptible이다. release는 실패·중단에도 임시 파일을 `force` 삭제한다. 원래 permission bits(mode & 0o7777)를 유지한다.
- `git grep` 경로는 줄바꿈이 있는 질의를 처리하지 않는다. 비ASCII 대소문자 무시 질의도 처리하지 않는다. 이때 null을 반환하고, 호출자가 모든 파일을 직접 검색한다. git grep은 파일만 좁히며 줄 매칭은 호출자가 한다.
- Git 출력은 바이트가 아니라 이름 개수로 자른다(`gitNames`). ls-files는 `walkLimit`(50_000)개에서 읽기를 멈추고 `truncated`를 표시한다. git grep은 일치 파일이 `limit`를 넘으면 null로 폴백한다. 도중에 멈춘 git은 종료를 기다리지 않고 Scope와 함께 끝낸다. PlatformError가 나면 null로 폴백한다. exit 0만 성공이다. git grep exit 1은 빈 집합이다.
- Git 목록은 링크와 삭제된 파일도 포함한다. 그래서 동시성 64로 lstat을 다시 해 정규 `File`만 남긴다. 결과 paths는 정렬한다.
- 순회는 자식 방문 전에 현재 디렉터리를 끝까지 읽고 닫는다. 깊이가 FD를 더 쓰지 않게 하기 위함이다. 읽을 수 없는 디렉터리는 건너뛴다. 50_000개에서 멈추고 `truncated`를 표시한다.
- 검색 페이지 한도: 일치 100개, 약 12_000자, 페이지당 파일 2_000개, 스니펫 300자. 미리 읽기는 4개이며 결과는 순서대로 취한다. 한 줄당 일치는 하나다. not_found나 ENOENT로 사라진 파일은 조용히 빠진다. 다른 거부는 `skipped`로 보고한다.
- 대소문자 구분 질의는 바이트에 질의가 없으면 디코드하지 않는다. 그래서 binary·non-UTF-8 파일은 일치 가능성이 있을 때만 skipped로 보고된다.
- 스냅샷은 같은 root에서만 조회된다(`get(id, root)`). 용량을 넘으면 오래된 것부터 버린다. 페이지 넘김은 고정된 스냅샷 파일 집합을 따라야 한다.
- `createTextPageReader`는 호출 사이에 오프셋과 digest만 남긴다. 핸들과 디코드된 텍스트는 그 호출의 Scope에 속한다(문서 주석).

## Side Effects

- 자식 프로세스: `findExecutable("git")`으로 찾은 git을 `ChildProcessSpawner`로 실행한다(`grep`, `ls-files`). cwd는 프로젝트 root, `extendEnv: false`, stderr는 ignore이다. 환경은 `gitEnvironment`이며 grep에는 `LANG=C`, `GIT_PAGER=cat`이 추가된다.
- 파일 시스템 읽기: lstat, realPath, openDirectory 순회, 위치 지정 read(64 KiB 청크), stat이 일어난다. NodeFileSystem 레이어를 내부에서 `Layer.build`한다.
- 파일 시스템 쓰기: `makeDirectory`(recursive)로 부모 디렉터리를 만든다. `wx` 플래그로 새 파일을 쓰고 sync한다. 같은 디렉터리에 `.<name>.<uuid>.tmp` 임시 파일을 쓰고 rename한 뒤 임시 파일을 remove한다. 삭제 도구는 파일을 제거한다.
- 난수: `Crypto.randomUUIDv4`로 스냅샷 id와 임시 파일 이름을 만든다(NodeCrypto 레이어).
- 인메모리 상태: `createSnapshots`가 Ref에 최근 스냅샷 목록을 보관한다. `createTextPageReader`는 최근 파일 8개의 줄 색인을 Ref에 보관한다. 검색은 `Stream.mapEffect`(동시성 `readAhead + 1`)로 다음 파일들을 미리 읽고 `Stream.scanEffect`로 순서대로 모으며, 페이지가 차면 멈춘다.
- 환경 읽기: `process.platform`으로 기본 `FileReadPlatform`을 정한다. glob 대소문자 구분 여부도 이것으로 정한다(darwin, win32는 nocase).

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
