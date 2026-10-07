import { expect, it } from "@effect/vitest";
import { pipe } from "effect";
import { providerToolDescriptors } from "../src/providers/tool-capabilities.ts";
import {
  decideProviderToolExposure,
  hasRequiredProviderToolAuthority,
  type ProviderToolPolicyContext,
} from "../src/providers/tool-policy.ts";

it("pipeable exposure retains the default denial and explicit isolated compute authority", () => {
  const context: ProviderToolPolicyContext = {
    provider: "openai",
    model: "gpt-5.2",
    accountToolKinds: ["local_shell"],
    app: { allowHighRisk: true },
    user: { allowHighRisk: true },
  };
  const authority = {
    workspace: true,
    isolatedCompute: true,
    isolatedDesktop: false,
    principalStorage: false,
  };
  const shell = providerToolDescriptors.filter((tool) => tool.id === "openai:local_shell");
  expect(shell).toHaveLength(1);
  expect(pipe(shell, decideProviderToolExposure(context)).tools).toEqual([]);
  expect(
    pipe(shell, decideProviderToolExposure(context, authority)).tools.map((tool) => tool.id),
  ).toEqual(["openai:local_shell"]);
  expect(pipe([], decideProviderToolExposure(context, authority)).tools).toEqual([]);
  expect(
    pipe(shell, decideProviderToolExposure(context, { ...authority, isolatedCompute: false }))
      .tools,
  ).toEqual([]);
  expect(shell.every(hasRequiredProviderToolAuthority())).toBe(false);
  expect(shell.every(hasRequiredProviderToolAuthority(authority))).toBe(true);
  expect(shell.every((tool) => hasRequiredProviderToolAuthority(tool))).toBe(false);
});
