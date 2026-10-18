import { nativePromise } from "../runtime/native-effect.ts";
import { Effect, Stream, Function as EffectFunction, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const tokenEndpoint = "https://auth.openai.com/oauth/token";

export const ProxyRoute = Schema.Literals(["direct", "unavailable", "attempted"]);
export type ProxyRoute = typeof ProxyRoute.Type;
export interface TokenProxyResult {
  readonly route: ProxyRoute;
  readonly response: Response | null;
}

/** PowerShell printed more than a proxy URL can be; its output is not read further. */
class ProxyOutputTooLarge extends Schema.TaggedError<ProxyOutputTooLarge>()(
  "ProxyOutputTooLarge",
  {},
) {}

type ProxyResolution =
  | { readonly route: "direct" | "unavailable" }
  | { readonly route: "proxy"; readonly url: string };

/** Reject credentials, paths and non-HTTP routes before sending an OAuth grant. */
export function parseWindowsProxy(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !(url.hostname.length > 0) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Only a fixed sentinel denotes an OS decision to connect directly. */
export function classifyWindowsProxyOutput(output: string): ProxyResolution {
  if (output.trim() === "DIRECT") return { route: "direct" };
  const url = parseWindowsProxy(output);
  return url === null ? { route: "unavailable" } : { route: "proxy", url };
}

/** Resolve only this fixed OAuth endpoint through the current Windows user's proxy policy. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const windowsTokenProxyEffect = Effect.fn("OAuth.windowsTokenProxy")(function* (): Effect.fn.Return<
  ProxyResolution,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  if (process.platform !== "win32") return { route: "unavailable" };
  const script =
    "$u=[Uri]::new('https://auth.openai.com/oauth/token');" +
    "$p=[System.Net.WebRequest]::GetSystemWebProxy();" +
    "if($p.IsBypassed($u)){[Console]::Out.Write('DIRECT')}else{" +
    "$r=$p.GetProxy($u);" +
    "if($r -and $r.AbsoluteUri -eq $u.AbsoluteUri){[Console]::Out.Write('DIRECT')}" +
    "elseif($r){[Console]::Out.Write($r.AbsoluteUri)}}";
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, detached: false, stdin: "ignore", stderr: "ignore" },
        ),
      );
      const decoder = new TextDecoder();
      let size = 0;
      let output = "";
      yield* child.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            size += chunk.byteLength;
            if (size > 2048) return yield* new ProxyOutputTooLarge();
            output += decoder.decode(chunk, { stream: true });
          }),
        ),
      );
      output += decoder.decode();
      const exit = yield* child.exitCode;
      return exit === 0 ? classifyWindowsProxyOutput(output) : { route: "unavailable" as const };
    }),
  ).pipe(
    Effect.timeout(5_000),
    // Without an answer from the OS policy the token request is not routed through a proxy.
    Effect.catchTag(["PlatformError", "ProxyOutputTooLarge", "TimeoutError"], () =>
      Effect.succeed<ProxyResolution>({ route: "unavailable" }),
    ),
  );
});
export function windowsTokenProxy(): Promise<ProxyResolution> {
  return runOAuthNodeEffect(windowsTokenProxyEffect());
}

/** One scoped fallback after a proven pre-connect timeout; never change global fetch routing. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const fetchOpenAiTokenViaSystemProxy: {
  (
    body: string,
    contentType: string,
  ): (url: string) => ReturnType<typeof fetchOpenAiTokenViaSystemProxyBody>;
} & typeof fetchOpenAiTokenViaSystemProxyBody = EffectFunction.dual(
  3,
  fetchOpenAiTokenViaSystemProxyBody,
);
function fetchOpenAiTokenViaSystemProxyBody(
  url: string,
  body: string,
  contentType: string,
): Promise<TokenProxyResult> {
  return runOAuthNodeEffect(
    Effect.gen(function* () {
      if (url !== tokenEndpoint) return { route: "unavailable" as const, response: null };
      const resolution = yield* windowsTokenProxyEffect();
      if (resolution.route !== "proxy") return { route: resolution.route, response: null };
      return yield* Effect.acquireUseRelease(
        Effect.try(() => new ProxyAgent(resolution.url)).pipe(
          Effect.catchTag("UnknownError", () => Effect.succeed(null)),
        ),
        (dispatcher) =>
          Effect.gen(function* () {
            if (dispatcher === null) return { route: "unavailable" as const, response: null };
            const response = yield* Effect.tryPromise((ownerSignal) =>
              undiciFetch(url, {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": contentType },
                body,
                redirect: "error",
                signal: AbortSignal.any([ownerSignal, AbortSignal.timeout(30_000)]),
                dispatcher,
              }),
            );
            const text = yield* nativePromise(() => response.text());
            return {
              route: "attempted" as const,
              response: new Response(text, { status: response.status }),
            };
          }),
        // Closing the one-shot agent is best-effort; the token response already stands.
        (dispatcher) =>
          dispatcher === null
            ? Effect.void
            : nativePromise(() => dispatcher.close()).pipe(
                Effect.catchTag("UnknownError", () =>
                  Effect.logWarning("OAuth proxy agent close failed", { error: "UnknownError" }),
                ),
              ),
      );
    }),
  );
}
