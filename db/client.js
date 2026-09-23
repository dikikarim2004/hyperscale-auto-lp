import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the whole process (BullMQ workers + telegram
// bot run in-process, so one pool is correct here).
export const prisma = globalThis.__meridianPrisma__ || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__meridianPrisma__ = prisma;
