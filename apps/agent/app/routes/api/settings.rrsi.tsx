import { Effect, Option, Result } from "effect";
import { Rrsi, RrsiCommand } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";

export function loader() {
  return agent.runPromise(
    Effect.gen(function* () {
      return Response.json(yield* (yield* Rrsi).status);
    }),
  );
}
export function action({ request }: { request: Request }) {
  const rejected = rejectCrossSite(request);
  if (rejected !== null) return rejected;
  return agent.runPromise(
    Effect.gen(function* () {
      const decoded = yield* Effect.tryPromise(() => readJson(request, RrsiCommand)).pipe(
        Effect.map(Result.getSuccess),
        // A body that cannot be read answers the same as one that does not decode.
        Effect.catchTag("UnknownError", () => Effect.succeedNone),
      );
      if (Option.isNone(decoded))
        return Response.json({ error: "invalid_command" }, { status: 400 });
      const rrsi = yield* Rrsi;
      const command = decoded.value;
      return yield* Effect.gen(function* () {
        switch (command.action) {
          case "settings":
            return Response.json(yield* rrsi.configure(command.settings));
          case "restore":
            return Response.json(yield* rrsi.restore(command.versionId));
          case "stop":
            return Response.json(yield* rrsi.stop);
          case "start":
            return Response.json(yield* rrsi.start());
        }
      }).pipe(
        Effect.catchTag("RrsiFailed", (failure) =>
          Effect.succeed(Response.json({ error: failure.reason }, { status: 409 })),
        ),
      );
    }),
  );
}
