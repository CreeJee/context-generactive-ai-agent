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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Crypto, Effect, FileSystem, Layer, Path, Stream, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Hex } from "effect/encoding";

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  args: Schema.String,
}) {}

class PackagePreflightFailed extends Schema.TaggedError<PackagePreflightFailed>()(
  "PackagePreflightFailed",
  { message: Schema.String },
) {}

const program = Effect.gen(function* () {
  const services = yield* Layer.build(NodeServices.layer);
  const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
  const path = yield* Effect.provideContext(Path.Path, services);
  const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
  const spawner = yield* Effect.provideContext(ChildProcessSpawner.ChildProcessSpawner, services);
  const { basename, join, relative } = path;
  const app = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const target = `darwin-${process.arch}`;
  const directory = join(app, "dist", `context-agent-${target}`);
  const executable = join(directory, "context-agent");
  const image = join(app, "dist", `context-agent-${target}.dmg`);
  const profile = yield* Config.String("CONTEXT_AGENT_NOTARY_PROFILE").pipe(
    Config.withDefault("context-agent"),
  );

  const run = Effect.fn("notarize.run")(function* (command: string, args: readonly string[]) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd: app, stdout: "inherit", stderr: "inherit" }),
    );
    const status = yield* child.exitCode;
    if (Number(status) !== 0) return yield* CommandFailed.make({ command, args: args.join(" ") });
  });
  const capture = Effect.fn("notarize.capture")(function* (
    command: string,
    args: readonly string[],
  ) {
    const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: app }));
    const out = yield* child.all.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (out, part) => out + part,
      ),
    );
    return { status: Number(yield* child.exitCode), out };
  });

  if (process.platform !== "darwin")
    return yield* PackagePreflightFailed.make({ message: "notarization only runs on macOS" });
  if (!(yield* fs.exists(executable)))
    return yield* PackagePreflightFailed.make({
      message: `${relative(app, executable)} is missing; run \`vp run package\` first`,
    });

  // An ad-hoc signature has no team behind it and notarization rejects it, with a message that does
  // not say why. Better to stop here and name the missing piece.
  const signature = yield* capture("codesign", ["--display", "--verbose=4", executable]);
  if (signature.status !== 0)
    return yield* PackagePreflightFailed.make({ message: "the executable is not signed" });
  if (/^Signature=adhoc$/mu.test(signature.out))
    return yield* PackagePreflightFailed.make({
      message:
        "the executable is signed ad-hoc. Rebuild with a Developer ID:\n" +
        '  CONTEXT_AGENT_SIGN_IDENTITY="Developer ID Application: <name> (<team id>)" vp run package\n' +
        "  (`security find-identity -v -p codesigning` lists the identities this machine has)",
    });
  if (!/TeamIdentifier=[A-Z0-9]{10}/u.test(signature.out))
    return yield* PackagePreflightFailed.make({
      message: "the signature carries no Team ID, so it cannot be notarized",
    });

  const stored = yield* capture("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
  if (stored.status !== 0)
    return yield* PackagePreflightFailed.make({
      message:
        `no notarytool keychain profile "${profile}". Create it once with:\n` +
        `  xcrun notarytool store-credentials ${profile} --apple-id <Apple ID> --team-id <Team ID> --password <app-specific password>`,
    });

  yield* fs.remove(image, { force: true });
  // A read-only image holds the executable with its permission bits, and can be stapled.
  yield* run("hdiutil", [
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
  yield* run("codesign", [
    "--sign",
    yield* Config.String("CONTEXT_AGENT_SIGN_IDENTITY").pipe(Config.withDefault("-")),
    "--force",
    "--timestamp",
    image,
  ]);

  yield* run("xcrun", ["notarytool", "submit", image, "--keychain-profile", profile, "--wait"]);
  yield* run("xcrun", ["stapler", "staple", image]);
  // What Gatekeeper itself will say on the other machine.
  yield* run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "-vv",
    image,
  ]);

  const digest = Hex.encode(yield* crypto.digest("SHA-256", yield* fs.readFile(image)));
  yield* fs.writeFileString(`${image}.sha256`, `${digest}  ${basename(image)}\n`);
  yield* Effect.logInfo(`${relative(app, image)}: notarized and stapled`);
});
await Effect.runPromise(Effect.scoped(program));
