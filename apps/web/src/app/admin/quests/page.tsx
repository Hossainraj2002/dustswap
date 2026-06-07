"use client";

import { useEffect, useState } from "react";
import { AdminManualPointsPanel } from "@/components/admin/AdminManualPointsPanel";
import {
  fetchAdminCampaignWhitelist,
  deleteAdminQuest,
  fetchAdminQuests,
  saveAdminQuest,
} from "@/lib/quests";
import type { AdminQuestInput } from "@/types/quests";
import { SUPPORTED_SWAP_CAPTURE_CHAINS } from "@/config/swapChains";

type SwapQuestChainOption = "all" | `${number}`;

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the quest API. Check NEXT_PUBLIC_API_URL on Vercel and make sure it uses the Railway root URL without /api.";
  }
  return message;
}

function padDateTimePart(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

function toDateTimeLocalValue(value?: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const datePart = [
    padDateTimePart(date.getUTCFullYear(), 4),
    padDateTimePart(date.getUTCMonth() + 1),
    padDateTimePart(date.getUTCDate()),
  ].join("-");
  const timePart = [
    padDateTimePart(date.getUTCHours()),
    padDateTimePart(date.getUTCMinutes()),
  ].join(":");

  return `${datePart}T${timePart}`;
}

function toIsoOrNull(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const [datePart, timePart = "00:00"] = trimmed.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = timePart.split(":").map(Number);
  const utcTime = Date.UTC(year, month - 1, day, hour, minute, second);

  return Number.isNaN(utcTime) ? null : new Date(utcTime).toISOString();
}

function formatAdminQuestInstant(value: string | null | undefined) {
  if (!value) {
    return "—";
  }
  const utcValue = toDateTimeLocalValue(value);
  return utcValue
    ? `${utcValue.replace("T", " ")} UTC`
    : "Invalid date (fix in DB or re-save)";
}

function isSwapQuest(form: AdminQuestInput) {
  return form.actionType === "swap_volume" || form.actionType === "swap_count";
}

function isDiscordQuest(form: AdminQuestInput) {
  return (
    form.platform === "discord" ||
    form.actionType === "join_discord" ||
    form.verificationType === "discord_guild_member"
  );
}

function isShareReferralXQuest(form: AdminQuestInput) {
  return form.actionType === "share_referral_x";
}

function isOnchainSwapForm(form: AdminQuestInput) {
  return (
    isSwapQuest(form) ||
    form.category === "onchain" ||
    form.verificationType === "swap_volume"
  );
}

function parseRulesText(value: string) {
  try {
    const parsed = value.trim() ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function getRuleTokenAddress(rules: Record<string, any>) {
  if (typeof rules.tokenAddress === "string") {
    return rules.tokenAddress;
  }

  if (Array.isArray(rules.tokenAddresses) && typeof rules.tokenAddresses[0] === "string") {
    return rules.tokenAddresses[0];
  }

  if (rules.token && typeof rules.token === "object" && typeof rules.token.address === "string") {
    return rules.token.address;
  }

  return "";
}

function getRuleTokenMatch(rules: Record<string, any>) {
  const value =
    rules.tokenMatch ||
    (rules.token && typeof rules.token === "object" ? rules.token.match : null);
  return value === "input" || value === "output" || value === "input_or_output"
    ? value
    : "input_or_output";
}

function getRuleChainValue(rules: Record<string, any>) {
  const chainIds = Array.isArray(rules.chainIds)
    ? rules.chainIds.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : typeof rules.chainId !== "undefined"
      ? [Number(rules.chainId)].filter((value) => Number.isFinite(value))
      : [];

  return chainIds.length === 1 ? String(chainIds[0]) : "all";
}

function getCaptureChainLabel(chainId: number) {
  return (
    SUPPORTED_SWAP_CAPTURE_CHAINS.find((chain) => chain.id === chainId)?.label ||
    `Chain ${chainId}`
  );
}

function applySwapQuestDefaults(form: AdminQuestInput): AdminQuestInput {
  return {
    ...form,
    category: "onchain",
    platform: "dustswap",
    verificationType: "swap_volume",
    ctaLabel: form.ctaLabel || "Open Swap",
    ctaUrl: form.ctaUrl || "/swap",
  };
}

function applyDiscordQuestDefaults(form: AdminQuestInput): AdminQuestInput {
  return {
    ...form,
    category: "social",
    platform: "discord",
    actionType: "join_discord",
    verificationType: "discord_guild_member",
    targetValue: form.targetValue || 1,
    ctaLabel: form.ctaLabel || "Join Discord",
    ctaUrl: form.ctaUrl || "",
  };
}

function applyShareReferralXQuestDefaults(form: AdminQuestInput): AdminQuestInput {
  return {
    ...form,
    category: "social",
    platform: "x",
    actionType: "share_referral_x",
    verificationType: "x_post_link",
    progressWindow: "once",
    targetValue: form.targetValue || 1,
    ctaLabel: form.ctaLabel || "Share on X",
  };
}

function formatSwapQuestRuleSummary(rules: Record<string, any>) {
  const chainValue = getRuleChainValue(rules) as SwapQuestChainOption;
  const tokenAddress = getRuleTokenAddress(rules);
  const tokenMatch = getRuleTokenMatch(rules);
  const chainLabel =
    chainValue === "all"
      ? "All captured chains"
      : getCaptureChainLabel(Number(chainValue));
  const tokenLabel = tokenAddress
    ? `${tokenAddress} (${tokenMatch.replace(/_/g, " ")})`
    : "All tokens";

  return { chainLabel, tokenLabel };
}

const EMPTY_FORM: AdminQuestInput = {
  slug: "",
  title: "",
  description: "",
  campaignKey: "general",
  category: "social",
  platform: "x",
  actionType: "post",
  verificationType: "x_post_link",
  progressWindow: "once",
  rewardKind: "particle_points",
  rewardPoints: 0,
  targetValue: 1,
  ctaLabel: "",
  ctaUrl: "",
  status: "draft",
  isActive: true,
  sortOrder: 0,
  startsAt: null,
  endsAt: null,
  rules: {},
};

function getRulesExample(form: AdminQuestInput) {
  if (isShareReferralXQuest(form)) {
    return `{
  "requiredAnyOf": ["@DustswapOnBase"]
}`;
  }

  if (isDiscordQuest(form)) {
    return `{
  "source": "discord_guild_member"
}`;
  }

  if (form.platform === "x" && form.actionType === "reply") {
    return `{
  "requiredAnyOf": ["@dustswaponbase", "#dustswaponbase"]
}`;
  }

  if (form.platform === "x" && form.actionType === "repost") {
    return `{
  "dailyReview": true
}`;
  }

  if (form.verificationType === "x_post_link") {
    return `{
  "requiredAnyOf": ["@dustswaponbase", "#dustswaponbase", "@akbarx402"],
  "composeText": "Just posted about @dustswaponbase #dustswaponbase"
}`;
  }

  if (form.verificationType === "delay_gate_retry") {
    return `{
  "delaySeconds": 20,
  "targetXUsername": "dustswap",
  "externalUrl": "https://x.com/dustswap"
}`;
  }

  if (form.verificationType === "delay_gate") {
    return `{
  "delaySeconds": 20,
  "externalUrl": "${form.platform === "base" ? "https://base.app/" : "https://x.com/dustswap"}"
}`;
  }

  if (isSwapQuest(form)) {
    return `{
  "source": "dustswap_swap",
  "chainIds": [1],
  "tokenAddress": "0xc18360217d8f7ab5e7c516566761ea12ce7f9d72",
  "tokenMatch": "input_or_output"
}`;
  }

  return `{
  "externalUrl": "https://example.com"
}`;
}

function getVerificationGuide(form: AdminQuestInput) {
  if (isDiscordQuest(form)) {
    return {
      recommended: "discord_guild_member",
      text: "Discord join quests: use discord_guild_member. The backend checks the connected Discord OAuth user against your server with the backend-only bot token.",
    };
  }

  if (form.actionType === "swap_volume" || form.actionType === "swap_count") {
    return {
      recommended: "swap_volume",
      text: "Swap quests: use swap_volume. The backend reads captured swap progress, so CTA URL can point to /swap.",
    };
  }

  if (form.platform === "x" && form.actionType === "follow") {
    return {
      recommended: "delay_gate",
      text: "X follow quests: use delay_gate. Set CTA URL to the X profile or follow intent, and set targetXUsername or targetXUserId in rules. Backend verifies follow with GetX after X OAuth connection.",
    };
  }

  if (form.platform === "x" && form.actionType === "reply") {
    return {
      recommended: "x_post_link",
      text: "X reply quests: use x_post_link. Set CTA URL to the parent post. User pastes their reply link, and backend verifies author, parent post, and required tags with GetX.",
    };
  }

  if (form.platform === "x" && form.actionType === "post") {
    return {
      recommended: "x_post_link",
      text: "X post quests: use x_post_link. User pastes their post link, and backend verifies the connected X user owns it and includes your required tags or links.",
    };
  }

  if (form.platform === "x" && form.actionType === "share_referral_x") {
    return {
      recommended: "x_post_link",
      text: "Share Referral on X quests: use x_post_link. Store the X intent URL template in CTA URL and set requiredAnyOf to @DustswapOnBase so the backend verifies the connected X author and project mention.",
    };
  }

  if (form.platform === "x" && form.actionType === "repost") {
    return {
      recommended: "delay_gate",
      text: "X repost quests: use delay_gate. Set CTA URL to the post. Opening the CTA submits it for daily review; the 00 UTC job awards pending rows.",
    };
  }

  if (form.verificationType === "delay_gate_retry") {
    return {
      recommended: "delay_gate_retry",
      text: "Use delay_gate_retry only when you intentionally want the old retry-style visit flow.",
    };
  }

  return {
    recommended: "delay_gate",
    text: "Visit or like tasks: use delay_gate. Set CTA URL to the destination users should open.",
  };
}

function getVerificationOptionLabel(option: string) {
  const labels: Record<string, string> = {
    swap_volume: "swap_volume - swap progress",
    x_post_link: "x_post_link - post or reply link",
    discord_guild_member: "discord_guild_member - Discord server member",
    delay_gate: "delay_gate - open CTA / follow / repost",
    delay_gate_retry: "delay_gate_retry - retry visit flow",
  };

  return labels[option] || option;
}

function HelpLabel({
  label,
  help,
  example,
}: {
  label: string;
  help: string;
  example?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          aria-expanded={isOpen}
          aria-label={`${label} help`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-[11px] font-bold text-sky-700 transition hover:bg-sky-100"
        >
          !
        </button>
      </div>
      {isOpen ? (
        <div className="mt-2 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-3 text-xs leading-6 text-sky-800">
          <p>{help}</p>
          {example ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-2xl border border-gray-200 bg-white px-3 py-3 text-[11px] leading-5 text-slate-800 dark:text-sky-100">
              {example}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AdminQuestsPage() {
  const [adminToken, setAdminToken] = useState("");
  const [quests, setQuests] = useState<any[]>([]);
  const [cofounderWhitelist, setCofounderWhitelist] = useState<any[]>([]);
  const [form, setForm] = useState<AdminQuestInput>(EMPTY_FORM);
  const [rulesText, setRulesText] = useState("{}");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const rulesExample = getRulesExample(form);
  const verificationGuide = getVerificationGuide(form);
  const parsedRules = parseRulesText(rulesText);
  const chainRuleValue = getRuleChainValue(parsedRules);
  const tokenRuleAddress = getRuleTokenAddress(parsedRules);
  const tokenRuleMatch = getRuleTokenMatch(parsedRules);

  function updateRulesText(patch: Record<string, any>) {
    const nextRules = {
      ...parseRulesText(rulesText),
      ...patch,
    };

    for (const [key, value] of Object.entries(nextRules)) {
      if (
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete nextRules[key];
      }
    }

    setRulesText(JSON.stringify(nextRules, null, 2));
  }

  async function loadCampaignWhitelist(tokenOverride?: string) {
    const tokenToUse = tokenOverride || adminToken;
    if (!tokenToUse) {
      return;
    }

    const response = await fetchAdminCampaignWhitelist(
      tokenToUse,
      "cofounder_pass"
    );

    if (!response.success) {
      throw new Error(response.error || "Failed to load coFounder pass whitelist");
    }

    setCofounderWhitelist(response.data || []);
  }

  async function loadQuests(tokenOverride?: string) {
    const tokenToUse = tokenOverride || adminToken;
    if (!tokenToUse) {
      return;
    }

    setIsLoading(true);
    setError(null);
    setStatus(null);

    try {
      const response = await fetchAdminQuests(tokenToUse);
      if (!response.success) {
        throw new Error(response.error || "Failed to load quests");
      }

      setQuests(response.data || []);
      await loadCampaignWhitelist(tokenToUse);
      setIsUnlocked(true);
      setStatus("Quest admin unlocked.");
    } catch (loadError) {
      setIsUnlocked(false);
      setQuests([]);
      setCofounderWhitelist([]);
      setError(getDisplayError(loadError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const saved = window.sessionStorage.getItem("quest-admin-token");
    if (saved) {
      setAdminToken(saved);
      void loadQuests(saved);
    }
  }, []);

  useEffect(() => {
    if (adminToken) {
      window.sessionStorage.setItem("quest-admin-token", adminToken);
      return;
    }

    window.sessionStorage.removeItem("quest-admin-token");
    setIsUnlocked(false);
    setQuests([]);
    setCofounderWhitelist([]);
  }, [adminToken]);

  async function handleSave() {
    if (!adminToken || !isUnlocked) {
      setError("Load quests with a valid admin token first.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const parsedRules = rulesText.trim() ? JSON.parse(rulesText) : {};
      let normalizedForm = form;
      if (isSwapQuest(form)) {
        normalizedForm = applySwapQuestDefaults(form);
      } else if (isDiscordQuest(form)) {
        normalizedForm = applyDiscordQuestDefaults(form);
      } else if (isShareReferralXQuest(form)) {
        normalizedForm = applyShareReferralXQuestDefaults(form);
      }

      const response = await saveAdminQuest(adminToken, {
        ...normalizedForm,
        rewardPoints: Number(normalizedForm.rewardPoints || 0),
        targetValue: Number(normalizedForm.targetValue || 1),
        sortOrder: Number(normalizedForm.sortOrder || 0),
        rules: parsedRules,
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to save quest");
      }

      setStatus("Quest saved.");
      setForm(EMPTY_FORM);
      setRulesText("{}");
      await loadQuests();
    } catch (saveError) {
      setError(getDisplayError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!adminToken || !isUnlocked) {
      setError("Load quests with a valid admin token first.");
      return;
    }

    if (!window.confirm("Delete this quest?")) {
      return;
    }

    try {
      const response = await deleteAdminQuest(adminToken, id);
      if (!response.success) {
        throw new Error(response.error || "Failed to delete quest");
      }

      setStatus("Quest deleted.");
      await loadQuests();
    } catch (deleteError) {
      setError(getDisplayError(deleteError));
    }
  }

  function startEdit(quest: any) {
    setForm({
      id: quest.id,
      slug: quest.slug,
      title: quest.title,
      description: quest.description,
      campaignKey: quest.campaign_key || "general",
      category: quest.category,
      platform: quest.platform,
      actionType: quest.action_type,
      verificationType: quest.verification_type,
      progressWindow: quest.progress_window,
      rewardKind: quest.reward_kind,
      rewardPoints: quest.reward_points,
      targetValue: quest.target_value,
      ctaLabel: quest.cta_label,
      ctaUrl: quest.cta_url,
      status: quest.status,
      isActive: quest.is_active,
      sortOrder: quest.sort_order,
      startsAt: quest.starts_at,
      endsAt: quest.ends_at,
      rules: quest.rules || {},
    });
    setRulesText(JSON.stringify(quest.rules || {}, null, 2));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="theme-page mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6">
      <section className="rounded-[28px] border border-gray-200 bg-white shadow-sm p-5 sm:p-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-600">
          Quest Admin
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-gray-900">Manage quest definitions</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-600">
          Edit points, rules, quest type, timing, and publish state without touching code.
          Swap quests can target all captured chains, one captured chain, all tokens, or one token contract.
        </p>
      </section>

      <section className="rounded-[28px] border border-gray-200 bg-white shadow-sm p-5">
        <label className="block text-sm font-medium text-gray-900">Admin token</label>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          This first admin version uses{" "}
          <code className="rounded bg-sky-50 border border-sky-100 px-1.5 py-0.5 text-xs text-sky-700">
            QUEST_ADMIN_TOKEN
          </code>{" "}
          from the API env on Railway. Paste the same value here, then tap Load Quests.
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            value={adminToken}
            onChange={(event) => {
              setAdminToken(event.target.value);
              setIsUnlocked(false);
            }}
            placeholder="Paste QUEST_ADMIN_TOKEN"
            className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm placeholder:text-gray-500"
          />
          <button
            type="button"
            onClick={() => void loadQuests()}
            disabled={!adminToken || isLoading}
            className="rounded-2xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-sky-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load Quests"}
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-500">
          The full create, edit, and delete UI stays hidden until the API accepts the token.
        </p>
      </section>

      {status ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {status}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {!isUnlocked ? (
        <section className="rounded-[28px] border border-dashed border-gray-200 bg-gray-50 p-6 text-sm leading-7 text-gray-600">
          Enter a valid admin token and tap <span className="font-semibold text-gray-900">Load Quests</span> to unlock the quest manager.
          If it still fails, check that <code>NEXT_PUBLIC_API_URL</code> on Vercel points to the Railway root URL without <code>/api</code>, and make sure the same token is set in Railway API env.
        </section>
      ) : (
        <>
          <AdminManualPointsPanel adminToken={adminToken} />

          <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <section className="rounded-[28px] border border-gray-200 bg-white shadow-sm p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">
                {form.id ? "Edit Quest" : "Create Quest"}
              </h2>
              {form.id ? (
                <button
                  type="button"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setRulesText("{}");
                  }}
                  className="text-sm font-medium text-sky-600 hover:text-sky-700"
                >
                  Clear
                </button>
              ) : null}
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {[
                { key: "slug", label: "Slug", help: "Unique id for the quest. Keep it stable once users start progressing." },
                { key: "title", label: "Title", help: "Short headline users see on the quest card." },
                { key: "description", label: "Description", help: "Explain clearly what the user needs to do to complete the quest." },
                { key: "ctaLabel", label: "CTA label", help: "Button text on the quest card, like Open Swap or Add X Username First." },
                { key: "ctaUrl", label: "CTA URL", help: "Main link opened by the quest button. For X and Base tasks this should usually be the exact post, profile, or app page the user needs." },
              ].map((field) => (
                <label
                  key={field.key}
                  className={field.key === "description" ? "sm:col-span-2" : ""}
                >
                  <HelpLabel label={field.label} help={field.help} />
                  <input
                    value={String((form as any)[field.key] || "")}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm placeholder:text-gray-500"
                  />
                </label>
              ))}

              <div className="sm:col-span-2 rounded-2xl border border-sky-100 bg-sky-50/70 px-4 py-3 text-xs leading-6 text-sky-900">
                <p>
                  <span className="font-semibold">Recommended verification:</span>{" "}
                  <code>{verificationGuide.recommended}</code>
                </p>
                <p className="mt-1">{verificationGuide.text}</p>
              </div>

              {[
                {
                  key: "campaignKey",
                  label: "Quest field",
                  help: "Choose where this quest lives on the quest page. General keeps it in the normal Social or Onchain tabs. coFounder pass puts it in the limited-time pass tab.",
                  options: ["general", "cofounder_pass"],
                },
                {
                  key: "category",
                  label: "Category",
                  help: "Choose social for X or Base App actions, and onchain for swap-based progress.",
                  options: ["social", "onchain"],
                },
                {
                  key: "platform",
                  label: "Platform",
                  help: "Main place where the task happens, such as X, Discord, Base App, or DustSwap.",
                  options: ["x", "discord", "base", "dustswap"],
                },
                {
                  key: "actionType",
                  label: "Action",
                  help: "The exact task users perform, like swap volume, follow, like, repost, reply, post, or visit.",
                  options: [
                    "swap_volume",
                    "swap_count",
                    "join_discord",
                    "like",
                    "post",
                    "share_referral_x",
                    "follow",
                    "repost",
                    "reply",
                    "visit",
                  ],
                },
                {
                  key: "verificationType",
                  label: "Verification",
                  help: "Defines how the backend confirms completion. swap_volume reads swap progress. x_post_link verifies pasted post or reply links with GetX. discord_guild_member checks Discord server membership with the backend bot token.",
                  options: ["swap_volume", "x_post_link", "discord_guild_member", "delay_gate", "delay_gate_retry"],
                },
                {
                  key: "progressWindow",
                  label: "Window",
                  help: "Once is a one-time quest and disappears after completion. Daily resets every day at 00:00 UTC. Weekly resets every Monday-based week at 00:00 UTC.",
                  options: ["once", "daily", "weekly"],
                },
                {
                  key: "status",
                  label: "Status",
                  help: "Draft keeps it hidden. Published makes it eligible to appear if active and inside the time window.",
                  options: ["draft", "published"],
                },
              ].map((field) => (
                <label key={field.key}>
                  <HelpLabel label={field.label} help={field.help} />
                  <select
                    value={String((form as any)[field.key] || field.options[0])}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setForm((current) => {
                        const next = {
                          ...current,
                          [field.key]: nextValue,
                        };

                        if (
                          field.key === "actionType" &&
                          (nextValue === "swap_volume" || nextValue === "swap_count")
                        ) {
                          return applySwapQuestDefaults(next as AdminQuestInput);
                        }

                        if (
                          field.key === "actionType" &&
                          nextValue === "share_referral_x"
                        ) {
                          return applyShareReferralXQuestDefaults(
                            next as AdminQuestInput
                          );
                        }

                        if (
                          (field.key === "platform" && nextValue === "discord") ||
                          (field.key === "actionType" && nextValue === "join_discord") ||
                          (field.key === "verificationType" &&
                            nextValue === "discord_guild_member")
                        ) {
                          return applyDiscordQuestDefaults(next as AdminQuestInput);
                        }

                        if (field.key === "category" && nextValue === "onchain") {
                          return applySwapQuestDefaults({
                            ...(next as AdminQuestInput),
                            actionType: isSwapQuest(next as AdminQuestInput)
                              ? (next.actionType as AdminQuestInput["actionType"])
                              : "swap_volume",
                          });
                        }

                        if (field.key === "verificationType" && nextValue === "swap_volume") {
                          return applySwapQuestDefaults({
                            ...(next as AdminQuestInput),
                            actionType: isSwapQuest(next as AdminQuestInput)
                              ? (next.actionType as AdminQuestInput["actionType"])
                              : "swap_volume",
                          });
                        }

                        return next as AdminQuestInput;
                      });

                      if (
                        field.key === "actionType" &&
                        nextValue === "share_referral_x"
                      ) {
                        updateRulesText({ requiredAnyOf: ["@DustswapOnBase"] });
                      }
                    }}
                    className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                  >
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {field.key === "verificationType"
                          ? getVerificationOptionLabel(option)
                          : option}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

              {[
                {
                  key: "rewardPoints",
                  label: "Particle points",
                  help: "How many Particle Points the user gets when this quest completes.",
                },
                {
                  key: "targetValue",
                  label: "Target value",
                  help: "Use the goal number here. Example: 10 means $10 for swap_volume, 10 swaps for swap_count, and 1 for most social quests.",
                },
                {
                  key: "sortOrder",
                  label: "Sort order",
                  help: "Controls display order on the quest page. Lower numbers show first, so 10 appears before 100.",
                },
              ].map((field) => (
                <label key={field.key}>
                  <HelpLabel label={field.label} help={field.help} />
                  <input
                    type="number"
                    value={String((form as any)[field.key] ?? 0)}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        [field.key]: Number(event.target.value),
                      }))
                    }
                    className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                  />
                </label>
              ))}

              <label>
                <HelpLabel
                  label="Starts at (UTC)"
                  help="Optional UTC opening time. Leave empty if the quest should start immediately when published."
                />
                <input
                  type="datetime-local"
                  value={toDateTimeLocalValue(form.startsAt)}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      startsAt: toIsoOrNull(event.target.value),
                    }))
                  }
                  className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </label>

              <label>
                <HelpLabel
                  label="Ends at (UTC)"
                  help="Optional UTC closing time. Leave empty if the quest should stay open until you turn it off."
                />
                <input
                  type="datetime-local"
                  value={toDateTimeLocalValue(form.endsAt)}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      endsAt: toIsoOrNull(event.target.value),
                    }))
                  }
                  className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </label>

              <div>
                <HelpLabel
                  label="Active quest"
                  help="Turn this off to hide the quest without deleting it. The normal live setup is status = published and Active quest = on."
                />
                <label className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900">
                  <input
                    type="checkbox"
                    checked={Boolean(form.isActive)}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        isActive: event.target.checked,
                      }))
                    }
                  />
                  <span>{form.isActive ? "Quest is live-ready" : "Quest is hidden"}</span>
                </label>
              </div>
            </div>

            <div className="mt-4 grid gap-3 rounded-2xl border border-gray-200 bg-white p-4 text-xs leading-6 text-gray-600 sm:grid-cols-2">
              <p>
                <span className="font-semibold text-gray-900">Target value:</span> use USD amount for{" "}
                <code>swap_volume</code>, number of swaps for <code>swap_count</code>, and usually{" "}
                <code>1</code> for social tasks.
              </p>
              <p>
                <span className="font-semibold text-gray-900">Sort order:</span> lower numbers appear first on the quest page.
                Example: <code>10</code> shows before <code>100</code>.
              </p>
            </div>

            {isOnchainSwapForm(form) ? (
              <div className="mt-4 grid gap-4 rounded-2xl border border-sky-100 bg-sky-50/40 p-4 sm:grid-cols-3">
                <label>
                  <HelpLabel
                    label="Captured chain"
                    help="All captured chains is the default. Pick one of the top 10 capture chains only when this quest should count swaps from that chain."
                  />
                  <select
                    value={chainRuleValue}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateRulesText(
                        value === "all"
                          ? { chainId: undefined, chainIds: undefined }
                          : { chainId: undefined, chainIds: [Number(value)] }
                      );
                    }}
                    className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                  >
                    <option value="all">All captured chains</option>
                    {SUPPORTED_SWAP_CAPTURE_CHAINS.map((chain) => (
                      <option key={chain.id} value={chain.id}>
                        {chain.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <HelpLabel
                    label="Token contract"
                    help="Leave blank for all tokens. Paste a token contract to count only swaps where that token matches the selected side."
                  />
                  <input
                    value={tokenRuleAddress}
                    onChange={(event) =>
                      updateRulesText({
                        tokenAddress: event.target.value.trim() || undefined,
                      })
                    }
                    placeholder="All tokens"
                    className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm placeholder:text-gray-500"
                  />
                </label>

                <label>
                  <HelpLabel
                    label="Token match"
                    help="Input or output means the token can be on either side of the swap. Use input-only or output-only for stricter tasks."
                  />
                  <select
                    value={tokenRuleMatch}
                    onChange={(event) =>
                      updateRulesText({
                        tokenMatch: event.target.value,
                      })
                    }
                    className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                  >
                    <option value="input_or_output">Input or output</option>
                    <option value="input">Input only</option>
                    <option value="output">Output only</option>
                  </select>
                </label>
              </div>
            ) : null}

            <label className="mt-4 block">
              <HelpLabel
                label="Rules JSON"
                help="Advanced per-quest config. Onchain swap quests default to all chains and all tokens unless chainIds or tokenAddress are set. The example below changes automatically based on the current quest type."
                example={rulesExample}
              />
              <textarea
                value={rulesText}
                onChange={(event) => setRulesText(event.target.value)}
                rows={12}
                className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm placeholder:text-gray-500"
              />
            </label>

            <div className="mt-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-xs leading-6 text-gray-600">
              <p className="font-semibold text-gray-900">Quick rules guide</p>
              <p className="mt-1">
                <code>delaySeconds</code> controls the wait time before verify.
                <code className="ml-1">targetXUserId</code> or <code>targetXUsername</code> identifies the account for GetX follow checks.
                <code className="ml-1">Reply tasks</code> use the CTA URL as the parent post and verify the pasted reply link.
                <code className="ml-1">Repost tasks</code> use the CTA URL and move opened tasks into daily review.
                <code className="ml-1">Discord join tasks</code> use <code>discord_guild_member</code> and never require bot secrets in admin.
                <code className="ml-1">requiredAnyOf</code> means the post only needs one of those allowed X mentions or hashtags.
                <code className="ml-1">x_post_link</code> also checks that the tweet author ID matches the connected X account.
                <code className="ml-1">share_referral_x</code> uses <code>x_post_link</code> and verifies the connected X author plus <code>@DustswapOnBase</code>.
                <code className="ml-1">externalUrl</code> is the page users open.
                <code className="ml-1">source</code> is used for onchain swap tracking.
                <code className="ml-1">chainIds</code>, <code>tokenAddress</code>, and{" "}
                <code>tokenMatch</code> narrow swap quests when needed.
              </p>
            </div>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!adminToken || isSaving}
              className="mt-5 w-full rounded-2xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-sky-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? "Saving..." : form.id ? "Update Quest" : "Create Quest"}
            </button>
            </section>

            <section className="rounded-[28px] border border-gray-200 bg-white shadow-sm p-5">
              <h2 className="text-lg font-semibold text-gray-900">Current quests</h2>
              <div className="mt-4 space-y-3">
                {quests.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
                    No quests found yet.
                  </div>
                ) : (
                  quests.map((quest) => {
                    const isQuestSwap =
                      quest.action_type === "swap_volume" || quest.action_type === "swap_count";
                    const swapRuleSummary = isQuestSwap
                      ? formatSwapQuestRuleSummary(quest.rules || {})
                      : null;

                    return (
                    <article
                      key={quest.id}
                      className="rounded-2xl border border-gray-200 bg-white p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.25em] text-gray-500">
                            {quest.platform} / {quest.action_type}
                          </p>
                          <h3 className="mt-2 text-base font-semibold text-gray-900">{quest.title}</h3>
                          <p className="mt-1 text-xs text-gray-500">
                            {quest.slug} / {quest.reward_points} PP
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            Field {quest.campaign_key || "general"}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            Target {quest.target_value} / Sort {quest.sort_order}
                          </p>
                          {swapRuleSummary ? (
                            <div className="mt-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
                              <p>Chain: {swapRuleSummary.chainLabel}</p>
                              <p>Token: {swapRuleSummary.tokenLabel}</p>
                            </div>
                          ) : null}
                          {quest.starts_at ? (
                            <p className="mt-1 text-xs text-gray-500">
                              Opens {formatAdminQuestInstant(quest.starts_at)}
                            </p>
                          ) : null}
                          {quest.ends_at ? (
                            <p className="mt-1 text-xs text-gray-500">
                              Closes {formatAdminQuestInstant(quest.ends_at)}
                            </p>
                          ) : null}
                        </div>
                        <span
                          className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.22em] ${
                            quest.status === "published"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-gray-200 bg-gray-100 text-gray-600"
                          }`}
                        >
                          {quest.status}
                        </span>
                      </div>

                      <div className="mt-4 flex gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(quest)}
                          className="rounded-2xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-900 transition hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(quest.id)}
                          className="rounded-2xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 bg-white"
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                    );
                  })
                )}
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-base font-semibold text-gray-900">coFounder pass whitelist</h3>
                  <button
                    type="button"
                    onClick={() => void loadQuests()}
                    disabled={!adminToken || isLoading}
                    className="rounded-2xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-900 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>
                <p className="mt-2 text-xs leading-6 text-gray-500">
                  Wallets are saved here permanently once they complete every live coFounder pass quest. If you add new pass tasks later, the quest-page message can disappear, but these whitelist addresses stay in the database.
                </p>
                <div className="mt-3 space-y-2">
                  {cofounderWhitelist.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-4 text-sm text-gray-500">
                      No wallets have been whitelisted yet.
                    </div>
                  ) : (
                    cofounderWhitelist.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-2xl border border-gray-200 bg-white px-4 py-3"
                      >
                        <p className="text-sm font-medium text-gray-900">{entry.wallet_address}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          Added {new Date(entry.created_at).toLocaleString()}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
