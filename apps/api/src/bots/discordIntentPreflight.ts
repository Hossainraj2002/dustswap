import { setTimeout as delay } from "node:timers/promises";
import { ApplicationFlags } from "discord.js";

export type RequiredDiscordIntent = "GUILD_MEMBERS" | "MESSAGE_CONTENT";

export type DiscordApplicationInfo = {
  id?: string;
  flags?: number | string | null;
  flags_new?: string | null;
};

export type BotHealthState = {
  status: "starting" | "checking-discord-permissions" | "waiting-for-discord-intents" | "discord-unavailable" | "initializing" | "ready" | "failed";
  applicationId?: string;
  missingIntents: RequiredDiscordIntent[];
};

const REQUIRED_FLAGS: Array<[RequiredDiscordIntent, number, number]> = [
  ["GUILD_MEMBERS", ApplicationFlags.GatewayGuildMembers, ApplicationFlags.GatewayGuildMembersLimited],
  ["MESSAGE_CONTENT", ApplicationFlags.GatewayMessageContent, ApplicationFlags.GatewayMessageContentLimited],
];

export function getMissingDiscordIntents(application: DiscordApplicationInfo): RequiredDiscordIntent[] {
  const flags = BigInt(application.flags_new ?? application.flags ?? 0);
  if (flags < 0n) throw new Error("Invalid Discord application flags");
  return REQUIRED_FLAGS.filter(([, verified, limited]) => (flags & BigInt(verified | limited)) === 0n)
    .map(([intent]) => intent);
}

/** Wait for the existing features' permissions; never grant privileges or remove required intents. */
export async function waitForRequiredDiscordIntents(options: {
  readApplication: () => Promise<DiscordApplicationInfo>;
  onState: (state: BotHealthState) => void;
  wait?: () => Promise<unknown>;
}): Promise<DiscordApplicationInfo> {
  let lastStateKey = "";
  const publish = (state: BotHealthState) => {
    const key = JSON.stringify(state);
    if (key !== lastStateKey) {
      lastStateKey = key;
      options.onState(state);
    }
  };
  publish({ status: "checking-discord-permissions", missingIntents: [] });

  for (;;) {
    try {
      const application = await options.readApplication();
      const missingIntents = getMissingDiscordIntents(application);
      const applicationId = /^\d+$/.test(application.id || "") ? application.id : undefined;
      if (missingIntents.length === 0) {
        publish({ status: "initializing", applicationId, missingIntents: [] });
        return application;
      }
      publish({ status: "waiting-for-discord-intents", applicationId, missingIntents });
    } catch {
      // A REST error can contain credentials in request details. Expose only the safe state.
      publish({ status: "discord-unavailable", missingIntents: [] });
    }
    await (options.wait?.() ?? delay(60_000));
  }
}

export function getBotHealthResponse(state: BotHealthState, connected: boolean, path = "/health") {
  const ready = state.status === "ready" && connected;
  const readinessRequest = path.split("?")[0] === "/ready";
  return {
    statusCode: readinessRequest && !ready ? 503 : 200,
    body: {
      ok: readinessRequest ? ready : true,
      service: "early-contributor-bot",
      ready,
      status: state.status === "ready" && !connected ? "reconnecting" : state.status,
      applicationId: state.applicationId,
      missingIntents: state.missingIntents,
    },
  };
}
