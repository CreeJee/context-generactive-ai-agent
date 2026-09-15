# 빌드 가이드

실행 파일 `context-agent`는 **그 플랫폼 기기에서** 빌드합니다. 네이티브 모듈(turbovec)을 그 기기에서 컴파일하고, pnpm은 그 기기용 네이티브 패키지(onnxruntime, sharp, keyring)만 받기 때문입니다. 크로스 빌드는 하지 않습니다.

## 지원 범위

| 플랫폼          | 릴리스(GitHub Actions) | 로컬 빌드 | 비고                        |
| --------------- | :--------------------: | :-------: | --------------------------- |
| macOS arm64     |           ✅           |    ✅     | 스모크 테스트 통과          |
| Windows x64     |           ✅           |    ✅     |                             |
| Linux x64/arm64 |           —            |    ✅     | 실험적. 아래 "Linux" 참고   |
| macOS x64       |           —            |    ✅     | 빌드는 되지만 확인하지 않음 |

## 준비물

| 도구                  | 용도                           | 설치                                                                                                                                     |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Git                   | 저장소                         |                                                                                                                                          |
| Vite+ (`vp`)          | Node 26.8.2, pnpm, 빌드·테스트 | macOS/Linux `curl -fsSL https://vite.plus \| bash`, Windows(PowerShell) `irm https://vite.plus/ps1 \| iex`                               |
| Rust (stable, rustup) | turbovec 네이티브 애드온       | https://rustup.rs                                                                                                                        |
| C/C++ 빌드 도구       | Rust 링커, 네이티브 빌드       | macOS `xcode-select --install`, Windows Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발", Linux `build-essential`(Debian/Ubuntu) |

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

- 데이터와 첫 실행 때 풀리는 파일은 `~/.context-generactive-agent`에 둡니다. 임베딩·Kiwi 모델과 codex는 처음 필요할 때 받습니다.
- 서명은 ad-hoc만 합니다(Developer ID 서명·공증은 미룸).
  - macOS에서 브라우저로 받은 파일은 "확인할 수 없는 개발자" 경고가 뜹니다. Finder에서 우클릭 → 열기로 한 번 허용하거나 `xattr -d com.apple.quarantine ./context-agent`로 격리 속성을 지웁니다.
  - Windows는 SmartScreen이 "추가 정보 → 실행"을 요구할 수 있습니다.
- 파일을 옮기거나 받을 때 실행 권한이 빠지면 macOS Finder가 텍스트 문서로 열려고 합니다. `chmod +x ./context-agent`로 되돌리고, 전달할 때는 권한이 보존되는 `.tar.gz`로 묶습니다.

## 릴리스 (GitHub Actions)

`.github/workflows/release.yml`이 macOS arm64(`macos-15`)와 Windows x64(`windows-latest`)에서 빌드합니다.

1. GitHub에서 태그를 붙여 릴리스를 발행합니다(pre-release도 됨).
2. 워크플로가 각 러너에서 `vp run package` → `vp run smoke-package`를 돌립니다.
3. 통과하면 릴리스에 올립니다:
   - `context-agent-<태그>-darwin-arm64.tar.gz` (+ `.sha256`)
   - `context-agent-<태그>-win32-x64.zip` (+ `.sha256`)
   - 압축 안에는 실행 파일과 실행 파일의 `.sha256`이 있습니다.

릴리스 없이 확인만 하려면 Actions 탭에서 "Release binaries"를 수동 실행합니다. 압축 파일은 워크플로 artifact로 남습니다.

한 플랫폼이 실패해도 다른 플랫폼은 끝까지 돕니다(`fail-fast: false`). 실패한 플랫폼은 로그를 보고 고친 뒤 그 워크플로를 다시 실행하면 같은 릴리스에 덮어씁니다.

## Linux

로컬 빌드만 지원합니다. 위 "빌드"와 같은 명령으로 됩니다. 릴리스에 넣지 않은 이유와 알아둘 점:

- **glibc**: 실행 파일은 빌드한 기기의 glibc보다 오래된 시스템에서 돌지 않습니다(turbovec `.so`가 그 기기 glibc에 묶임). 여러 배포판에 나눠 줄 것이라면 오래된 배포판(예: Ubuntu 22.04, glibc 2.35)에서 빌드합니다. Alpine(musl)은 onnxruntime-node에 musl 빌드가 없어 지원하지 않습니다.
- **키체인**: codex 로그인 토큰과 Kagi 키는 OS 키체인에만 저장합니다. Linux에서는 Secret Service(D-Bus + gnome-keyring 또는 KWallet)가 필요합니다. GNOME·KDE 데스크톱에서는 되지만, SSH 서버·헤드리스·WSL처럼 Secret Service가 없는 곳에서는 ChatGPT 로그인이 실패합니다.
  - 헤드리스에서 스모크 테스트를 돌리려면 세션 버스와 키링을 띄웁니다: `dbus-run-session -- sh -c 'echo -n "" | gnome-keyring-daemon --unlock && vp run smoke-package'`.
- **브라우저**: `xdg-open`으로 엽니다. 없으면 터미널에 나온 주소를 직접 엽니다.
- **원격 접속**: 서버는 `127.0.0.1`에만 열립니다. SSH로 쓰려면 `ssh -L 5173:127.0.0.1:5173 <호스트>`로 포트를 넘깁니다.

## 문제 해결

| 증상                                                             | 원인과 해결                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `spawnSync cargo ENOENT`                                         | Rust가 없거나 `~/.cargo/bin`이 PATH에 없음                                                       |
| `turbovec addon missing`                                         | turbovec 빌드 실패. Rust와 C/C++ 빌드 도구(Windows는 MSVC) 확인                                  |
| `sharp/onnxruntime-node/@napi-rs/keyring has no binary for …`    | 이 기기에서 `vp install`을 다시 실행(다른 기기의 `node_modules`를 복사해 오면 생김)              |
| 실행 파일 첫 실행에서 `Cannot find module …memory-turbovec.node` | turbovec 없이 만든 예전 실행 파일. 다시 `vp run package`                                         |
| 사이드바에 "codex를 받거나 설치하지 못했어요"                    | 실행한 창의 `codex install failed (<이유>): <상세>` 로그 확인(네트워크·프록시·인증서, 압축 풀기) |
| 시작할 때 `Quantization is not supported for ArchType::none`     | Kiwi WASM의 경고. 결과에 영향 없음                                                               |
