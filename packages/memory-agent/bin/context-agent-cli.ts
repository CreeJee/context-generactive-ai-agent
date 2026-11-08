#!/usr/bin/env node
// Standalone memory CLI: reads a storage folder directly (read-only), without the running app.
// The commands themselves live in src/cli/commands.ts, which the executable's
// `context-agent memory …` runs too, so both entry points stay the same CLI.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Stdio } from "effect";
import { runMemoryCli } from "../src/cli/commands.ts";

Stdio.Stdio.pipe(
  Effect.flatMap((stdio) => stdio.args),
  Effect.flatMap((args) => runMemoryCli({ name: "context-agent-cli", args })),
  // The CLI's entry point: the one place its platform services are provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
