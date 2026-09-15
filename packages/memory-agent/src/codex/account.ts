import { Context, Effect, Layer, Schema } from "effect";
import { CodexAppServer, type CodexRequestFailed, type CodexUnavailable } from "./app-server.ts";

/** What the UI may know about the ChatGPT connection. No tokens, e-mail or account ids. */
export type AuthState =
  | { readonly status: "signed-out" }
  | { readonly status: "pending"; readonly authUrl: string }
  | { readonly status: "signed-in"; readonly planType: string | null }
  /** The executable is fetching its codex for the first time; ask again shortly. */
  | { readonly status: "installing" }
  | {
      readonly status: "unavailable";
      readonly reason: Exclude<CodexUnavailable["reason"], "installing">;
    }
  | { readonly status: "error"; readonly message: string };

const AccountRead = Schema.Struct({
  account: Schema.NullOr(
    Schema.Struct({ type: Schema.String, planType: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
});
const LoginStarted = Schema.Struct({
  type: Schema.Literal("chatgpt"),
  loginId: Schema.String,
  authUrl: Schema.String,
});
const LoginCompleted = Schema.Struct({
  loginId: Schema.optional(Schema.NullOr(Schema.String)),
  success: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
const Ignored = Schema.Unknown;

/** Only the ChatGPT authorize page is ever handed to the browser. */
export function isChatgptAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "auth.openai.com" &&
      url.port === "" &&
      url.pathname === "/oauth/authorize" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const make = Effect.gen(function* () {
  const codex = yield* CodexAppServer;
  let pending: { loginId: string; authUrl: string } | null = null;
  let lastFailure: string | null = null;

  codex.onNotification("account/login/completed", (params) => {
    const completion = Schema.decodeUnknownOption(LoginCompleted)(params);
    if (completion._tag === "None" || !pending) return;
    if (completion.value.loginId && completion.value.loginId !== pending.loginId) return;
    pending = null;
    lastFailure = completion.value.success ? null : "ChatGPT login did not complete.";
  });

  const status = Effect.gen(function* () {
    if (pending) return { status: "pending", authUrl: pending.authUrl } satisfies AuthState;
    const { account } = yield* codex.request("account/read", { refreshToken: false }, AccountRead);
    if (account?.type === "chatgpt")
      return { status: "signed-in", planType: account.planType ?? null } satisfies AuthState;
    if (lastFailure) return { status: "error", message: lastFailure } satisfies AuthState;
    return { status: "signed-out" } satisfies AuthState;
  });

  /** Never leak codex failure text to the UI; it can include paths or account details. */
  const toState = (effect: Effect.Effect<AuthState, CodexUnavailable | CodexRequestFailed>) =>
    effect.pipe(
      Effect.catchTags({
        CodexUnavailable: ({ reason }) => {
          switch (reason) {
            case "installing":
              return Effect.succeed<AuthState>({ status: "installing" });
            case "not_installed":
            case "install_failed":
            case "spawn_failed":
            case "exited":
              return Effect.succeed<AuthState>({ status: "unavailable", reason });
          }
        },
        CodexRequestFailed: () =>
          Effect.succeed<AuthState>({ status: "error", message: "Codex account request failed." }),
      }),
    );

  return {
    status: toState(status),

    /** Starts browser login and returns the authorize URL for the user to open. */
    login: toState(
      Effect.gen(function* () {
        const current = yield* status;
        if (current.status === "signed-in" || current.status === "pending") return current;
        const started = yield* codex.request(
          "account/login/start",
          { type: "chatgpt" },
          LoginStarted,
        );
        if (!isChatgptAuthUrl(started.authUrl)) {
          yield* codex.request("account/login/cancel", { loginId: started.loginId }, Ignored);
          return {
            status: "error",
            message: "Codex returned an unexpected login URL.",
          } satisfies AuthState;
        }
        pending = { loginId: started.loginId, authUrl: started.authUrl };
        lastFailure = null;
        return { status: "pending", authUrl: started.authUrl } satisfies AuthState;
      }),
    ),

    cancel: toState(
      Effect.gen(function* () {
        if (pending) {
          const { loginId } = pending;
          pending = null;
          yield* codex.request("account/login/cancel", { loginId }, Ignored);
        }
        return yield* status;
      }),
    ),

    logout: toState(
      Effect.gen(function* () {
        if (pending)
          yield* codex.request("account/login/cancel", { loginId: pending.loginId }, Ignored);
        pending = null;
        yield* codex.request("account/logout", undefined, Ignored);
        return yield* status;
      }),
    ),
  };
});

/** ChatGPT sign-in through codex. Codex stores the tokens in the OS keychain; this app never reads them. */
export class CodexAccount extends Context.Tag("memory-agent/CodexAccount")<
  CodexAccount,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(CodexAccount, make);
}
