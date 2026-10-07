"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { AUTHOR_SHARE_DEFAULT_BPS, prepareTweetImage, type TweetSource } from "@/lib/create/tweet";
import { useMarket } from "@/lib/market/MarketProvider";
import type { CreateDraft } from "@/lib/create/draft";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { cn } from "@/lib/cn";

export function TweetSourceCard({ source }: { source: TweetSource }) {
  return <section className="rounded-lg bg-fill-4 p-4" aria-label="Original X post">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <p className="text-headline text-label">Original post by @{source.author.handle}</p>
      <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-footnote font-semibold text-tint">View post<ExternalLink className="size-3.5" aria-hidden /></a>
    </div>
    <p className="whitespace-pre-wrap break-words text-subhead text-label">{source.text || "This post contains media."}</p>
    <p className="mt-3 text-footnote text-label-2">Importing a post does not mean its author has endorsed this coin. The author must verify their own X account and wallet to receive the reserved share.</p>
  </section>;
}

export function TweetImportPanel({ draft, update, onBusy }: { draft: CreateDraft; update: (patch: Partial<CreateDraft>) => void; onBusy?: (busy: boolean) => void }) {
  const { market } = useMarket();
  const [url, setUrl] = useState(draft.tweet?.source.url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sourceUrl = draft.tweet?.source.url;
  useEffect(() => { setUrl(sourceUrl ?? ""); }, [sourceUrl]);
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy, onBusy]);
  const imported = draft.tweet?.imported;
  const importPost = async () => {
    if (!market) return;
    setBusy(true); setError("");
    try {
      const result = await market.importTweet(url);
      const photo = result.photos[0];
      const source: TweetSource = { postId: result.postId, url: result.url, text: result.text, author: result.author, ...(photo ? { photoId: photo.id } : {}) };
      let image: string;
      let photoId = photo?.id;
      try { image = await prepareTweetImage(source, photo?.url); }
      catch { image = await prepareTweetImage(source); photoId = undefined; setError("The post image was unavailable, so a text image was prepared. You can choose another photo below."); }
      update({ entry: "tweet", tweet: { source: { ...source, photoId }, imported: result, photoId, authorShareBps: draft.tweet?.authorShareBps ?? AUTHOR_SHARE_DEFAULT_BPS },
        name: result.suggestedName, ticker: result.suggestedTicker, description: result.text.slice(0, 280), image, mode: "creator", creatorKeepBps: 0 });
      setUrl(result.url);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The public post could not be imported."); }
    finally { setBusy(false); }
  };
  const chooseImage = async (photoId?: string) => {
    if (!draft.tweet) return;
    setBusy(true); setError("");
    try {
      const photo = imported?.photos.find((entry) => entry.id === photoId);
      const image = await prepareTweetImage(draft.tweet.source, photo?.url);
      update({ tweet: { ...draft.tweet, photoId, source: { ...draft.tweet.source, photoId } }, image });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The image could not be prepared."); }
    finally { setBusy(false); }
  };
  return <div className="mb-6 flex flex-col gap-4">
    <TextField label="Public X post link" value={url} placeholder="https://x.com/name/status/123" inputMode="url" autoComplete="off" onChange={(event) => setUrl(event.target.value)} error={error || undefined} />
    <Button variant="tinted" disabled={!market || !url.trim() || busy} loading={busy} loadingLabel="Importing post" leading={<Link2 className="size-4" aria-hidden />} onClick={() => void importPost()}>{draft.tweet ? "Import another post" : "Import post"}</Button>
    <p className="text-footnote text-label-2">Public posts only. The server reads the original author and images. The suggested name and ticker remain editable.</p>
    {draft.tweet ? <>
      <TweetSourceCard source={draft.tweet.source} />
      <fieldset className="flex flex-col gap-2" disabled={busy}>
        <legend className="mb-2 text-footnote font-semibold text-label-2">Coin image</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {imported?.photos.map((photo) => <button key={photo.id} type="button" aria-pressed={draft.tweet?.photoId === photo.id} onClick={() => void chooseImage(photo.id)} className={cn("overflow-hidden rounded-lg border-2 bg-fill-4 p-1 focus-visible:outline-tint", draft.tweet?.photoId === photo.id ? "border-tint" : "border-separator")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.url} alt="Image from the source post" className="aspect-square w-full rounded-md object-cover" />
          </button>)}
          <button type="button" aria-pressed={!draft.tweet.photoId} onClick={() => void chooseImage()} className={cn("rounded-lg border-2 p-3 text-left text-subhead font-semibold text-label", !draft.tweet.photoId ? "border-tint bg-tint/8" : "border-separator bg-fill-4")}>Text image<span className="mt-1 block text-footnote font-normal text-label-2">Generated from the post, without AI credits.</span></button>
        </div>
      </fieldset>
      {market?.kind === "live" && !imported?.authorFeesSupported ? <p role="status" className="rounded-lg bg-warning/10 p-3 text-footnote text-label">The post is imported, but live author-fee launches are not configured. You can prepare the draft; launching stays unavailable.</p> : null}
    </> : null}
  </div>;
}
