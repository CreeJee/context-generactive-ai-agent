// Development profiling tool: collects Effect spans and summarizes them, or V8 CPU profiles, as text.
// Submodules only: the package entry also loads NodeRedis and its client.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { devtoolsCollector } from "./devtools-collector.ts";
import { otlpCollector } from "./otlp-collector.ts";
import { SpanWriter } from "./span-record.ts";
import { readCpuProfile, summarizeCpuProfile, workingRoot } from "./summarize-cpu.ts";
import { readSpans, summarizeSpans } from "./summarize-spans.ts";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const out = Flag.String("out").pipe(Flag.withDescription("span을 덧붙일 NDJSON 파일"));

/** Ends when stdin closes: a parent that holds the pipe ends the collector even if it dies. */
const stdinClosed = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.runDrain(stdio.stdin);
});

const collectOtlp = Command.make(
  "collect-otlp",
  {
    port: Flag.Int("port").pipe(Flag.withSchema(Port), Flag.withDefault(4318)),
    out,
    untilStdinCloses: Flag.Boolean("until-stdin-closes").pipe(
      Flag.withDescription("stdin이 닫히면 종료 (부모 프로세스가 파이프를 잡고 있을 때)"),
      Flag.withDefault(false),
    ),
  },
  ({ port, out, untilStdinCloses }) => {
    const collect = otlpCollector(port).pipe(Effect.provide(SpanWriter.layer(out)));
    return untilStdinCloses ? Effect.raceFirst(collect, stdinClosed) : collect;
  },
).pipe(Command.withDescription("OTLP/JSON trace를 받아 span NDJSON으로 저장"));

const collectDevtools = Command.make(
  "collect-devtools",
  { port: Flag.Int("port").pipe(Flag.withSchema(Port), Flag.withDefault(34437)), out },
  ({ port, out }) => devtoolsCollector(port).pipe(Effect.provide(SpanWriter.layer(out))),
).pipe(Command.withDescription("Effect devtools 프로토콜로 span을 받아 NDJSON으로 저장 (개발용)"));

type InputKind = "cpu" | "spans";
const inputKind = (file: string): InputKind => (file.endsWith(".cpuprofile") ? "cpu" : "spans");

const summarize = Command.make(
  "summarize",
  {
    files: Argument.String("file").pipe(
      Argument.withDescription("span NDJSON 또는 .cpuprofile"),
      Argument.atLeast(1),
    ),
    top: Flag.Int("top").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
      Flag.withDefault(20),
    ),
  },
  Effect.fn(function* ({ files, top }) {
    const root = yield* workingRoot;
    for (const file of files) {
      yield* Console.log(`== ${file}`);
      switch (inputKind(file)) {
        case "cpu":
          yield* Console.log(summarizeCpuProfile(yield* readCpuProfile(file), root, top));
          break;
        case "spans":
          yield* Console.log(summarizeSpans(yield* readSpans(file), top));
          break;
      }
      yield* Console.log("");
    }
  }),
).pipe(Command.withDescription("span NDJSON·CPU 프로파일을 텍스트로 요약"));

Command.make("profile").pipe(
  Command.withSubcommands([collectOtlp, collectDevtools, summarize]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
