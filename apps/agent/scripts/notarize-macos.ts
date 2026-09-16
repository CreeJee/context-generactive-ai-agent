// Notarizes the macOS executable built by scripts/package.ts and staples the ticket to a disk
// image, so Gatekeeper accepts it on another Mac without asking Apple at launch:
//
//   dist/context-agent-darwin-<arch>/context-agent  ->  dist/context-agent-darwin-<arch>.dmg
//
// Run with `vp run notarize` on the machine that holds the signing identity. Nothing here reads a
// secret from the environment: the Apple credentials live in a notarytool keychain profile, created
// once with
//   xcrun notarytool store-credentials context-agent \
//     --apple-id <Apple ID> --team-id <Team ID> --password <app-specific password>
// and named by CONTEXT_AGENT_NOTARY_PROFILE (default "context-agent").
//
// A bare Mach-O executable cannot hold a stapled ticket — only a container can — which is why the
// deliverable is a .dmg. Notarizing a .zip of the executable also works and needs no container, but
// then every first launch has to reach Apple's server, and an offline Mac shows the warning anyway.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const target = `darwin-${process.arch}`;
const directory = join(app, "dist", `context-agent-${target}`);
const executable = join(directory, "context-agent");
const image = join(app, "dist", `context-agent-${target}.dmg`);
const profile = process.env.CONTEXT_AGENT_NOTARY_PROFILE ?? "context-agent";

function run(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { cwd: app, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function capture(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { cwd: app, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

if (process.platform !== "darwin") throw new Error("notarization only runs on macOS");
if (!existsSync(executable))
  throw new Error(`${relative(app, executable)} is missing; run \`vp run package\` first`);

// An ad-hoc signature has no team behind it and notarization rejects it, with a message that does
// not say why. Better to stop here and name the missing piece.
const signature = capture("codesign", ["--display", "--verbose=4", executable]);
if (signature.status !== 0) throw new Error("the executable is not signed");
if (/^Signature=adhoc$/mu.test(signature.out))
  throw new Error(
    "the executable is signed ad-hoc. Rebuild with a Developer ID:\n" +
      '  CONTEXT_AGENT_SIGN_IDENTITY="Developer ID Application: <name> (<team id>)" vp run package\n' +
      "  (`security find-identity -v -p codesigning` lists the identities this machine has)",
  );
if (!/TeamIdentifier=[A-Z0-9]{10}/u.test(signature.out))
  throw new Error("the signature carries no Team ID, so it cannot be notarized");

const stored = capture("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
if (stored.status !== 0)
  throw new Error(
    `no notarytool keychain profile "${profile}". Create it once with:\n` +
      `  xcrun notarytool store-credentials ${profile} --apple-id <Apple ID> --team-id <Team ID> --password <app-specific password>`,
  );

rmSync(image, { force: true });
// A read-only image holds the executable with its permission bits, and can be stapled.
run("hdiutil", [
  "create",
  "-volname",
  "Context Agent",
  "-srcfolder",
  directory,
  "-ov",
  "-format",
  "UDZO",
  image,
]);
run("codesign", [
  "--sign",
  process.env.CONTEXT_AGENT_SIGN_IDENTITY ?? "-",
  "--force",
  "--timestamp",
  image,
]);

run("xcrun", ["notarytool", "submit", image, "--keychain-profile", profile, "--wait"]);
run("xcrun", ["stapler", "staple", image]);
// What Gatekeeper itself will say on the other machine.
run("spctl", [
  "--assess",
  "--type",
  "open",
  "--context",
  "context:primary-signature",
  "-vv",
  image,
]);

const digest = createHash("sha256").update(readFileSync(image)).digest("hex");
writeFileSync(`${image}.sha256`, `${digest}  ${basename(image)}\n`);
console.log(`${relative(app, image)}: notarized and stapled`);
