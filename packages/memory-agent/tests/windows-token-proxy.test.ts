import { expect, test } from "vite-plus/test";
import {
  classifyWindowsProxyOutput,
  parseWindowsProxy,
  windowsTokenProxy,
} from "../src/oauth/windows-token-proxy.ts";

test("accepts only credential-free HTTP proxy authorities", () => {
  expect(parseWindowsProxy("http://proxy.example:8080")).toBe("http://proxy.example:8080/");
  expect(parseWindowsProxy("https://proxy.example:443")).toBe("https://proxy.example/");
  for (const value of [
    "",
    "DIRECT",
    "socks5://proxy.example:1080",
    "http://user:pass@proxy.example:8080",
    "http://proxy.example:8080/path",
    "http://proxy.example:8080/?token=secret",
    "http://proxy.example:8080/#fragment",
    "http://proxy.example:8080\nhttp://other.example:8080",
  ])
    expect(parseWindowsProxy(value)).toBeNull();
});

test("distinguishes direct, unavailable and usable proxy decisions without returning addresses to the UI", () => {
  expect(classifyWindowsProxyOutput("DIRECT")).toEqual({ route: "direct" });
  expect(classifyWindowsProxyOutput("")).toEqual({ route: "unavailable" });
  expect(classifyWindowsProxyOutput("socks5://proxy.example")).toEqual({ route: "unavailable" });
  expect(classifyWindowsProxyOutput("http://proxy.example:8080")).toEqual({
    route: "proxy",
    url: "http://proxy.example:8080/",
  });
});

test.skipIf(process.platform === "win32")(
  "never queries Windows settings on another OS",
  async () => {
    expect(await windowsTokenProxy()).toEqual({ route: "unavailable" });
  },
);
