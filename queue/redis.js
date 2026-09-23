/**
 * Shared IORedis connection for BullMQ. One connection, reused by every
 * Queue/Worker/QueueEvents instance in the process (per BullMQ's own
 * recommendation — avoids exhausting Redis connections with hundreds of users).
 */

import IORedis from "ioredis";
import { log } from "../logger.js";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// BullMQ requires maxRetriesPerRequest: null on connections passed to Queue/Worker.
export const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (error) => {
  log("redis_error", `Redis connection error: ${error.message}`);
});

connection.on("connect", () => {
  log("redis", `Connected to Redis at ${REDIS_URL.replace(/:[^:@/]*@/, ":***@")}`);
});

export async function closeRedisConnection() {
  await connection.quit();
}
