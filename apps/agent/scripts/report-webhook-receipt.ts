import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Effect, Layer, Schema, Stdio } from "effect";
import { Flag } from "effect/cli";
import { ReportDelivery, ReportDeliveryResult } from "memory-agent";
import { loadEnv } from "vite-plus";
import { parseCommandLine } from "../server/command-line.ts";

// One real delivery through the app's report path, to confirm the developer channel receives it.
// The webhook comes from `DISCORD_WEBHOOK_URL` in the env files of `--env-dir`, loaded the way the
// React Router dev server loads them. Prints only the outcome: never the URL or its token.
//
//   node scripts/report-webhook-receipt.ts --env-dir <folder with the app's env file>

/** `ReportDelivery` configured from the env files of `--env-dir`. */
const deliveryLayer = Layer.unwrap(
  Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args).pipe(
    Effect.flatMap((args) =>
      parseCommandLine(
        "report-webhook-receipt.ts",
        { envDir: Flag.String("env-dir").pipe(Flag.withSchema(Schema.NonEmptyString)) },
        "사용법: report-webhook-receipt.ts --env-dir <폴더>",
        args,
      ),
    ),
    // The parse failure already printed the usage and its details.
    Effect.catch(() => Effect.sync(() => process.exit(2))),
    Effect.map(({ envDir }) =>
      ReportDelivery.layer().pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(loadEnv("development", envDir, ""))),
        ),
      ),
    ),
  ),
).pipe(Layer.provide(NodeServices.layer));

/** Synthetic text only: no user, session or evidence data. */
const text = [
  "[테스트] context-agent 제보 웹훅 수신 확인",
  "",
  "합성 테스트 메시지입니다. 사용자 데이터·대화·증거를 포함하지 않습니다.",
  "확인 항목: wait=true 메시지 ID, 첨부 context-agent-report.txt, 멘션 차단(allowed_mentions.parse=[]).",
].join("\n");

const program = Effect.gen(function* () {
  const delivery = yield* ReportDelivery;
  const result = yield* delivery.send({ text, evidence: null }, false);
  return yield* Console.log(
    ReportDeliveryResult.match(result, {
      delivered: ({ messageId }) => `delivered: HTTP 2xx (wait=true), message id ${messageId}`,
      duplicate: () => "not sent: duplicate",
      uncertain_duplicate: () => "not sent: uncertain_duplicate",
    }),
  );
}).pipe(
  Effect.catchTag("ReportDeliveryError", (error) =>
    Console.log(
      `failed: reason ${error.reason}, HTTP ${error.httpStatus ?? "none"}, retry_after ${error.retryAfterSeconds ?? "none"}`,
    ),
  ),
  // Script entry point: the whole program gets its layer here.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(deliveryLayer),
);

NodeRuntime.runMain(program);
