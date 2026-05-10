"use client";

import { useEffect, useState } from "react";

type DiscordOAuthMessage = {
  type: "dustswap:discord-oauth";
  success: boolean;
  error: string | null;
  username: string | null;
};

export default function DiscordOAuthCompletePage() {
  const [message, setMessage] = useState("Finishing Discord connection...");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("discord_linked") === "1";
    const error = params.get("discord_error");
    const username = params.get("discord_username");
    const payload: DiscordOAuthMessage = {
      type: "dustswap:discord-oauth",
      success,
      error,
      username,
    };

    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      setMessage(success ? "Discord connected. You can close this window." : "Discord connection failed. You can close this window.");
      window.setTimeout(() => window.close(), 600);
      return;
    }

    const fallbackUrl = new URL("/quests", window.location.origin);
    fallbackUrl.searchParams.set("discord_linked", success ? "1" : "0");
    if (error) {
      fallbackUrl.searchParams.set("discord_error", error);
    }
    if (username) {
      fallbackUrl.searchParams.set("discord_username", username);
    }

    window.location.replace(fallbackUrl.toString());
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-6 text-center">
      <div className="max-w-sm rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <p className="text-sm font-semibold text-slate-900">{message}</p>
      </div>
    </main>
  );
}
