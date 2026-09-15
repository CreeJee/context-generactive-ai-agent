# Context Generactive Agent

세션·프로젝트를 넘어 대화를 기억하고, 근거를 따라갈 수 있는 로컬 에이전트입니다.
ChatGPT 계정(codex app-server)으로 모델을 쓰고, 기억은 로컬 SQLite·임베딩·Kiwi 형태소·그래프로 저장하고 찾습니다.
임베딩·Kiwi 모델은 처음 쓸 때 `~/.context-generactive-agent/models`로 내려받습니다(약 600 MB).

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

- Build the monorepo:

```bash
vp run -r build
```

- Run the development server (see [apps/agent](apps/agent/README.md) for host/port options):

```bash
vp run dev
```
