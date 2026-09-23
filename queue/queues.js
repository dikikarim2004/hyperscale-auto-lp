/**
 * BullMQ queue definitions — one queue per cycle type, jobs partitioned per
 * telegramId via BullMQ Job Schedulers (repeatable jobs keyed by a stable id).
 * This lets hundreds of users run independent recurring cycles in a single
 * Node process without any per-user setInterval/cron task.
 */

import { Queue } from "bullmq";
import { connection } from "./redis.js";
import { getUserConfig, listActiveUsers } from "../user-config-service.js";
import { log } from "../logger.js";

export const QUEUE_NAMES = {
  MANAGEMENT: "management-cycle",
  SCREENING: "screening-cycle",
  HEALTHCHECK: "health-check-cycle",
  PNL_POLL: "pnl-poll-cycle",
  OPPORTUNITY_POLL: "opportunity-poll-cycle",
  BRIEFING: "morning-briefing",
};

const JOB_DEFAULTS = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 200 },
  attempts: 1, // cycles are recurring — a failed run just waits for the next scheduled tick
};

export const managementQueue = new Queue(QUEUE_NAMES.MANAGEMENT, { connection });
export const screeningQueue = new Queue(QUEUE_NAMES.SCREENING, { connection });
export const healthCheckQueue = new Queue(QUEUE_NAMES.HEALTHCHECK, { connection });
export const pnlPollQueue = new Queue(QUEUE_NAMES.PNL_POLL, { connection });
export const opportunityPollQueue = new Queue(QUEUE_NAMES.OPPORTUNITY_POLL, { connection });
export const briefingQueue = new Queue(QUEUE_NAMES.BRIEFING, { connection });

const QUEUES_BY_TYPE = {
  management: managementQueue,
  screening: screeningQueue,
  healthcheck: healthCheckQueue,
  pnlpoll: pnlPollQueue,
  briefing: briefingQueue,
};

function schedulerId(type, telegramId) {
  return `user:${telegramId}:${type}`;
}

/** (Re)register this user's recurring jobs based on their current schedule/pnl/opportunity config. */
export async function scheduleUserCycles(telegramId, userConfig) {
  const id = String(telegramId);
  const scheduleConfig = userConfig?.schedule || {};
  const pnlConfig = userConfig?.pnl || {};
  const opportunityConfig = userConfig?.opportunity || {};

  const everyMs = {
    management: Math.max(1, Number(scheduleConfig.managementIntervalMin) || 10) * 60_000,
    screening: Math.max(1, Number(scheduleConfig.screeningIntervalMin) || 30) * 60_000,
    healthcheck: Math.max(1, Number(scheduleConfig.healthCheckIntervalMin) || 60) * 60_000,
    pnlpoll: Math.max(1, Number(pnlConfig.pollIntervalSec) || 3) * 1000,
  };

  for (const [type, queue] of Object.entries(QUEUES_BY_TYPE)) {
    if (type === "briefing") continue; // scheduled separately below (cron pattern, not "every")
    await queue.upsertJobScheduler(
      schedulerId(type, id),
      { every: everyMs[type] },
      {
        name: type,
        data: { telegramId: id },
        opts: JOB_DEFAULTS,
      },
    );
  }

  // Morning briefing — daily at 1:00 AM UTC (matches the old node-cron "0 1 * * *").
  await briefingQueue.upsertJobScheduler(
    schedulerId("briefing", id),
    { pattern: "0 1 * * *", tz: "UTC" },
    { name: "briefing", data: { telegramId: id }, opts: JOB_DEFAULTS },
  );

  // Opportunity poll only runs when the user has it enabled.
  if (opportunityConfig.enabled) {
    const oppMs = Math.max(15, Number(opportunityConfig.pollIntervalSec) || 45) * 1000;
    await opportunityPollQueue.upsertJobScheduler(
      schedulerId("opportunitypoll", id),
      { every: oppMs },
      { name: "opportunitypoll", data: { telegramId: id }, opts: JOB_DEFAULTS },
    );
  } else {
    await opportunityPollQueue.removeJobScheduler(schedulerId("opportunitypoll", id));
  }

  log(
    "queue",
    `Scheduled cycles for ${id}: management=${everyMs.management / 60_000}m screening=${everyMs.screening / 60_000}m ` +
    `healthcheck=${everyMs.healthcheck / 60_000}m pnlPoll=${everyMs.pnlpoll / 1000}s ` +
    `opportunityPoll=${opportunityConfig.enabled ? `${opportunityConfig.pollIntervalSec || 45}s` : "off"} briefing=daily@01:00UTC`,
  );
}

/** Remove all recurring jobs for a user (e.g. agent disabled or user deleted). */
export async function unscheduleUserCycles(telegramId) {
  const id = String(telegramId);
  for (const type of Object.keys(QUEUES_BY_TYPE)) {
    await QUEUES_BY_TYPE[type].removeJobScheduler(schedulerId(type, id));
  }
  await opportunityPollQueue.removeJobScheduler(schedulerId("opportunitypoll", id));
  log("queue", `Unscheduled cycles for ${id}`);
}

/**
 * Re-reads this user's config from the DB and re-registers their job
 * schedulers with the new interval(s)/toggles. Wired into
 * tools/executor.js's registerCronRestarter(fn) hook, so `/config` changes to
 * schedule, pnl, or opportunity settings take effect immediately instead of
 * waiting for a process restart.
 */
export async function rescheduleUserCycles(telegramId) {
  const id = String(telegramId);
  const userConfig = await getUserConfig(id);
  await scheduleUserCycles(id, userConfig);
}

/** Bootstrap: register recurring jobs for every currently-active user. Call once at startup. */
export async function scheduleAllActiveUsers() {
  const users = await listActiveUsers();
  for (const user of users) {
    try {
      const userConfig = await getUserConfig(user.telegramId);
      await scheduleUserCycles(user.telegramId, userConfig);
    } catch (error) {
      log("queue_error", `Failed to schedule cycles for ${user.telegramId}: ${error.message}`);
    }
  }
  log("queue", `Bootstrapped recurring cycles for ${users.length} active user(s)`);
}
