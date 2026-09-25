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
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
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
export async function windowsTokenProxy(): Promise<ProxyResolution> {
  if (process.platform !== "win32") return { route: "unavailable" };
  const script =
    "$u=[Uri]::new('https://auth.openai.com/oauth/token');" +
    "$p=[System.Net.WebRequest]::GetSystemWebProxy();" +
    "if($p.IsBypassed($u)){[Console]::Out.Write('DIRECT')}else{" +
    "$r=$p.GetProxy($u);" +
    "if($r -and $r.AbsoluteUri -eq $u.AbsoluteUri){[Console]::Out.Write('DIRECT')}" +
    "elseif($r){[Console]::Out.Write($r.AbsoluteUri)}}";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5_000, maxBuffer: 2_048, windowsHide: true },
    );
    return classifyWindowsProxyOutput(stdout);
  } catch {
    // No user proxy or failed discovery must never cause a request to an untrusted route.
    return { route: "unavailable" };
  }
}

/** One scoped fallback after a proven pre-connect timeout; never change global fetch routing. */
export async function fetchOpenAiTokenViaSystemProxy(
  url: string,
  body: string,
  contentType: string,
): Promise<TokenProxyResult> {
  if (url !== tokenEndpoint) return { route: "unavailable", response: null };
  const resolution = await windowsTokenProxy();
  if (resolution.route !== "proxy") return { route: resolution.route, response: null };
  let dispatcher: ProxyAgent;
  try {
    dispatcher = new ProxyAgent(resolution.url);
  } catch {
    return { route: "unavailable", response: null };
  }
  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": contentType },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      dispatcher,
    });
    // Fully consume before closing the per-request dispatcher. Never log the token body.
    const text = await response.text();
    return { route: "attempted", response: new Response(text, { status: response.status }) };
  } finally {
    await dispatcher.close();
  }
}
