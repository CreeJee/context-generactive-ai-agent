import { it as effectTest } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { embeddedKindFilter, Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { SecretSweep } from "../src/secrets/sweep.ts";
import { testRuntime } from "./support/runtime.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Assembled at run time so no key-shaped text sits in the repository. */
const githubToken = `${"gh"}p_${"Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"}`;

const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Finite }));
const decodeText = Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }));
const decodeValue = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }));

describe("SecretSweep", () => {
  effectTest.live(
    "hides secrets stored before redaction, in the text and in everything made from it",
    () =>
      Effect.gen(function* () {
        const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
        const result = yield* Effect.provideContext(
          Effect.gen(function* () {
            const nodes = yield* Nodes;
            const { sqlite } = yield* Database;
            const indexer = yield* Indexer;
            // Written the way it was before redaction existed: straight in. A statement, so it has a
            // vector to drop and make again.
            const leaked = nodes.append({
              projectId: project.id,
              sessionId: session.id,
              kind: "user",
              text: `GITHUB_TOKEN=${githubToken}\ndeploy ok`,
            });
            const clean = nodes.append({
              projectId: project.id,
              sessionId: session.id,
              kind: "assistant",
              text: "배포가 끝났어요",
            });
            yield* indexer.indexAll();
            yield* indexer.analyzeAll();

            const count = Effect.fnUntraced(function* (
              sql: string,
              ...values: Array<string | number>
            ) {
              return (yield* decodeCount(sqlite.prepare(sql).get(...values))).count;
            });
            const trigram = Effect.fnUntraced(function* (query: string) {
              return yield* count(
                "SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH ?",
                `"${query}"`,
              );
            });
            // The test analyser splits at `_` and lower-cases, so the token's body is one term.
            const termHits = Effect.fnUntraced(function* () {
              return yield* count(
                "SELECT count(*) AS count FROM nodes_morph WHERE nodes_morph MATCH ?",
                `"${githubToken.slice(4).toLowerCase()}"`,
              );
            });
            const before = {
              tokenHits: yield* trigram(githubToken.slice(4, 20)),
              terms: yield* termHits(),
            };

            const hidden = yield* (yield* SecretSweep).run;
            // Re-embedding and re-analysis ran inside the sweep; nothing is left pending.
            const text = (yield* decodeText(
              sqlite.prepare("SELECT text FROM nodes WHERE id = ?").get(leaked.id),
            )).text;
            return {
              before,
              hidden,
              text,
              cleanText: (yield* decodeText(
                sqlite.prepare("SELECT text FROM nodes WHERE id = ?").get(clean.id),
              )).text,
              tokenHits: yield* trigram(githubToken.slice(4, 20)),
              redactedHits: yield* trigram("redacted:github"),
              terms: yield* termHits(),
              pendingVectors: yield* count(
                `SELECT count(*) AS count FROM nodes n LEFT JOIN node_vectors v ON v.node_seq = n.seq WHERE v.node_seq IS NULL AND length(n.text) > 0 AND ${embeddedKindFilter}`,
              ),
            };
          }),
          yield* runtime.contextEffect,
        );

        // Both indexes held the token before the sweep, so the checks below mean something.
        expect(result.before).toEqual({ tokenHits: 1, terms: 1 });
        expect(result.hidden).toBe(1);
        expect(result.text).toBe("GITHUB_TOKEN=[redacted:github]\ndeploy ok");
        expect(result.cleanText).toBe("배포가 끝났어요");
        // The search index lost the old text and holds the new one.
        expect(result.tokenHits).toBe(0);
        expect(result.redactedHits).toBe(1);
        expect(result.terms).toBe(0);
        expect(result.pendingVectors).toBe(0);
      }),
  );

  effectTest.live("nodes stay immutable outside a sweep", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const node = (yield* Nodes).append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "원문",
          });
          const { sqlite } = yield* Database;
          expect(() =>
            sqlite.prepare("UPDATE nodes SET text = 'changed' WHERE seq = ?").run(node.seq),
          ).toThrow("nodes are immutable evidence");
          // Even with a permit, only the text may change.
          sqlite.prepare("INSERT INTO secret_sweep_permits VALUES (?)").run(node.seq);
          expect(() =>
            sqlite.prepare("UPDATE nodes SET kind = 'assistant' WHERE seq = ?").run(node.seq),
          ).toThrow("nodes are immutable evidence");
          sqlite.prepare("DELETE FROM secret_sweep_permits").run();
        }),
        yield* runtime.contextEffect,
      );
    }),
  );

  effectTest.live("sweeps the saved conversation, approvals, references and queued messages", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
      const swept = yield* Effect.provideContext(
        Effect.gen(function* () {
          const { sqlite } = yield* Database;
          const call = (yield* Nodes).append({
            projectId: project.id,
            sessionId: session.id,
            kind: "tool_call",
            text: "fetch",
            refs: [`https://api.example.com/?token=${githubToken}`],
          });
          sqlite
            .prepare("INSERT INTO chat_threads VALUES (?, ?, 0)")
            .run(
              session.id,
              yield* stringifyJson([
                { role: "tool", content: `token: ${githubToken}`, toolCallId: "c-1" },
              ]),
            );
          sqlite
            .prepare(
              "INSERT INTO permission_reviews (session_id, tool_call_id, tool_name, input, decision, decided_by, reason, created_at) VALUES (?, 'c-2', 'run_shell', ?, 'ask', 'user', 'x', '2026')",
            )
            .run(
              session.id,
              yield* stringifyJson({ command: `GITHUB_TOKEN=${githubToken} gh pr list` }),
            );
          sqlite
            .prepare(
              "INSERT INTO queued_messages (id, session_id, seq, text, state, created_at, updated_at) VALUES ('q-1', ?, 1, ?, 'held', 0, 0)",
            )
            .run(session.id, `이걸로 해줘 ${githubToken}`);

          const sweep = yield* SecretSweep;
          yield* sweep.run;
          const again = yield* sweep.run;
          const value = Effect.fnUntraced(function* (sql: string, ...values: string[]) {
            return (yield* decodeValue(sqlite.prepare(sql).get(...values))).value;
          });
          return {
            again,
            done: sweep.progress().every((entry) => entry.done),
            ref: yield* value("SELECT ref AS value FROM node_refs WHERE node_id = ?", call.id),
            thread: yield* value(
              "SELECT messages AS value FROM chat_threads WHERE thread_id = ?",
              session.id,
            ),
            review: yield* value("SELECT input AS value FROM permission_reviews"),
            queued: yield* value("SELECT text AS value FROM queued_messages WHERE id = 'q-1'"),
          };
        }),
        yield* runtime.contextEffect,
      );

      expect(swept.ref).toBe("https://api.example.com/?token=[redacted:github]");
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(swept.thread),
      ).toEqual([{ role: "tool", content: "token: [redacted:github]", toolCallId: "c-1" }]);
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(swept.review),
      ).toEqual({
        command: "GITHUB_TOKEN=[redacted:github] gh pr list",
      });
      expect(swept.queued).toBe("이걸로 해줘 [redacted:github]");
      // A second pass finds nothing more to hide.
      expect(swept.again).toBe(0);
      expect(swept.done).toBe(true);
    }),
  );

  effectTest.live("catches what arrives after a finished pass, on the next one", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
      const later = yield* Effect.provideContext(
        Effect.gen(function* () {
          const { sqlite } = yield* Database;
          const sweep = yield* SecretSweep;
          // Nothing to sweep yet: both passes reach the end and remember it.
          sqlite.prepare("INSERT INTO chat_threads VALUES (?, '[]', 0)").run(session.id);
          yield* sweep.run;

          // Text that skipped the way in: an older build wrote this node, and the conversation grew
          // inside its one row.
          (yield* Nodes).append({
            projectId: project.id,
            sessionId: session.id,
            kind: "tool_result",
            text: `GITHUB_TOKEN=${githubToken}`,
          });
          sqlite
            .prepare("UPDATE chat_threads SET messages = ? WHERE thread_id = ?")
            .run(yield* stringifyJson([{ role: "user", content: githubToken }]), session.id);

          const changed = yield* sweep.run;
          const value = Effect.fnUntraced(function* (sql: string) {
            return (yield* decodeValue(sqlite.prepare(sql).get())).value;
          });
          return {
            changed,
            node: yield* value("SELECT text AS value FROM nodes ORDER BY seq DESC LIMIT 1"),
            thread: yield* value("SELECT messages AS value FROM chat_threads"),
          };
        }),
        yield* runtime.contextEffect,
      );
      expect(later.changed).toBe(1);
      expect(later.node).toBe("GITHUB_TOKEN=[redacted:github]");
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(later.thread),
      ).toEqual([{ role: "user", content: "[redacted:github]" }]);
    }),
  );
});
