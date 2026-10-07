"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { ImagePlus } from "lucide-react";
import { validateImageFile, normalizeTicker, NAME_MAX, TICKER_MAX, DESCRIPTION_MAX } from "@/core/validation";
import { cn } from "@/lib/cn";
import { useCoins } from "@/lib/market/hooks";
import { normalizeCoinImage } from "@/lib/create/image";
import type { CreateDraft, DraftErrors } from "@/lib/create/draft";
import { Button } from "@/components/ui/Button";
import { TextArea, TextField } from "@/components/ui/TextField";

interface StepProps {
  draft: CreateDraft;
  update: (patch: Partial<CreateDraft>) => void;
  errors: DraftErrors;
  showErrors: boolean;
  showImagePicker?: boolean;
}

export function CoinStep({ draft, update, errors, showErrors, showImagePicker = true }: StepProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const imageRequest = useRef(0);
  useEffect(() => () => { imageRequest.current++; }, []);
  const [imageError, setImageError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { coins } = useCoins();
  const ticker = normalizeTicker(draft.ticker);
  const tickerTaken = ticker.length >= 2 && coins.some((coin) => coin.symbol === ticker);

  const accept = async (file: File | undefined) => {
    if (!file) return;
    const request = ++imageRequest.current;
    const check = validateImageFile(file);
    if (!check.ok) {
      setProcessing(false);
      setImageError(check.error ?? "Use a different image.");
      return;
    }
    setProcessing(true);
    setImageError(null);
    try {
      const image = await normalizeCoinImage(file);
      if (request === imageRequest.current) update({ image });
    } catch (error) {
      if (request === imageRequest.current) setImageError(error instanceof Error ? error.message : "Could not read this image.");
    } finally {
      if (request === imageRequest.current) setProcessing(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void accept(event.dataTransfer.files[0]);
  };

  const shown = (key: keyof CreateDraft) => (showErrors ? errors[key] : undefined);

  return (
    <div className="flex flex-col gap-6">
      {showImagePicker ? <div className="flex flex-col gap-2">
        <span className="px-1 text-footnote font-semibold text-label-2">Image</span>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex items-center gap-4 rounded-lg border-2 border-dashed p-4 transition-colors",
            dragging ? "border-tint bg-tint/8" : "border-separator",
            shown("image") && !draft.image && "border-down",
          )}
        >
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            aria-label={draft.image ? "Change image" : "Choose an image"}
            className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-full bg-fill-3 text-label-2 transition-colors hover:bg-fill-2"
          >
            {draft.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.image} alt="" className="size-full object-cover" />
            ) : (
              <ImagePlus className="size-8" aria-hidden />
            )}
          </button>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-subhead text-label">{draft.image ? "Looks good. It will be cropped to a circle." : "Drop an image or choose one."}</p>
            <p className="text-footnote text-label-2">PNG, JPG, WebP or GIF, up to 4 MB. Square works best.</p>
            <div className="flex gap-2">
              <Button size="sm" variant="gray" loading={processing} loadingLabel="Preparing" onClick={() => fileInput.current?.click()}>
                {draft.image ? "Change" : "Choose image"}
              </Button>
              {draft.image ? (
                <Button size="sm" variant="plain" onClick={() => {
                  imageRequest.current++;
                  setProcessing(false);
                  setImageError(null);
                  update({ image: null });
                }}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              void accept(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
        {imageError || shown("image") ? (
          <p className="px-1 text-footnote text-down" role="alert">
            {imageError ?? shown("image")}
          </p>
        ) : null}
      </div> : null}

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[1fr_200px]">
        <TextField
          label="Name"
          value={draft.name}
          maxLength={NAME_MAX}
          showCounter
          placeholder="Based Toad"
          autoComplete="off"
          onChange={(event) => update({ name: event.target.value })}
          error={shown("name")}
        />
        <TextField
          label="Ticker"
          value={draft.ticker}
          maxLength={TICKER_MAX}
          prefix="$"
          placeholder="TOAD"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => update({ ticker: normalizeTicker(event.target.value) })}
          error={shown("ticker")}
          hint={tickerTaken ? `Another coin already uses $${ticker}. A unique ticker is easier to find.` : undefined}
        />
      </div>

      <TextArea
        label="Description"
        optional
        value={draft.description}
        maxLength={DESCRIPTION_MAX}
        showCounter
        rows={3}
        placeholder="What is this coin about?"
        onChange={(event) => update({ description: event.target.value })}
        error={shown("description")}
      />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <TextField label="X" optional prefix="@" placeholder="handle" value={draft.x} autoComplete="off" spellCheck={false} onChange={(event) => update({ x: event.target.value })} error={shown("x")} />
        <TextField label="Telegram" optional placeholder="t.me/group" value={draft.telegram} autoComplete="off" spellCheck={false} onChange={(event) => update({ telegram: event.target.value })} error={shown("telegram")} />
        <TextField label="Website" optional placeholder="example.com" value={draft.website} autoComplete="off" spellCheck={false} inputMode="url" onChange={(event) => update({ website: event.target.value })} error={shown("website")} />
      </div>
    </div>
  );
}
