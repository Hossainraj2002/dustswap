const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
require("ts-node").register({
  project: path.join(__dirname, "../tsconfig.json"),
  transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
});
const { ApplicationFlags } = require("discord.js");
const { getMissingDiscordIntents, waitForRequiredDiscordIntents, getBotHealthResponse } = require("../src/bots/discordIntentPreflight.ts");

const limited = ApplicationFlags.GatewayGuildMembersLimited | ApplicationFlags.GatewayMessageContentLimited;
const verified = ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayMessageContent;

test("both required features remain gated until their verified or limited intent permissions exist", () => {
  assert.deepEqual(getMissingDiscordIntents({ flags: 0 }), ["GUILD_MEMBERS", "MESSAGE_CONTENT"]);
  assert.deepEqual(getMissingDiscordIntents({ flags: ApplicationFlags.GatewayMessageContentLimited }), ["GUILD_MEMBERS"]);
  assert.deepEqual(getMissingDiscordIntents({ flags: limited }), []);
  assert.deepEqual(getMissingDiscordIntents({ flags: verified }), []);
  assert.deepEqual(getMissingDiscordIntents({ flags_new: String(BigInt(limited) | (1n << 40n)) }), []);
});

test("missing privileges wait in-process and start unchanged features automatically after permission recovery", async () => {
  const states = [];
  let checks = 0;
  let waits = 0;
  const application = await waitForRequiredDiscordIntents({
    readApplication: async () => ({ id: "123456789", flags: ++checks < 3 ? 0 : limited }),
    onState: (state) => states.push(state),
    wait: async () => { waits++; },
  });
  assert.equal(application.id, "123456789");
  assert.equal(checks, 3);
  assert.equal(waits, 2);
  assert.deepEqual(states.map((state) => state.status), ["checking-discord-permissions", "waiting-for-discord-intents", "initializing"]);
  assert.deepEqual(states[1].missingIntents, ["GUILD_MEMBERS", "MESSAGE_CONTENT"]);
  assert.equal(states[1].applicationId, "123456789");
});

test("transient REST errors recover without leaking credentials or pretending the bot is ready", async () => {
  const states = [];
  let checks = 0;
  await waitForRequiredDiscordIntents({
    readApplication: async () => {
      if (++checks === 1) throw new Error("request failed: Authorization Bot secret-token");
      return { id: "123456789", flags: limited };
    },
    onState: (state) => states.push(state),
    wait: async () => {},
  });
  assert.deepEqual(states.map((state) => state.status), ["checking-discord-permissions", "discord-unavailable", "initializing"]);
  assert.equal(JSON.stringify(states).includes("secret-token"), false);
});

test("malformed capability responses retry safely instead of logging into a broken gateway session", async () => {
  let checks = 0;
  const states = [];
  await waitForRequiredDiscordIntents({
    readApplication: async () => ({ flags_new: ++checks === 1 ? "not-a-bitfield" : String(limited) }),
    onState: (state) => states.push(state.status),
    wait: async () => {},
  });
  assert.deepEqual(states, ["checking-discord-permissions", "discord-unavailable", "initializing"]);
});

test("liveness stays available while readiness truthfully reports missing permissions, initialization, or disconnects", () => {
  const waiting = { status: "waiting-for-discord-intents", applicationId: "123456789", missingIntents: ["MESSAGE_CONTENT"] };
  const live = getBotHealthResponse(waiting, false, "/health");
  assert.equal(live.statusCode, 200);
  assert.equal(live.body.ready, false);
  assert.deepEqual(live.body.missingIntents, ["MESSAGE_CONTENT"]);
  assert.equal(getBotHealthResponse(waiting, false, "/ready").statusCode, 503);
  assert.equal(getBotHealthResponse({ ...waiting, status: "initializing" }, true, "/ready").statusCode, 503);
  assert.equal(getBotHealthResponse({ ...waiting, status: "ready", missingIntents: [] }, true, "/ready").statusCode, 200);
  const disconnected = getBotHealthResponse({ ...waiting, status: "ready" }, false, "/ready");
  assert.equal(disconnected.statusCode, 503);
  assert.equal(disconnected.body.status, "reconnecting");
});

test("the real bot startup stays live without permissions, then restores every original feature after approval", async () => {
  const discord = require("discord.js");
  let flags = 0;
  let releaseWait;
  const blocked = new Promise((resolve) => { releaseWait = resolve; });
  const clients = [];
  const logs = [];
  const features = { claims: 0, antiScam: 0, boosters: 0, watchdog: 0 };
  let handleHealth;
  const config = { botToken: "private-test-token", guildId: "1", submitChannelId: "2", logChannelId: "3", roleId: "4", maxClaims: 5000 };
  class FakeClient extends EventEmitter {
    constructor(options) { super(); this.options = options; this.ready = false; clients.push(this); }
    isReady() { return this.ready; }
    async login(token) {
      assert.equal(token, config.botToken);
      this.ready = true;
      this.user = { username: "test-bot" };
      this.emit(discord.Events.ClientReady, this);
    }
  }
  class FakeRest {
    setToken(token) { assert.equal(token, config.botToken); return this; }
    async get(route) { assert.equal(route, discord.Routes.currentApplication()); return { id: "123456789", flags }; }
  }
  const modules = {
    "dotenv/config": {},
    "node:http": { createServer(handler) { handleHealth = handler; return { listen(_port, callback) { callback(); } }; } },
    "discord.js": { ...discord, Client: FakeClient, REST: FakeRest },
    "./discordIntentPreflight": {
      getBotHealthResponse,
      waitForRequiredDiscordIntents: (options) => waitForRequiredDiscordIntents({ ...options, wait: () => blocked }),
    },
    "./earlyContributorBotCore": {
      loadConfig: () => config,
      initializeState: async () => {
        features.claims++;
        return { config, guild: { id: "1" }, submitChannel: { name: "claims", id: "2" }, logChannel: { name: "logs", id: "3" }, role: { name: "Early Contributor", id: "4" }, successfulClaimCount: 0 };
      },
      getRoleAssignmentStatus: async () => ({ canManageRoles: true, roleIsBelowBot: true }),
    },
    "./antiScamLinkFilter": { loadAntiScamFilterConfig: () => ({}), startAntiScamLinkFilter: () => { features.antiScam++; } },
    "./boosterOgRole": { loadBoosterOgConfig: () => ({}), startBoosterOgRoleWatcher: () => { features.boosters++; } },
    "./apiWatchdog": { startApiWatchdog: () => { features.watchdog++; } },
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/bots/earlyContributorBot.ts"), "utf8");
  const ts = require("typescript");
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(javascript, {
    exports: {},
    require(name) { assert.ok(name in modules, `Unexpected bot dependency: ${name}`); return modules[name]; },
    process: { env: { PORT: "31337" }, on() {}, exit(code) { throw new Error(`Unexpected bot exit ${code}`); } },
    console: Object.fromEntries(["log", "warn", "error"].map((level) => [level, (...args) => logs.push(args.join(" "))])),
  }, { filename: "earlyContributorBot.js" });
  const readHealth = (url) => {
    let body;
    const response = { statusCode: 0, setHeader() {}, end(value) { body = JSON.parse(value); } };
    handleHealth({ url }, response);
    return { code: response.statusCode, body };
  };
  await new Promise(setImmediate);
  assert.equal(clients.length, 0, "Do not create a gateway session with disallowed intents");
  assert.equal(readHealth("/health").code, 200);
  assert.equal(readHealth("/health").body.status, "waiting-for-discord-intents");
  assert.equal(readHealth("/ready").code, 503);
  assert.ok(logs.some((line) => line.includes("123456789") && line.includes("GUILD_MEMBERS") && line.includes("MESSAGE_CONTENT")));
  assert.equal(logs.some((line) => line.includes(config.botToken)), false);

  flags = limited;
  releaseWait();
  await new Promise(setImmediate);
  assert.equal(clients.length, 1);
  assert.deepEqual(Array.from(clients[0].options.intents), [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildMessages, discord.GatewayIntentBits.MessageContent, discord.GatewayIntentBits.GuildMembers]);
  assert.deepEqual(features, { claims: 1, antiScam: 1, boosters: 1, watchdog: 1 });
  assert.equal(readHealth("/ready").code, 200);
  assert.equal(readHealth("/ready").body.ready, true);
  clients[0].ready = false;
  assert.equal(readHealth("/ready").code, 503);
});
