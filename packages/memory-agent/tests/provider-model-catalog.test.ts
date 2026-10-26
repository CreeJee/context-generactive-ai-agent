import * as TanStackAnthropic from "@tanstack/ai-anthropic";
import * as TanStackOpenAI from "@tanstack/ai-openai";
import { expect, test } from "vite-plus/test";
import {
  ANTHROPIC_MODELS,
  OPENAI_CHAT_MODELS,
  OPENAI_IMAGE_MODELS,
} from "../src/providers/model-catalog.ts";

// Goes with the TanStack provider packages (docs/effect-ai-migration.md step 7).
test("lists the models the TanStack provider packages listed, in their order", () => {
  expect(ANTHROPIC_MODELS).toStrictEqual(TanStackAnthropic.ANTHROPIC_MODELS);
  expect(OPENAI_CHAT_MODELS).toStrictEqual(TanStackOpenAI.OPENAI_CHAT_MODELS);
  expect(OPENAI_IMAGE_MODELS).toStrictEqual(TanStackOpenAI.OPENAI_IMAGE_MODELS);
});
