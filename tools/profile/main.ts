// Development profiling tool: collects Effect spans or process memory samples and summarizes them,
// or V8 CPU profiles, as text.
// Submodules only: the package entry also loads NodeRedis and its client.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { Console, Duration, Effect, Layer, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { devtoolsCollector } from "./devtools-collector.ts";
import { memoryCollector } from "./memory-sample.ts";
import { otlpCollector } from "./otlp-collector.ts";
import { SpanWriter } from "./span-record.ts";
import { readCpuProfile, summarizeCpuProfile, workingRoot } from "./summarize-cpu.ts";
import { readMemorySamples, summarizeMemory } from "./summarize-memory.ts";
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
  ({ port, untilStdinCloses }) =>
    untilStdinCloses ? Effect.raceFirst(otlpCollector(port), stdinClosed) : otlpCollector(port),
).pipe(
  Command.provide(({ out }) => SpanWriter.layer(out)),
  Command.withDescription("OTLP/JSON trace를 받아 span NDJSON으로 저장"),
);

const collectDevtools = Command.make(
  "collect-devtools",
  { port: Flag.Int("port").pipe(Flag.withSchema(Port), Flag.withDefault(34437)), out },
  ({ port }) => devtoolsCollector(port),
).pipe(
  Command.provide(({ port, out }) =>
    Layer.merge(SpanWriter.layer(out), NodeSocketServer.layerWebSocket({ port })),
  ),
  Command.withDescription("Effect devtools 프로토콜로 span을 받아 NDJSON으로 저장 (개발용)"),
);

const collectMemory = Command.make(
  "collect-memory",
  {
    pid: Flag.Int("pid").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
      Flag.withDescription("잴 프로세스. 그 아래 프로세스도 함께 잰다"),
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("표본을 덧붙일 NDJSON 파일 (.memory.ndjson으로 끝나야 요약된다)"),
    ),
    interval: Flag.Int("interval").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
      Flag.withDescription("표본 간격(초)"),
      Flag.withDefault(2),
    ),
  },
  ({ pid, out, interval }) => memoryCollector(pid, out, Duration.seconds(interval)),
).pipe(Command.withDescription("프로세스와 그 아래 프로세스의 메모리를 주기적으로 NDJSON에 저장"));

type InputKind = "cpu" | "memory" | "spans";
const inputKind = (file: string): InputKind =>
  file.endsWith(".cpuprofile") ? "cpu" : file.endsWith(".memory.ndjson") ? "memory" : "spans";

const summarize = Command.make(
  "summarize",
  {
    files: Argument.String("file").pipe(
      Argument.withDescription("span NDJSON, .memory.ndjson 또는 .cpuprofile"),
      Argument.atLeast(1),
    ),
    top: Flag.Int("top").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
      Flag.withDefault(20),
    ),
  },
  Effect.fn(function* ({ files, top }) {
    const root = yield* workingRoot;
    yield* Effect.forEach(
      files,
      Effect.fnUntraced(function* (file) {
        yield* Console.log(`== ${file}`);
        switch (inputKind(file)) {
          case "cpu":
            yield* Console.log(summarizeCpuProfile(yield* readCpuProfile(file), root, top));
            break;
          case "memory":
            yield* Console.log(summarizeMemory(yield* readMemorySamples(file), top));
            break;
          case "spans":
            yield* Console.log(summarizeSpans(yield* readSpans(file), top));
            break;
        }
        yield* Console.log("");
      }),
      { discard: true },
    );
  }),
).pipe(Command.withDescription("span NDJSON·메모리 표본·CPU 프로파일을 텍스트로 요약"));

Command.make("profile").pipe(
  Command.withSubcommands([collectOtlp, collectDevtools, collectMemory, summarize]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
