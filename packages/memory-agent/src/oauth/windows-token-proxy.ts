import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Effect, Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const execFileAsync = promisify(execFile);
const tokenEndpoint = "https://auth.openai.com/oauth/token";

export type ProxyRoute = "direct" | "unavailable" | "attempted";
export interface TokenProxyResult {
  readonly route: ProxyRoute;
  readonly response: Response | null;
}

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
const windowsTokenProxyEffect = Effect.fn("OAuth.windowsTokenProxy")(
  function* (): Effect.fn.Return<ProxyResolution> {
    if (process.platform !== "win32") return { route: "unavailable" };
    const script =
      "$u=[Uri]::new('https://auth.openai.com/oauth/token');" +
      "$p=[System.Net.WebRequest]::GetSystemWebProxy();" +
      "if($p.IsBypassed($u)){[Console]::Out.Write('DIRECT')}else{" +
      "$r=$p.GetProxy($u);" +
      "if($r -and $r.AbsoluteUri -eq $u.AbsoluteUri){[Console]::Out.Write('DIRECT')}" +
      "elseif($r){[Console]::Out.Write($r.AbsoluteUri)}}";
    return yield* Effect.tryPromise((signal) =>
      execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 5_000, maxBuffer: 2_048, windowsHide: true, signal },
      ),
    ).pipe(
      Effect.map(({ stdout }) => classifyWindowsProxyOutput(stdout)),
      Effect.orElseSucceed((): ProxyResolution => ({ route: "unavailable" })),
    );
  },
);
export function windowsTokenProxy(): Promise<ProxyResolution> {
  return runNativeEffect(windowsTokenProxyEffect());
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
  return runNativeEffect(
    Effect.gen(function* () {
      if (url !== tokenEndpoint) return { route: "unavailable" as const, response: null };
      const resolution = yield* windowsTokenProxyEffect();
      if (resolution.route !== "proxy") return { route: resolution.route, response: null };
      return yield* Effect.acquireUseRelease(
        Effect.try(() => new ProxyAgent(resolution.url)).pipe(Effect.orElseSucceed(() => null)),
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
        (dispatcher) =>
          dispatcher === null ? Effect.void : Effect.promise(() => dispatcher.close()),
      );
    }),
  );
}
