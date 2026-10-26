import { nativePromise, runNativeEffectWith } from "../runtime/native-effect.ts";
import { onRun, runTrace } from "../runtime/run-trace.ts";
import { HashSet } from "effect";
import { errorTag } from "../tools/failure.ts";
import type { AnyServerTool } from "@tanstack/ai";
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { resolveProjectPath } from "../files/paths.ts";
import { readFileBytesEffect } from "../files/text.ts";
import type { JsonValue } from "../json.ts";
import type { Project } from "../projects/projects.ts";
import type { PreparedCall, RunTool } from "../tools/run-tool.ts";
import { Attachments } from "./attachments.ts";

/** File tools whose result names the project file they just wrote. */
const writingToolNames = HashSet.fromIterable(["write_file", "edit_file"]);

/** The result's other fields are kept as they are, so the preview is only added, never swapped in. */
const decodeWritten = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }), {
  onExcessProperty: "ignore",
});

/**
 * The picture a tool result carries so the page can show what was drawn. It is a snapshot taken
 * when the file was written: the node that records this result never changes, so neither may the
 * picture it points at, even after the file is edited or deleted.
 */
export interface DrawingPreview {
  readonly attachmentId: string;
  readonly mimeType: string;
}

const isDrawing = (path: string) => path.toLowerCase().endsWith(".svg");

const make = Effect.gen(function* () {
  const services = yield* Effect.context<never>();
  const attachments = yield* Attachments;

  /**
   * A preview of the SVG a tool just wrote, or nothing. The file is read back through the same
   * project path checks the tool used, so a link swapped in afterwards is refused. A drawing that
   * cannot be rendered only goes without a picture; the write itself already succeeded.
   */
  const previewOf = (project: Project, path: string) =>
    Effect.gen(function* () {
      const { absolute } = yield* resolveProjectPath(project.root, path, "file");
      const { bytes: svg } = yield* readFileBytesEffect({ absolute, path, checkLeaf: true });
      const picture = yield* attachments.saveDrawing(svg);
      return Option.some<DrawingPreview>({
        attachmentId: picture.id,
        mimeType: picture.mimeType,
      });
    }).pipe(
      // The preview is extra: the tool's own result stands without it.
      Effect.catch((error) =>
        Effect.as(
          Effect.logDebug("drawing_preview_unavailable", { error: errorTag(error) }),
          Option.none<DrawingPreview>(),
        ),
      ),
    );

  return {
    /**
     * The same tools; `write_file` and `edit_file` add a `preview` to their result when the file is
     * an SVG. The model gets the result too, and the preview only tells it a picture was made.
     * The preview runs on the run's context, so its spans join the run's trace.
     */
    withPreviews: (project: Project, tools: readonly AnyServerTool[]) =>
      Effect.map(runTrace, (caller): AnyServerTool[] => {
        const run = runNativeEffectWith(onRun(services, caller));
        return tools.map((tool): AnyServerTool =>
          Option.fromNullishOr(tool.execute).pipe(
            Option.filter(() => HashSet.has(writingToolNames, tool.name)),
            Option.match({
              onNone: () => tool,
              onSome: (execute) => ({
                ...tool,
                // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                execute: (...call: Parameters<typeof execute>) =>
                  run(
                    Effect.flatMap(
                      nativePromise(() => Promise.resolve(execute(...call))),
                      (result) =>
                        decodeWritten(result).pipe(
                          Option.filter((written) => isDrawing(written.path)),
                          Option.match({
                            onNone: () => Effect.succeed(result),
                            onSome: (written) =>
                              Effect.map(
                                previewOf(project, written.path),
                                Option.match({
                                  onNone: () => result,
                                  onSome: (picture) => ({ ...result, preview: picture }),
                                }),
                              ),
                          }),
                        ),
                    ),
                  ),
              }),
            }),
          ),
        );
      }),

    /** {@link withPreviews} for the Effect AI loop (docs/effect-ai-migration.md step 3). */
    withRunPreviews: (project: Project, tools: ReadonlyArray<RunTool>): Array<RunTool> =>
      tools.map((tool) =>
        HashSet.has(writingToolNames, tool.tool.name)
          ? {
              ...tool,
              prepare: (params) =>
                Effect.map(
                  tool.prepare(params),
                  (run): PreparedCall =>
                    (call) =>
                      Effect.flatMap(run(call), (result) =>
                        Option.match(drawingIn(result), {
                          onNone: () => Effect.succeed(result),
                          onSome: ({ written, path }) =>
                            Effect.map(
                              previewOf(project, path),
                              Option.match({
                                onNone: (): JsonValue => written,
                                onSome: (picture) => ({ ...written, preview: { ...picture } }),
                              }),
                            ),
                        }),
                      ),
                ),
            }
          : tool,
      ),
  };
});

const isJsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  Predicate.isObject(value) && !Array.isArray(value);

/** The result of a call that wrote an SVG, with the drawing's path. */
const drawingIn = (result: JsonValue) =>
  Option.liftPredicate(result, isJsonRecord).pipe(
    Option.flatMap((written) =>
      Option.map(decodeWritten(written), ({ path }) => ({ written, path })),
    ),
    Option.filter(({ path }) => isDrawing(path)),
  );

/** Pictures of the drawings the model writes, for showing them in the conversation. */
export class DrawingPreviews extends Context.Service<
  DrawingPreviews,
  Effect.Success<typeof make>
>()("memory-agent/attachments/previews/DrawingPreviews") {
  static readonly layer = Layer.effect(DrawingPreviews, make);
}
