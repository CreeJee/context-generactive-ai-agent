import { Array as Arr, Effect, FileSystem, MutableHashMap, Option, Path, Schema } from "effect";

const CpuProfile = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      callFrame: Schema.Struct({
        functionName: Schema.String,
        url: Schema.String,
        lineNumber: Schema.Int,
      }),
      children: Schema.optionalKey(Schema.Array(Schema.Int)),
    }),
  ),
  startTime: Schema.Finite,
  endTime: Schema.Finite,
  samples: Schema.Array(Schema.Int),
  timeDeltas: Schema.Array(Schema.Finite),
});
type CpuProfile = typeof CpuProfile.Type;
type ProfileNode = CpuProfile["nodes"][number];

const decodeProfile = Schema.decodeEffect(Schema.fromJsonString(CpuProfile));

/** V8 pseudo-frames reported as categories instead of functions. */
const vmCategories = ["(idle)", "(program)", "(garbage collector)", "(root)"];

const fileOf = (url: string, root: string) => {
  const file = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
};

/** Workspace folder (`packages/memory-agent`), dependency name, `node:` internals or the VM. */
const ownerOf = (file: string) => {
  if (file === "") return "(vm)";
  if (file.startsWith("node:")) return "node";
  const segments = file.split(/(?:^|\/)node_modules\//);
  const dependency = segments.length > 1 ? segments.at(-1) : undefined;
  if (dependency !== undefined) {
    const [scope, name] = dependency.split("/");
    return scope?.startsWith("@") === true ? `${scope}/${name}` : (scope ?? file);
  }
  if (file.startsWith("/")) return "(작업 폴더 밖)";
  return file.split("/").slice(0, 2).join("/");
};

const add = (table: MutableHashMap.MutableHashMap<string, number>, key: string, value: number) =>
  MutableHashMap.modifyAt(table, key, (current) =>
    Option.some(Option.getOrElse(current, () => 0) + value),
  );

const sortedEntries = (table: MutableHashMap.MutableHashMap<string, number>) =>
  Array.from(table).toSorted(([, a], [, b]) => b - a);

const ms = (micros: number) => (micros / 1_000).toFixed(1).padStart(10);
const share = (micros: number, whole: number) =>
  `${((micros / whole) * 100).toFixed(1).padStart(5)}%`;

export const summarizeCpuProfile = (profile: CpuProfile, root: string, top: number) => {
  const nodes = MutableHashMap.fromIterable(profile.nodes.map((node) => [node.id, node] as const));
  const parents = MutableHashMap.fromIterable(
    profile.nodes.flatMap((node) =>
      (node.children ?? []).map((child) => [child, node.id] as const),
    ),
  );
  const parentOf = (node: ProfileNode) =>
    Option.flatMap(MutableHashMap.get(parents, node.id), (id) => MutableHashMap.get(nodes, id));
  const keyOf = (node: ProfileNode) => {
    const { functionName, url, lineNumber } = node.callFrame;
    if (vmCategories.includes(functionName)) return functionName;
    const file = fileOf(url, root);
    return `${functionName === "" ? "(anonymous)" : functionName}  ${file === "" ? "(native)" : `${file}:${lineNumber + 1}`}`;
  };

  const self = MutableHashMap.empty<string, number>();
  const total = MutableHashMap.empty<string, number>();
  const owners = MutableHashMap.empty<string, number>();
  const categories = MutableHashMap.empty<string, number>();
  const wall = profile.endTime - profile.startTime;
  const average = profile.samples.length === 0 ? 0 : wall / profile.samples.length;
  profile.samples.forEach((sampleId, index) => {
    // A delta is the gap before its sample, so each sample lasts until the next one.
    const duration = profile.timeDeltas[index + 1] ?? average;
    const leaf = MutableHashMap.get(nodes, sampleId);
    if (Option.isNone(leaf)) return;
    const leafKey = keyOf(leaf.value);
    if (vmCategories.includes(leaf.value.callFrame.functionName)) {
      add(categories, leafKey, duration);
      return;
    }
    add(self, leafKey, duration);
    add(owners, ownerOf(fileOf(leaf.value.callFrame.url, root)), duration);
    // Count a function once per sample even when it recurses.
    Arr.dedupe(
      Arr.unfold(
        leaf,
        Option.map((node) => [keyOf(node), parentOf(node)] as const),
      ),
    ).forEach((key) => add(total, key, duration));
  });

  const category = (name: string) =>
    Option.getOrElse(MutableHashMap.get(categories, name), () => 0);
  return [
    `샘플 ${profile.samples.length}개, ${ms(wall).trim()} ms (idle ${ms(category("(idle)")).trim()} ms, GC ${ms(category("(garbage collector)")).trim()} ms, program ${ms(category("(program)")).trim()} ms)`,
    "",
    `self 기준 상위 ${top}`,
    "   self ms   share    total ms  function  location",
    ...sortedEntries(self)
      .slice(0, top)
      .map(
        ([key, micros]) =>
          `${ms(micros)}  ${share(micros, wall)}  ${ms(Option.getOrElse(MutableHashMap.get(total, key), () => 0))}  ${key}`,
      ),
    "",
    `total 기준 상위 ${top} (VM 분류 제외)`,
    "  total ms   share  function  location",
    ...sortedEntries(total)
      .filter(([key]) => !vmCategories.includes(key))
      .slice(0, top)
      .map(([key, micros]) => `${ms(micros)}  ${share(micros, wall)}  ${key}`),
    "",
    "소유자별 self (워크스페이스 폴더, 의존성, node, vm)",
    ...sortedEntries(owners).map(
      ([owner, micros]) => `${ms(micros)}  ${share(micros, wall)}  ${owner}`,
    ),
  ].join("\n");
};

export const readCpuProfile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* decodeProfile(yield* fs.readFileString(file));
});

export const workingRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(".");
});
