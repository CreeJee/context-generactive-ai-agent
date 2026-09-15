# Context Generactive Agent

세션·프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 로컬 에이전트입니다.
ChatGPT 계정(버전을 고정한 codex app-server)으로 모델을 쓰고, 기억은 로컬 SQLite·임베딩·Kiwi 형태소·그래프로 저장하고 찾습니다.
실행 파일 `context-agent` 하나로 배포하며, 실행하면 웹 앱과 에이전트가 함께 뜹니다. 필요한 파일(codex 116 MB, 임베딩·Kiwi 모델 약 230 MB)은 처음 쓸 때 `~/.context-generactive-agent` 아래로 받습니다.

- [apps/agent](apps/agent/README.md): 웹 앱(UI, API 라우트), 실행 방법
- [packages/memory-agent](packages/memory-agent/README.md): 기억·도구·권한·codex 연결
- [docs/decisions.md](docs/decisions.md): 확정한 제품·설계 결정

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo in dependency order, turbovec's native addon included (needs Rust; cached by Vite Task):

```bash
pnpm build   # or: vp run build
```

- Run the development server (see [apps/agent](apps/agent/README.md) for host/port options):

```bash
vp run dev
```

- Build the executable for this machine and check it (Node 26.8.2 from `.node-version`):

```bash
cd apps/agent
vp run package
vp run smoke-package
```
