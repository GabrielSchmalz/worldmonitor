import { internalMutation } from "./_generated/server";

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (_ctx) => {
    // Phase 1: implement cleanup of telegramPairingTokens where expiresAt < Date.now()
  },
});
