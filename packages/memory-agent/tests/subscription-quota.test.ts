import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { SubscriptionQuota } from "../src/oauth/subscription-quota.ts";

const oauthSchema = migrations
  .filter((sql) => sql.includes("CREATE TABLE oauth_profiles ("))
  .join("\n");

describe("subscription quota status", () => {
  it.effect(
    "each account of a provider reports why its quota is unavailable, without numbers",
    () =>
      Effect.gen(function* () {
        const sqlite = new DatabaseSync(":memory:");
        sqlite.exec(oauthSchema);
        const insert = sqlite.prepare(
          "INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES (?, ?, ?, ?, ?)",
        );
        insert.run("legacy-openai", "openai", "A", 1, 1);
        insert.run("11111111-1111-4111-8111-111111111111", "openai", "B", 0, 2);
        insert.run("legacy-anthropic", "anthropic", "C", 1, 3);
        const database = Layer.succeed(Database, { sqlite, atomic: (work) => work() });

        const services = yield* Layer.build(SubscriptionQuota.layer.pipe(Layer.provide(database)));
        const quota = yield* Effect.provideContext(SubscriptionQuota, services);
        const openai = yield* quota.accounts("openai");
        const anthropic = yield* quota.accounts("anthropic");

        expect(openai.accounts).toEqual([
          {
            accountId: "legacy-openai",
            label: "A",
            selected: true,
            quota: { status: "unavailable", reason: "no_permitted_route" },
          },
          {
            accountId: "11111111-1111-4111-8111-111111111111",
            label: "B",
            selected: false,
            quota: { status: "unavailable", reason: "no_permitted_route" },
          },
        ]);
        expect(anthropic.accounts.map((account) => account.quota)).toEqual([
          { status: "unavailable", reason: "provider_policy_restricted" },
        ]);
      }),
  );
});
