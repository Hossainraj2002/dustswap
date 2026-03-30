"use client";

import { useEffect, useState } from "react";
import {
  deleteAdminQuest,
  fetchAdminQuests,
  saveAdminQuest,
} from "@/lib/quests";
import type { AdminQuestInput } from "@/types/quests";

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the quest API. Check NEXT_PUBLIC_API_URL on Vercel and make sure it uses the Railway root URL without /api.";
  }
  return message;
}

function toDateTimeLocalValue(value?: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function toIsoOrNull(value: string) {
  return value ? new Date(value).toISOString() : null;
}

const EMPTY_FORM: AdminQuestInput = {
  slug: "",
  title: "",
  description: "",
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
  if (form.verificationType === "x_post_link") {
    return `{
  "requiredMention": "@dustswap",
  "requiredHashtags": ["#DustSwap"],
  "requiredLinks": ["dustswap.xyz"],
  "composeText": "Cleaning my wallet with @dustswap #DustSwap https://dustswap.xyz"
}`;
  }

  if (form.verificationType === "delay_gate_retry") {
    return `{
  "delaySeconds": 20,
  "fakeFailureCount": 1,
  "externalUrl": "https://x.com/dustswap"
}`;
  }

  if (form.verificationType === "delay_gate") {
    return `{
  "delaySeconds": 20,
  "externalUrl": "${form.platform === "base" ? "https://base.app/" : "https://x.com/dustswap"}"
}`;
  }

  if (form.actionType === "swap_volume" || form.actionType === "swap_count") {
    return `{
  "source": "dustswap_swap"
}`;
  }

  return `{
  "externalUrl": "https://example.com"
}`;
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
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          aria-expanded={isOpen}
          aria-label={`${label} help`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-sky-300/30 bg-sky-400/10 text-[11px] font-bold text-sky-100 transition hover:bg-sky-400/20"
        >
          !
        </button>
      </div>
      {isOpen ? (
        <div className="mt-2 rounded-2xl border border-sky-300/20 bg-sky-400/10 px-3 py-3 text-xs leading-6 text-sky-50/90">
          <p>{help}</p>
          {example ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-[11px] leading-5 text-sky-100">
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
  const [form, setForm] = useState<AdminQuestInput>(EMPTY_FORM);
  const [rulesText, setRulesText] = useState("{}");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const rulesExample = getRulesExample(form);

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
      setIsUnlocked(true);
      setStatus("Quest admin unlocked.");
    } catch (loadError) {
      setIsUnlocked(false);
      setQuests([]);
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
      const response = await saveAdminQuest(adminToken, {
        ...form,
        rewardPoints: Number(form.rewardPoints || 0),
        targetValue: Number(form.targetValue || 1),
        sortOrder: Number(form.sortOrder || 0),
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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6">
      <section className="rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(13,18,31,0.96),rgba(6,9,16,0.96))] p-5 sm:p-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-200/70">
          Quest Admin
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-white">Manage quest definitions</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-300">
          Edit points, rules, quest type, timing, and publish state without touching code.
        </p>
      </section>

      <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
        <label className="block text-sm font-medium text-white">Admin token</label>
        <p className="mt-2 text-sm leading-6 text-gray-300">
          This first admin version uses{" "}
          <code className="rounded bg-black/30 px-1.5 py-0.5 text-xs text-sky-100">
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
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500"
          />
          <button
            type="button"
            onClick={() => void loadQuests()}
            disabled={!adminToken || isLoading}
            className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-[#030305] transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load Quests"}
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-400">
          The full create, edit, and delete UI stays hidden until the API accepts the token.
        </p>
      </section>

      {status ? (
        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {status}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      {!isUnlocked ? (
        <section className="rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] p-6 text-sm leading-7 text-gray-300">
          Enter a valid admin token and tap <span className="font-semibold text-white">Load Quests</span> to unlock the quest manager.
          If it still fails, check that <code>NEXT_PUBLIC_API_URL</code> on Vercel points to the Railway root URL without <code>/api</code>, and make sure the same token is set in Railway API env.
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">
                {form.id ? "Edit Quest" : "Create Quest"}
              </h2>
              {form.id ? (
                <button
                  type="button"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setRulesText("{}");
                  }}
                  className="text-sm font-medium text-sky-200"
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
                { key: "ctaLabel", label: "CTA label", help: "Button text on the quest card, like Open Swap or Connect X First." },
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
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500"
                  />
                </label>
              ))}

              {[
                {
                  key: "category",
                  label: "Category",
                  help: "Choose social for X or Base App actions, and onchain for swap-based progress.",
                  options: ["social", "onchain"],
                },
                {
                  key: "platform",
                  label: "Platform",
                  help: "Main place where the task happens, such as X, Base App, or DustSwap.",
                  options: ["x", "base", "dustswap"],
                },
                {
                  key: "actionType",
                  label: "Action",
                  help: "The exact task users perform, like swap volume, follow, repost, or visit.",
                  options: [
                    "swap_volume",
                    "swap_count",
                    "post",
                    "follow",
                    "repost",
                    "reply",
                    "visit",
                  ],
                },
                {
                  key: "verificationType",
                  label: "Verification",
                  help: "Defines how the backend confirms completion. swap_volume reads swap progress, x_post_link checks a pasted tweet URL, delay_gate waits 20 seconds, and delay_gate_retry adds the fake first failure behavior.",
                  options: ["swap_volume", "x_post_link", "delay_gate", "delay_gate_retry"],
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
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none"
                  >
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
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
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none"
                  />
                </label>
              ))}

              <label>
                <HelpLabel
                  label="Starts at"
                  help="Optional opening time. Leave empty if the quest should start immediately when published."
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
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none"
                />
              </label>

              <label>
                <HelpLabel
                  label="Ends at"
                  help="Optional closing time. Leave empty if the quest should stay open until you turn it off."
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
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none"
                />
              </label>

              <div>
                <HelpLabel
                  label="Active quest"
                  help="Turn this off to hide the quest without deleting it. The normal live setup is status = published and Active quest = on."
                />
                <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white">
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

            <div className="mt-4 grid gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-xs leading-6 text-gray-300 sm:grid-cols-2">
              <p>
                <span className="font-semibold text-white">Target value:</span> use USD amount for{" "}
                <code>swap_volume</code>, number of swaps for <code>swap_count</code>, and usually{" "}
                <code>1</code> for social tasks.
              </p>
              <p>
                <span className="font-semibold text-white">Sort order:</span> lower numbers appear first on the quest page.
                Example: <code>10</code> shows before <code>100</code>.
              </p>
            </div>

            <label className="mt-4 block">
              <HelpLabel
                label="Rules JSON"
                help="Advanced per-quest config. Use this for delay seconds, fake failure count, required hashtags, required links, compose text, source filters, or external URLs. The example below changes automatically based on the current quest type."
                example={rulesExample}
              />
              <textarea
                value={rulesText}
                onChange={(event) => setRulesText(event.target.value)}
                rows={12}
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500"
              />
            </label>

            <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-xs leading-6 text-gray-300">
              <p className="font-semibold text-white">Quick rules guide</p>
              <p className="mt-1">
                <code>delaySeconds</code> controls the wait time before verify.
                <code className="ml-1">fakeFailureCount</code> is only for the follow-style fake first failure.
                <code className="ml-1">externalUrl</code> is the page users open.
                <code className="ml-1">source</code> is used for onchain swap tracking.
              </p>
            </div>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!adminToken || isSaving}
              className="mt-5 w-full rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-[#030305] transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? "Saving..." : form.id ? "Update Quest" : "Create Quest"}
            </button>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
            <h2 className="text-lg font-semibold text-white">Current quests</h2>
            <div className="mt-4 space-y-3">
              {quests.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-6 text-sm text-gray-400">
                  No quests found yet.
                </div>
              ) : (
                quests.map((quest) => (
                  <article
                    key={quest.id}
                    className="rounded-2xl border border-white/10 bg-black/20 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.25em] text-gray-500">
                          {quest.platform} / {quest.action_type}
                        </p>
                        <h3 className="mt-2 text-base font-semibold text-white">{quest.title}</h3>
                        <p className="mt-1 text-xs text-gray-400">
                          {quest.slug} / {quest.reward_points} PP
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Target {quest.target_value} / Sort {quest.sort_order}
                        </p>
                        {quest.starts_at ? (
                          <p className="mt-1 text-xs text-gray-500">
                            Opens {new Date(quest.starts_at).toLocaleString()}
                          </p>
                        ) : null}
                        {quest.ends_at ? (
                          <p className="mt-1 text-xs text-gray-500">
                            Closes {new Date(quest.ends_at).toLocaleString()}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.22em] ${
                          quest.status === "published"
                            ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                            : "border-white/10 bg-white/5 text-gray-300"
                        }`}
                      >
                        {quest.status}
                      </span>
                    </div>

                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(quest)}
                        className="rounded-2xl border border-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(quest.id)}
                        className="rounded-2xl border border-rose-400/20 px-4 py-2 text-sm font-medium text-rose-100 transition hover:bg-rose-500/10"
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
