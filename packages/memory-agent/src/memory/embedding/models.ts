import { Schema } from "effect";
import type { EmbeddingMode } from "./contracts.ts";

/**
 * What a text is embedded for. Models trained with prompts embed a search's query and the
 * documents it looks for with different prefixes, and texts compared with each other with a third.
 */
export const EmbeddingRole = Schema.Literals(["query", "document", "clustering"]);
export type EmbeddingRole = typeof EmbeddingRole.Type;

/**
 * Where the worker reads a text's vector: `cls` is the first token's hidden state, and
 * `sentence-embedding` the pooled vector the model's graph computes itself.
 */
export const EmbeddingOutput = Schema.Literals(["cls", "sentence-embedding"]);
export type EmbeddingOutput = typeof EmbeddingOutput.Type;

/** One published ONNX file, under `onnx/` in the model's folder, without its extension. */
interface ModelFile {
  readonly file: string;
  /**
   * Names the file's vectors in the embedder identity. A change to the model's entry that changes
   * its vectors, prompts included, takes a new tag, so the indexer embeds every node again.
   */
  readonly tag: string;
}

export interface EmbeddingModel {
  /** The Hugging Face model id; the files are downloaded into `<storage>/models/<id>`. */
  readonly id: string;
  readonly dimensions: number;
  readonly output: EmbeddingOutput;
  /** A multimodal model whose text model alone is loaded: its vision and audio configs are dropped. */
  readonly textOnly: boolean;
  /** Prefixed to each text of the role. */
  readonly prompts: Readonly<Record<EmbeddingRole, string>>;
  /**
   * Query/direct-call limit. Indexed documents are first split into chunkPolicy windows, so
   * their tail is never discarded. Keep this separate from the document chunk size.
   */
  readonly maxTokens: number;
  /** Texts per batch at most. */
  readonly batchSize: number;
  /**
   * A batch is padded to its longest text, so it costs about count × longest² in attention. Batches
   * stay within this cost: with 2048², sixteen 512-token texts, or one 2048-token one.
   */
  readonly batchCost: number;
  /** The file each mode runs. */
  readonly files: Readonly<Record<EmbeddingMode, ModelFile>>;
}

export const EmbeddingModelName = Schema.Literals(["granite-97m-r2"]);
export type EmbeddingModelName = typeof EmbeddingModelName.Type;

export const embeddingModels = {
  /**
   * Chosen 2026-09: Apache-2.0, 384 dims, 32k context, Korean in its enhanced-support set. On the CPU
   * `quint8` has about 1 GB less memory and is twice as fast as `fp32`, for MRR 0.831 instead of
   * 0.852 on the Korean recall set. WebGPU runs `fp32` as fast as the CPU runs `quint8`.
   */
  "granite-97m-r2": {
    id: "ibm-granite/granite-embedding-97m-multilingual-r2",
    dimensions: 384,
    output: "cls",
    textOnly: false,
    prompts: { query: "", document: "", clustering: "" },
    maxTokens: 2048,
    batchSize: 16,
    batchCost: 2048 * 2048,
    files: {
      cpu: { file: "model_quint8_avx2", tag: "quint8" },
      gpu: { file: "model", tag: "fp32" },
    },
  },
} as const satisfies Record<EmbeddingModelName, EmbeddingModel>;

/** The model the app runs. Changing it embeds every node again with the new model. */
export const localModel: EmbeddingModel = embeddingModels["granite-97m-r2"];

/** Where the file a mode runs sits in the model cache, relative to the model's folder. */
export const modelFile = (mode: EmbeddingMode) => `onnx/${localModel.files[mode].file}.onnx`;
