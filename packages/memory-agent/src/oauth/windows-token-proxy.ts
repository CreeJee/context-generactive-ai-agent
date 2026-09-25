import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const execFileAsync = promisify(execFile);
const tokenEndpoint = "https://auth.openai.com/oauth/token";

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

/** Resolve only this fixed OAuth endpoint through the current Windows user's proxy policy. */
export async function windowsTokenProxy(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const script =
    "$u=[Uri]::new('https://auth.openai.com/oauth/token');" +
    "$p=[System.Net.WebRequest]::GetSystemWebProxy();" +
    "if(-not $p.IsBypassed($u)){" +
    "$r=$p.GetProxy($u);" +
    "if($r -and $r.AbsoluteUri -ne $u.AbsoluteUri){[Console]::Out.Write($r.AbsoluteUri)}}";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5_000, maxBuffer: 2_048, windowsHide: true },
    );
    return parseWindowsProxy(stdout);
  } catch {
    // No user proxy or failed discovery must never cause a request to an untrusted route.
    return null;
  }
}

/** One scoped fallback after a proven pre-connect timeout; never change global fetch routing. */
export async function fetchOpenAiTokenViaSystemProxy(
  url: string,
  body: string,
  contentType: string,
): Promise<Response | null> {
  if (url !== tokenEndpoint) return null;
  const proxy = await windowsTokenProxy();
  if (proxy === null) return null;
  const dispatcher = new ProxyAgent(proxy);
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
    return new Response(text, { status: response.status });
  } finally {
    await dispatcher.close();
  }
}
