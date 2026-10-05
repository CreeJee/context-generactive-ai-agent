import { Effect, Result } from "effect";
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
  if (rejected) return rejected;
  return agent.runPromise(
    Effect.gen(function* () {
      const decoded = yield* Effect.tryPromise(() => readJson(request, RrsiCommand)).pipe(
        Effect.option,
      );
      if (decoded._tag === "None" || Result.isFailure(decoded.value))
        return Response.json({ error: "invalid_command" }, { status: 400 });
      const rrsi = yield* Rrsi;
      const command = decoded.value.success;
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
