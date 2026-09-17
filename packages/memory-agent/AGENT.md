# 프로젝트 목표

세션이 달라져도 모든 맥락을 기억하는 메모리 모듈을 만듭니다.

## Used Libraries

- Security: @secretlint/*
- AI: @tanstack/ai-*, @openai/codex
- util: p-defer, p-event
- logic flow: effect

## Effect 지침

- effect 를 사용시 left right 를 직접 확인하는게 아닌, effect 친화적으로 로직을 작성해주세요.

Effect 가이드문서: https://effect.website/docs/v3/getting-started
