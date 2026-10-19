import { nativePromise, runNativeEffectWith } from "../runtime/native-effect.ts";
import { onRun, type RunTrace } from "../runtime/run-trace.ts";
import { HashSet } from "effect";
import { isTruthy } from "../truthy.ts";
import type { AnyServerTool } from "@tanstack/ai";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { resolveProjectPath } from "../files/paths.ts";
import { readFileBytesEffect } from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
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
          Effect.logDebug("drawing_preview_unavailable", { error: error._tag }),
          Option.none<DrawingPreview>(),
        ),
      ),
    );

  return {
    /**
     * The same tools; `write_file` and `edit_file` add a `preview` to their result when the file is
     * an SVG. The model gets the result too, and the preview only tells it a picture was made.
     * `caller` is the run's context, so the preview's spans join the run's trace.
     */
    withPreviews(
      project: Project,
      tools: readonly AnyServerTool[],
      caller?: RunTrace,
    ): AnyServerTool[] {
      const run = runNativeEffectWith(onRun(services, caller));
      return tools.map((tool): AnyServerTool => {
        const execute = tool.execute;
        if (!isTruthy(execute) || !HashSet.has(writingToolNames, tool.name)) return tool;
        return {
          ...tool,
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          execute: (...call: Parameters<typeof execute>) =>
            run(
              Effect.gen(function* () {
                const result = yield* nativePromise(() => Promise.resolve(execute(...call)));
                const written = Option.getOrUndefined(decodeWritten(result));
                if (!(written !== undefined) || !isDrawing(written.path)) return result;
                const preview = yield* previewOf(project, written.path);
                return Option.match(preview, {
                  onNone: () => result,
                  onSome: (picture) => ({ ...result, preview: picture }),
                });
              }),
            ),
        };
      });
    },
  };
});

/** Pictures of the drawings the model writes, for showing them in the conversation. */
export class DrawingPreviews extends Context.Service<
  DrawingPreviews,
  Effect.Success<typeof make>
>()("memory-agent/attachments/previews/DrawingPreviews") {
  static readonly layer = Layer.effect(DrawingPreviews, make);
}
