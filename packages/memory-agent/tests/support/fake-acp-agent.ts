import {
  Cause,
  Config,
  Effect,
  FileSystem,
  Layer,
  MutableHashMap,
  MutableHashSet,
  Option,
  Schema,
} from "effect";
// The native ACP process owns stdin/stdout; request control flow runs in its captured Effect context.
// A small external ACP agent for tests. Each start is appended to $FAKE_ACP_LOG, and each "slow"
// prompt it receives to $FAKE_ACP_LOG.slow. While
// $FAKE_ACP_REFUSE names an existing file, it exits at once, so connection attempts fail.
import { NodeFileSystem } from "@effect/platform-node";
import { NodeStream, NodeSink } from "@effect/platform-node";
import { SdkStreams } from "../../src/acp/web-streams.ts";
import { Cause as StreamCause, Context, Stream } from "effect";
import * as acp from "@agentclientprotocol/sdk";

const services = await Effect.runPromise(Effect.scoped(Layer.build(NodeFileSystem.layer)));
const runNative = Effect.runPromiseWith(services);
const { fs, log } = await runNative(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const refuse = yield* Config.String("FAKE_ACP_REFUSE").pipe(Config.withDefault(""));
    const log = yield* Config.String("FAKE_ACP_LOG").pipe(Config.withDefault(""));
    if (refuse.length > 0 && (yield* fs.exists(refuse))) process.exit(2);
    if (log.length > 0) {
      const secret = yield* Config.String("SHOULD_NOT_LEAK").pipe(Config.withDefault(""));
      const line = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            pid: Schema.Int,
            cwd: Schema.String,
            secret: Schema.NullOr(Schema.String),
          }),
        ),
      )({ pid: process.pid, cwd: process.cwd(), secret: secret.length === 0 ? null : secret });
      yield* fs.writeFileString(log, line + "\n", { flag: "a" });
    }
    return { fs, log };
  }),
);

const history = MutableHashMap.empty<string, string[]>();
const cancelled = MutableHashSet.empty<string>();
let nextSession = 1;

const say = (client: acp.AgentContext, sessionId: string, text: string) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const { readable, writable } = await Effect.runPromise(
  Effect.scoped(
    Effect.map(
      Layer.build(
        SdkStreams.layer({
          input: NodeStream.fromReadable({
            evaluate: () => process.stdin,
            onError: (cause) => new StreamCause.UnknownError(cause),
          }),
          output: NodeSink.fromWritable({
            evaluate: () => process.stdout,
            onError: (cause) => new StreamCause.UnknownError(cause),
            endOnDone: false,
          }),
          closeOutput: Stream.run(
            Stream.empty,
            NodeSink.fromWritable({
              evaluate: () => process.stdout,
              onError: (cause) => new StreamCause.UnknownError(cause),
              endOnDone: true,
            }),
          ),
        }),
      ),
      (context) => Context.get(context, SdkStreams),
    ),
  ),
);
acp
  .agent({ name: "fake-external" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-external", version: "1.0.0" },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `ext-${nextSession++}`;
    MutableHashMap.set(history, sessionId, []);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, (ctx) =>
    runNative(
      Effect.gen(function* () {
        const { sessionId } = ctx.params;
        const text = ctx.params.prompt
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        const earlier = Option.getOrUndefined(MutableHashMap.get(history, sessionId)) ?? [];
        earlier.push(text);

        if (text.includes("crash")) {
          yield* sdkCall(() => say(ctx.client, sessionId, "partial before crash"));
          yield* Effect.sleep(20);
          return process.exit(1);
        }
        if (text.includes("needs permission")) {
          yield* sdkCall(() =>
            ctx.client.notify(acp.methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "t1",
                title: "Edit README.md",
                kind: "edit",
                status: "pending",
              },
            }),
          );
          const answer = yield* sdkCall(() =>
            ctx.client.request(acp.methods.client.session.requestPermission, {
              sessionId,
              toolCall: {
                toolCallId: "t1",
                title: "Edit README.md",
                kind: "edit",
                rawInput: { path: "README.md" },
              },
              options: [
                { optionId: "always", name: "Always", kind: "allow_always" },
                { optionId: "once", name: "Once", kind: "allow_once" },
                { optionId: "no", name: "No", kind: "reject_once" },
              ],
            }),
          );
          const chosen =
            answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
          yield* sdkCall(() =>
            ctx.client.notify(acp.methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "t1",
                status: chosen === "once" ? "completed" : "failed",
              },
            }),
          );
          yield* sdkCall(() => say(ctx.client, sessionId, `permission: ${chosen}`));
          return { stopReason: "end_turn" };
        }
        if (text.includes("slow")) {
          // Lets a test cancel only after the prompt has really arrived.
          if (log.length > 0)
            yield* fs.writeFileString(`${log}.slow`, `${sessionId}\n`, { flag: "a" });
          for (let step = 0; step < 50; step++) {
            if (MutableHashSet.has(cancelled, sessionId)) {
              MutableHashSet.remove(cancelled, sessionId);
              // Lets a test see that the cancellation arrived before the turn answered.
              if (log.length > 0)
                yield* fs.writeFileString(`${log}.cancelled`, `${sessionId}\n`, { flag: "a" });
              return { stopReason: "cancelled" };
            }
            yield* Effect.sleep(40);
          }
        }
        yield* sdkCall(() =>
          say(ctx.client, sessionId, `external: ${text} (turn ${earlier.length})`),
        );
        return { stopReason: "end_turn" };
      }),
    ),
  )
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    MutableHashSet.add(cancelled, ctx.params.sessionId);
  })
  .connect(acp.ndJsonStream(writable, readable));

const sdkCall = Effect.fn("FakeAcp.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
