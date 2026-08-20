import { fileURLToPath } from "node:url";

import { NativeConnection, Runtime, Worker } from "@temporalio/worker";

import { config } from "../lib/config";
import { activities } from "./activities";

async function main() {
  Runtime.install({});
  const connection = await NativeConnection.connect({ address: config.temporal.address });
  const worker = await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
    maxConcurrentActivityTaskExecutions: 8,
    maxConcurrentWorkflowTaskExecutions: 32,
    shutdownGraceTime: "30 seconds",
  });

  console.log(
    `CloudAgent Temporal worker listening on ${config.temporal.address} queue ${config.temporal.taskQueue}`,
  );
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
