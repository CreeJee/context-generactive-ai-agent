# Context Generactive Agent

A modern, generactive ai

## Getting Started

### Installation

Install the dependencies:

```bash
npm install
```

### Development

Start the development server with HMR:

```bash
npm run dev
```

Your application will be available at `http://localhost:5173`.

## Building for Production

Create a production build:

```bash
npm run build
```

## Deployment

### Docker Deployment

To build and run using Docker:

```bash
docker build -t my-app .

# Run the container
docker run -p 3000:3000 my-app
```

The containerized application can be deployed to any platform that supports Docker, including:

- AWS ECS
- Google Cloud Run
- Azure Container Apps
- Digital Ocean App Platform
- Fly.io
- Railway

### DIY Deployment

If you're familiar with deploying Node applications, the built-in app server is production-ready.

Make sure to deploy the output of `npm run build`

```
├── package.json
├── package-lock.json (or pnpm-lock.yaml, or bun.lockb)
├── build/
│   ├── client/    # Static assets
│   └── server/    # Server-side code
```

### Tech Info

- 이 프로젝트는 [tanstack file routes](https://reactrouter.com/how-to/file-route-conventions)를 사용중임.

### Structure

- app
  - ai / Tanstack AI 관련된 로직
  - components
    - ui / shadcn generactive 한 로직
  - lib
    - utils.ts (tailwind cn 유틸)
  - routes (file route converntion을 준수해서 작성)
    - api (server action 만을 작성하는 방식, 재작자가 미리설계함, 필요에따라 변경가능)
      - auth.tsx: ([oauth 방식의 openByok](https://tanstack.com/ai/latest/docs/adapters/openrouter#sign-in-with-openrouter-byok) 로 openai또한 같은흐름으로 재공함)
      - chat.tsx : 유저와 에이전트의 채팅 로직이 작성될 예정이며 이 과정에서 [memory-agent](../../packages/memory-agent/package.json) 의 AI 메모리 기능이 들어갈 예정
      - models.$model.tsx: https://tanstack.com/ai/latest/docs/advanced/runtime-adapter-switching#runtime-adapter-switching-with-type-safety 를 이용하여 다이나믹하게 사용중인 모델을 변경하는 기능을 재공할예정

사용자의 설정은 ~/.context-generactice-agent 에 저장하는것으로 작성 예정

## Styling

This project comes with [Tailwind CSS](https://tailwindcss.com/) & [Shadcn](https://ui.shadcn.com/)

---
