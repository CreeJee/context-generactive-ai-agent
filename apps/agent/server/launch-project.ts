import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { FileSystem, ManagedRuntime, Option } from "effect";
import { path } from "memory-agent/synchronous-path";
import { Effect } from "effect";
import { nodePlatform } from "memory-agent/node-platform";
import { Function as EffectFunction } from "effect";
import { isTruthy } from "../app/truthy.ts";
import { homeDirectory } from "memory-agent/host-system";
import { Schema } from "effect";

/** The folder the app opens as a project, or why it opens none. */
const { dirname, isAbsolute, relative, resolve } = path;

export type LaunchFolder =
  | { readonly kind: "folder"; readonly root: string }
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly path: string };

const isInside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const canonical = Effect.fn("launch.canonical")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
});

/**
 * `context-agent <folder>` opens that folder; without one, the folder it was started from. A start
 * with no real working folder opens no project and the app shows its project list as before: a
 * drive or filesystem root (a macOS double-click starts in `/`), the home folder, the storage root,
 * and the executable's own folder (a Windows double-click starts there, e.g. Downloads).
 */
export const launchFolder: {
  (
    cwd: string,
    storageRoot: string,
    executableFolder: string | null,
  ): (argument: string | undefined) => ReturnType<typeof launchFolderBody>;
} & typeof launchFolderBody = EffectFunction.dual(4, launchFolderBody);
function launchFolderBody(
  argument: string | undefined,
  cwd: string,
  storageRoot: string,
  executableFolder: string | null,
): Promise<LaunchFolder> {
  return nodePlatform.runPromise(launchFolderEffect(argument, cwd, storageRoot, executableFolder));
}
const launchFolderEffect = Effect.fn("launch.folder")(function* (
  argument: string | undefined,
  cwd: string,
  storageRoot: string,
  executableFolder: string | null,
): Effect.fn.Return<LaunchFolder, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const candidate = resolve(cwd, argument ?? ".");
  const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
  if (Option.isNone(resolved))
    return argument === undefined ? { kind: "none" } : { kind: "invalid", path: candidate };
  const root = resolved.value;
  const info = yield* fs.stat(root).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory")
    return argument === undefined ? { kind: "none" } : { kind: "invalid", path: candidate };
  if (argument !== undefined) return { kind: "folder", root };
  const home = yield* canonical(yield* homeDirectory);
  const storage = yield* canonical(storageRoot);
  const executable = executableFolder === null ? null : yield* canonical(executableFolder);
  if (root === dirname(root) || root === home || isInside(root, storage) || root === executable)
    return { kind: "none" };
  return { kind: "folder", root };
});

/** Runs the launch requests for callers outside Effect; they reach the app over fetch. */
const launchRuntime = ManagedRuntime.make(FetchHttpClient.layer);
export const runLaunchRequest = <A, E>(request: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  launchRuntime.runPromise(request);

const Project = Schema.Struct({ id: Schema.String, root: Schema.String });
const Rejected = Schema.Struct({
  error: Schema.Literal("project_rejected"),
  reason: Schema.String,
});

export type OpenedProject =
  | { readonly kind: "opened"; readonly projectId: string; readonly added: boolean }
  | { readonly kind: "rejected"; readonly reason: string };

/** Whether something answering on this address is this app (it lists projects). */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const isThisAppEffect = Effect.fn("launch.isThisApp")(function* (baseUrl: string) {
  const response = yield* (yield* HttpClient.HttpClient)
    .get(`${baseUrl}/api/projects`)
    .pipe(Effect.timeout(3_000));
  return (
    response.status >= 200 &&
    response.status < 300 &&
    Schema.is(Schema.Array(Project))(yield* response.json)
  );
});
export const isThisApp = (baseUrl: string) =>
  launchRuntime.runPromise(isThisAppEffect(baseUrl).pipe(Effect.orElseSucceed(() => false)));

/**
 * Registers the folder as a project on the running app, or finds it if it is registered already.
 * Goes through the app's own API, so the same path checks apply as when adding in the browser.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const openProject: {
  (root: string): (baseUrl: string) => ReturnType<typeof openProjectBody>;
} & typeof openProjectBody = EffectFunction.dual(2, openProjectBody);
function openProjectBody(baseUrl: string, root: string): Promise<OpenedProject> {
  return launchRuntime.runPromise(openProjectEffect(baseUrl, root));
}
export const openProjectEffect = Effect.fn("launch.openProject")(function* (
  baseUrl: string,
  root: string,
) {
  const client = yield* HttpClient.HttpClient;
  const payload = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ root: Schema.String })),
  )({ root });
  const response = yield* client.post(`${baseUrl}/api/projects`, {
    body: HttpBody.text(payload, "application/json"),
  });
  const body: unknown = yield* response.json;
  if (response.status === 201 && Schema.is(Project)(body))
    return { kind: "opened", projectId: body.id, added: true } as const satisfies OpenedProject;
  if (!Schema.is(Rejected)(body))
    return {
      kind: "rejected",
      reason: `status ${response.status}`,
    } as const satisfies OpenedProject;
  if (body.reason !== "already_registered")
    return { kind: "rejected", reason: body.reason } as const satisfies OpenedProject;
  const listing = yield* client.get(`${baseUrl}/api/projects`);
  const projects: unknown = yield* listing.json;
  const existing = Schema.is(Schema.Array(Project))(projects)
    ? projects.find((project) => project.root === root)
    : undefined;
  return isTruthy(existing)
    ? ({ kind: "opened", projectId: existing.id, added: false } as const satisfies OpenedProject)
    : ({ kind: "rejected", reason: "already_registered" } as const satisfies OpenedProject);
});
