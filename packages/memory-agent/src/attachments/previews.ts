import { readFile } from "node:fs/promises";
import type { AnyServerTool } from "@tanstack/ai";
import { Context, Effect, Either, Layer, Option, Schema } from "effect";
import { resolveProjectPath } from "../files/paths.ts";
import type { Project } from "../projects/projects.ts";
import { Attachments } from "./attachments.ts";

/** File tools whose result names the project file they just wrote. */
const writingToolNames: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

/** The result's other fields are kept as they are, so the preview is only added, never swapped in. */
const decodeWritten = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }), {
  onExcessProperty: "preserve",
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
  const attachments = yield* Attachments;

  /**
   * A preview of the SVG a tool just wrote, or nothing. The file is read back through the same
   * project path checks the tool used, so a link swapped in afterwards is refused. A drawing that
   * cannot be rendered only goes without a picture; the write itself already succeeded.
   */
  const previewOf = (project: Project, path: string) =>
    Effect.gen(function* () {
      const resolved = resolveProjectPath(project.root, path, "file");
      if (Either.isLeft(resolved)) return Option.none<DrawingPreview>();
      const svg = yield* Effect.tryPromise(() => readFile(resolved.right.absolute));
      const picture = yield* attachments.saveDrawing(svg);
      return Option.some<DrawingPreview>({
        attachmentId: picture.id,
        mimeType: picture.mimeType,
      });
    }).pipe(Effect.orElseSucceed(() => Option.none<DrawingPreview>()));

  return {
    /**
     * The same tools; `write_file` and `edit_file` add a `preview` to their result when the file is
     * an SVG. The model gets the result too, and the preview only tells it a picture was made.
     */
    withPreviews(project: Project, tools: readonly AnyServerTool[]): AnyServerTool[] {
      return tools.map((tool): AnyServerTool => {
        const execute = tool.execute;
        if (!execute || !writingToolNames.has(tool.name)) return tool;
        return {
          ...tool,
          execute: async (...call: Parameters<typeof execute>) => {
            const result = await execute(...call);
            const written = Option.getOrUndefined(decodeWritten(result));
            if (!written || !isDrawing(written.path)) return result;
            const preview = await Effect.runPromise(previewOf(project, written.path));
            return Option.match(preview, {
              onNone: () => result,
              onSome: (picture) => ({ ...written, preview: picture }),
            });
          },
        };
      });
    },
  };
});

/** Pictures of the drawings the model writes, for showing them in the conversation. */
export class DrawingPreviews extends Context.Tag("memory-agent/DrawingPreviews")<
  DrawingPreviews,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(DrawingPreviews, make);
}
