import { Effect, FileSystem, Path } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { withTestPlatform } from "../../tests/support/platform.ts";
import { readLinesFrom } from "./lines.ts";

it.live("resumes at complete UTF-8 lines across a 1 MiB read boundary and an unfinished tail", () =>
  Effect.scoped(
    withTestPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const transcript = path.join(directory, "cursor.jsonl");
        const first = `${"x".repeat(1024 * 1024 - 2)}한`;
        const complete = `${first}\n  \n`;
        yield* fs.writeFileString(transcript, `${complete}미완성`);
        const seen: string[] = [];
        const initial = yield* readLinesFrom(transcript, 0, (line) => seen.push(line));
        expect(seen).toEqual([first]);
        expect(initial).toEqual({ offset: new TextEncoder().encode(complete).length, lines: 1 });
        yield* fs.writeFileString(transcript, "\n", { flag: "a" });
        const resumed = yield* readLinesFrom(initial.offset, (line) => seen.push(line))(transcript);
        expect(seen).toEqual([first, "미완성"]);
        expect(resumed).toEqual({
          offset: new TextEncoder().encode(`${complete}미완성\n`).length,
          lines: 1,
        });
      }),
    ),
  ),
);
