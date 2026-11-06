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
   * stay within this cost; a text over it alone is a batch of its own.
   */
  readonly batchCost: number;
  /** The file each mode runs. */
  readonly files: Readonly<Record<EmbeddingMode, ModelFile>>;
}

export const EmbeddingModelName = Schema.Literals(["granite-97m-r2", "embeddinggemma-2"]);
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
    // Sixteen 512-token texts, or one 2048-token one.
    batchCost: 2048 * 2048,
    files: {
      cpu: { file: "model_quint8_avx2", tag: "quint8" },
      gpu: { file: "model", tag: "fp32" },
    },
  },
  /**
   * Chosen 2026-11 (docs/decisions.md): Apache-2.0, a 270M text model with 768 dims, 8k context and
   * 100+ languages, trained with a prompt per task (its sentence-transformers config). The ONNX
   * export also holds vision and audio encoders; only the text model is loaded. Both files stay
   * within 0.9998 (fp16) and 0.9997 (q8) cosine of fp32. Measured on Apple Silicon with 512-token
   * texts: four of them per batch run fastest on both devices, fp16 on WebGPU at about 4,850
   * tokens/s and q8 on the CPU at about 860.
   */
  "embeddinggemma-2": {
    id: "onnx-community/embeddinggemma-2-ONNX",
    dimensions: 768,
    output: "sentence-embedding",
    textOnly: true,
    prompts: {
      query: "task: search result | query: ",
      document: "title: none | text: ",
      clustering: "task: clustering | query: ",
    },
    maxTokens: 2048,
    batchSize: 16,
    // Four 512-token texts, or sixteen of 256.
    batchCost: 4 * 512 * 512,
    files: {
      cpu: { file: "model_quantized", tag: "q8" },
      gpu: { file: "model_fp16", tag: "fp16" },
    },
  },
} as const satisfies Record<EmbeddingModelName, EmbeddingModel>;

/** The model the app runs. Changing it embeds every node again with the new model. */
export const localModel: EmbeddingModel = embeddingModels["embeddinggemma-2"];

/** Where the file a mode runs sits in the model cache, relative to the model's folder. */
export const modelFile = (mode: EmbeddingMode) => `onnx/${localModel.files[mode].file}.onnx`;
