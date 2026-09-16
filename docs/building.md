# 빌드 가이드

실행 파일 `context-agent`는 대상 플랫폼의 기기에서 빌드합니다. turbovec 네이티브 모듈을 해당 기기에서 컴파일하고, pnpm도 해당 기기용 네이티브 패키지(onnxruntime, sharp, keyring)만 받습니다. 크로스 빌드는 지원하지 않습니다.

## 지원 범위

| 플랫폼          | 릴리스(GitHub Actions) | 로컬 빌드 | 비고                        |
| --------------- | :--------------------: | :-------: | --------------------------- |
| macOS arm64     |           ✅           |    ✅     | 스모크 테스트 통과          |
| Windows x64     |           ✅           |    ✅     |                             |
| Linux x64/arm64 |           —            |    ✅     | 실험적. 아래 "Linux" 참고   |
| macOS x64       |           —            |    ✅     | 빌드는 되지만 확인하지 않음 |

## 준비물

| 도구                  | 용도                             | 설치                                                                                                                                     |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Git                   | 저장소                           |                                                                                                                                          |
| Vite+ (`vp`)          | Node 26.8.2, pnpm, 빌드와 테스트 | macOS/Linux `curl -fsSL https://vite.plus \| bash`, Windows(PowerShell) `irm https://vite.plus/ps1 \| iex`                               |
| Rust (stable, rustup) | turbovec 네이티브 애드온         | https://rustup.rs                                                                                                                        |
| C/C++ 빌드 도구       | Rust 링커, 네이티브 빌드         | macOS `xcode-select --install`, Windows Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발", Linux `build-essential`(Debian/Ubuntu) |

- Node는 루트 `.node-version`(26.8.2)을 Vite+가 읽어 맞춥니다. 따로 설치하지 않아도 됩니다. 실행 파일 빌드(Node SEA)에 25.7 이상이 필요합니다.
- `cargo`가 PATH에 있어야 합니다(rustup은 `~/.cargo/bin`에 설치). 없으면 turbovec 빌드가 `spawnSync cargo ENOENT`로 멈춥니다.

## 빌드

```bash
git clone git@github.com:CreeJee/topic-generactive-ai-agent.git
cd topic-generactive-ai-agent
vp install

cd apps/agent
vp run package         # turbovec(cargo) → memory-agent → 앱 빌드 → 실행 파일
vp run smoke-package   # 저장소 밖에서 실행해 확인(처음 한 번 codex 116 MB를 받음)
```

- 결과물: `apps/agent/dist/context-agent-<플랫폼>-<아키텍처>/context-agent`(Windows는 `.exe`)와 `.sha256`.
- `vp run package`는 필요한 네이티브 파일(turbovec, onnxruntime, keyring, sharp, Kiwi WASM)이 하나라도 없으면 무엇을 해야 하는지 알리고 멈춥니다.
- 빌드 결과는 Vite Task가 캐시합니다. 소스를 바꾸지 않았다면 turbovec은 cargo 없이 캐시에서 복원됩니다.
- 모노레포 전체 빌드만 할 때는 루트에서 `pnpm build`(또는 `vp run build`).
- 개발 서버는 루트에서 `vp run dev`([apps/agent](../apps/agent/README.md)).

## 실행 파일 쓰기

```bash
./context-agent [폴더] [--port 5173] [--no-open] [--storage <폴더>]
```

- 데이터와 첫 실행 때 풀리는 파일은 `~/.context-generactive-agent`에 둡니다. 임베딩 모델과 Kiwi 모델과 codex는 처음 필요할 때 받습니다.
- macOS 서명은 아래 "macOS 서명과 공증"을 보세요. 인증서 없이 만든 실행 파일은 ad-hoc 서명을 사용하므로 빌드한 기기에서만 경고 없이 실행됩니다.
  - 받는 쪽에서 "Mac에 손상을 입히거나 … 악성 코드가 없음을 확인할 수 없습니다"가 뜨면 공증되지 않은 파일입니다. 임시로는 Finder에서 우클릭 → 열기, 또는 `xattr -d com.apple.quarantine ./context-agent`.
  - Windows는 SmartScreen이 "추가 정보 → 실행"을 요구할 수 있습니다.
- 파일을 옮기거나 받을 때 실행 권한이 빠지면 macOS Finder가 텍스트 문서로 열려고 합니다. `chmod +x ./context-agent`로 되돌리고, 전달할 때는 권한이 보존되는 `.tar.gz`로 묶습니다.

## macOS 서명과 공증

다른 사람의 Mac에서 경고 없이 열리게 하려면 Developer ID로 서명하고 Apple에 공증(notarization)해야 합니다. 인증서와 Apple 자격 증명은 이 저장소나 GitHub secrets에 두지 않고, 서명하는 사람의 기기 키체인에만 둡니다. 이 자격 증명을 사용하는 공증 작업은 로컬에서 합니다.

준비(한 번):

1. Apple Developer Program 가입(연 $99) 후 Developer ID Application 인증서를 발급해 키체인에 넣습니다. 확인: `security find-identity -v -p codesigning`.
2. Apple ID의 [앱 암호](https://appleid.apple.com)를 만들고 notarytool 키체인 프로파일에 저장합니다.

   ```bash
   xcrun notarytool store-credentials context-agent \
     --apple-id <Apple ID> --team-id <Team ID> --password <앱 암호>
   ```

빌드와 공증:

```bash
cd apps/agent
CONTEXT_AGENT_SIGN_IDENTITY="Developer ID Application: <이름> (<Team ID>)" vp run package
vp run smoke-package     # 서명한 실행 파일로 한 번 더 확인 (아래 "라이브러리 검증")
vp run notarize          # dist/context-agent-darwin-arm64.dmg (+ .sha256)
```

- `CONTEXT_AGENT_SIGN_IDENTITY`가 없으면 ad-hoc 서명이고, `vp run notarize`는 이유를 말하며 멈춥니다. 프로파일 이름은 `CONTEXT_AGENT_NOTARY_PROFILE`로 바꿀 수 있습니다.
- 만들어진 `.dmg`를 릴리스에 올립니다: `gh release upload <태그> apps/agent/dist/context-agent-darwin-arm64.dmg{,.sha256}`.

알아둘 점:

- 하드닝 런타임이 필수입니다(공증 조건). `apps/agent/entitlements.plist`에는 실행에 필요한 예외만 지정합니다: V8의 JIT 두 개, 자식 프로세스로 뜨는 codex를 위한 dyld 환경 변수, 그리고 라이브러리 검증 해제.
- 라이브러리 검증: 실행 파일은 turbovec, onnxruntime, sharp, keyring 애드온을 처음 시작할 때 `<저장 루트>/runtime`에 풀어서 불러옵니다. 이 파일들은 우리 Team ID로 서명돼 있지 않아서 `com.apple.security.cs.disable-library-validation`이 없으면 로드가 막힙니다. ad-hoc 서명에서는 이 검증이 실제로 걸리지 않으므로, Developer ID로 처음 서명한 빌드는 반드시 `vp run smoke-package`를 다시 돌려 애드온 로드와 codex 실행을 확인하세요.
- `.dmg`인 이유: Mach-O 실행 파일 자체에는 공증 티켓을 붙일(staple) 수 없습니다. 티켓을 붙여야 인터넷이 없는 Mac에서도 경고 없이 열립니다. `.zip`을 공증하는 방법도 되지만 첫 실행마다 Apple 서버를 확인해야 합니다.
- `postject`가 SEA 블롭을 넣으면서 Mach-O를 고치기 때문에 Node가 달고 온 서명이 깨집니다. 그래서 서명은 항상 `vp pack` 뒤에 합니다(`scripts/package.ts`).

## 릴리스 (GitHub Actions)

`.github/workflows/release.yml`이 macOS arm64(`macos-15`)와 Windows x64(`windows-latest`)에서 빌드합니다.

1. GitHub에서 태그를 붙여 릴리스를 발행합니다(pre-release도 됨).
2. 워크플로가 각 러너에서 `vp run package` → `vp run smoke-package`를 돌립니다.
3. 통과하면 릴리스에 올립니다:
   - `context-agent-<태그>-darwin-arm64.tar.gz` (+ `.sha256`)
   - `context-agent-<태그>-win32-x64.zip` (+ `.sha256`)
   - 압축 안에는 실행 파일과 실행 파일의 `.sha256`이 있습니다.

릴리스 없이 확인만 하려면 Actions 탭에서 "Release binaries"를 수동 실행합니다. 압축 파일은 워크플로 artifact로 남습니다.

워크플로가 만든 macOS 실행 파일은 ad-hoc 서명입니다. 서명과 공증한 `.dmg`는 위 "macOS 서명과 공증"대로 로컬에서 만들어 같은 릴리스에 올립니다.

한 플랫폼이 실패해도 다른 플랫폼의 빌드는 계속 진행합니다(`fail-fast: false`). 실패한 플랫폼은 로그를 보고 고친 뒤 그 워크플로를 다시 실행하면 같은 릴리스에 덮어씁니다.

## Linux

Linux는 로컬 빌드만 지원하며, 명령은 위 "빌드" 절과 같습니다. 릴리스에서 제외한 이유와 실행 조건은 다음과 같습니다:

- glibc: 실행 파일은 빌드한 기기의 glibc보다 오래된 시스템에서 돌지 않습니다(turbovec `.so`가 그 기기 glibc에 묶임). 여러 배포판에 나눠 줄 것이라면 오래된 배포판(예: Ubuntu 22.04, glibc 2.35)에서 빌드합니다. Alpine(musl)은 onnxruntime-node에 musl 빌드가 없어 지원하지 않습니다.
- 키체인: codex 로그인 토큰과 Kagi 키는 OS 키체인에만 저장합니다. Linux에서는 Secret Service(D-Bus + gnome-keyring 또는 KWallet)가 필요합니다. GNOME, KDE 데스크톱에서는 되지만, SSH 서버, 헤드리스, WSL처럼 Secret Service가 없는 곳에서는 ChatGPT 로그인이 실패합니다.
  - 헤드리스에서 스모크 테스트를 돌리려면 세션 버스와 키링을 띄웁니다: `dbus-run-session -- sh -c 'echo -n "" | gnome-keyring-daemon --unlock && vp run smoke-package'`.
- 브라우저: `xdg-open`으로 엽니다. 없으면 터미널에 나온 주소를 직접 엽니다.
- 원격 접속: 서버는 `127.0.0.1`에만 열립니다. SSH로 쓰려면 `ssh -L 5173:127.0.0.1:5173 <호스트>`로 포트를 넘깁니다.

## 문제 해결

| 증상                                                             | 원인과 해결                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `spawnSync cargo ENOENT`                                         | Rust가 없거나 `~/.cargo/bin`이 PATH에 없음                                                         |
| `turbovec addon missing`                                         | turbovec 빌드 실패. Rust와 C/C++ 빌드 도구(Windows는 MSVC) 확인                                    |
| `sharp/onnxruntime-node/@napi-rs/keyring has no binary for …`    | 이 기기에서 `vp install`을 다시 실행(다른 기기의 `node_modules`를 복사해 오면 생김)                |
| 실행 파일 첫 실행에서 `Cannot find module …memory-turbovec.node` | turbovec 없이 만든 예전 실행 파일. 다시 `vp run package`                                           |
| 사이드바에 "codex를 받거나 설치하지 못했어요"                    | 실행한 창의 `codex install failed (<이유>): <상세>` 로그 확인(네트워크, 프록시, 인증서, 압축 풀기) |
| 시작할 때 `Quantization is not supported for ArchType::none`     | Kiwi WASM의 경고. 결과에 영향 없음                                                                 |
| 받는 쪽 Mac에서 "악성 코드가 없음을 확인할 수 없습니다"          | 공증되지 않은 파일. 위 "macOS 서명과 공증"의 `.dmg`를 주거나, 임시로 우클릭 → 열기                 |
| `vp run notarize`가 "signed ad-hoc"로 멈춤                       | `CONTEXT_AGENT_SIGN_IDENTITY`를 주고 `vp run package`를 다시 실행                                  |
