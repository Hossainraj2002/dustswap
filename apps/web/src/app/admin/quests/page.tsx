"use client";

import { useEffect, useState } from "react";
import {
  deleteAdminQuest,
  fetchAdminQuests,
  saveAdminQuest,
} from "@/lib/quests";
import type { AdminQuestInput } from "@/types/quests";

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
  rules: {},
};

export default function AdminQuestsPage() {
  const [adminToken, setAdminToken] = useState("");
  const [quests, setQuests] = useState<any[]>([]);
  const [form, setForm] = useState<AdminQuestInput>(EMPTY_FORM);
  const [rulesText, setRulesText] = useState("{}");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const saved = window.sessionStorage.getItem("quest-admin-token");
    if (saved) {
      setAdminToken(saved);
    }
  }, []);

  useEffect(() => {
    if (adminToken) {
      window.sessionStorage.setItem("quest-admin-token", adminToken);
    }
  }, [adminToken]);

  async function loadQuests() {
    if (!adminToken) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchAdminQuests(adminToken);
      if (!response.success) {
        throw new Error(response.error || "Failed to load quests");
      }

      setQuests(response.data || []);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
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
      setError((saveError as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
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
      setError((deleteError as Error).message);
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
          Edit points, rules, quest type, and publish state without touching code.
        </p>
      </section>

      <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
        <label className="block text-sm font-medium text-white">Admin token</label>
        <p className="mt-2 text-sm leading-6 text-gray-300">
          This first admin version uses <code className="rounded bg-black/30 px-1.5 py-0.5 text-xs text-sky-100">QUEST_ADMIN_TOKEN</code>{" "}
          from the API env. Paste the same value here to manage quests.
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
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
          We can replace this with wallet-whitelist auth later so you do not need to share a raw token.
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
              { key: "slug", label: "Slug" },
              { key: "title", label: "Title" },
              { key: "description", label: "Description" },
              { key: "ctaLabel", label: "CTA label" },
              { key: "ctaUrl", label: "CTA URL" },
            ].map((field) => (
              <label
                key={field.key}
                className={field.key === "description" ? "sm:col-span-2" : ""}
              >
                <span className="mb-2 block text-sm font-medium text-white">{field.label}</span>
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
                options: ["social", "onchain"],
              },
              {
                key: "platform",
                label: "Platform",
                options: ["x", "base", "dustswap"],
              },
              {
                key: "actionType",
                label: "Action",
                options: ["swap_volume", "post", "follow", "repost", "reply", "visit"],
              },
              {
                key: "verificationType",
                label: "Verification",
                options: ["swap_volume", "x_post_link", "delay_gate", "delay_gate_retry"],
              },
              {
                key: "progressWindow",
                label: "Window",
                options: ["once", "daily", "weekly"],
              },
              {
                key: "status",
                label: "Status",
                options: ["draft", "published"],
              },
            ].map((field) => (
              <label key={field.key}>
                <span className="mb-2 block text-sm font-medium text-white">{field.label}</span>
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
              { key: "rewardPoints", label: "Particle points" },
              { key: "targetValue", label: "Target value" },
              { key: "sortOrder", label: "Sort order" },
            ].map((field) => (
              <label key={field.key}>
                <span className="mb-2 block text-sm font-medium text-white">{field.label}</span>
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
              Active quest
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-2 block text-sm font-medium text-white">Rules JSON</span>
            <textarea
              value={rulesText}
              onChange={(event) => setRulesText(event.target.value)}
              rows={12}
              className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500"
            />
          </label>

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
                Load quests to manage them here.
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
                        {quest.platform} · {quest.action_type}
                      </p>
                      <h3 className="mt-2 text-base font-semibold text-white">{quest.title}</h3>
                      <p className="mt-1 text-xs text-gray-400">
                        {quest.slug} · {quest.reward_points} PP
                      </p>
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
    </div>
  );
}
