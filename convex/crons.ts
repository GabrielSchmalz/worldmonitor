import { cronJobs } from "convex/server";

const crons = cronJobs();

// Phase 1: uncomment after creating convex/telegramPairingTokens.ts and running npx convex dev --once
// import { internal } from "./_generated/api";
// crons.hourly("cleanup-expired-pairing-tokens", { minuteUTC: 0 }, internal.telegramPairingTokens.cleanupExpired);

export default crons;
