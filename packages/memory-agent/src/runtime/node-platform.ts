import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import { Layer, ManagedRuntime } from "effect";

/**
 * The Node platform services this process uses: file system, path, crypto, stdio and child
 * processes. Not `NodeServices.layer`: that adds `Terminal`, which nothing here reads and whose
 * build subscribes to `process.stdin` ("end") until its scope closes. Built once per SDK boundary,
 * the backend ended up with one stdin listener per boundary and Node's listener-leak warning.
 */
export const nodePlatformLayer = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer, NodeStdio.layer),
);

export type NodePlatform = Layer.Success<typeof nodePlatformLayer>;

/** The one runtime of those services in this process, for Promise entry points of hosts and SDKs. */
export const nodePlatform = ManagedRuntime.make(nodePlatformLayer);
