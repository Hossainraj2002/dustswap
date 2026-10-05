import Image from "next/image";
import { cn } from "@/lib/cn";

/** The supplied F–M cube artwork, shared with app and wallet branding. */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <Image src="/memefun-logo.png" width={size} height={size} alt="" aria-hidden unoptimized
      className={cn("shrink-0 rounded-md object-contain", className)} />
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <BrandMark />
      <span className="font-rounded text-title3 font-extrabold tracking-tight text-label">memefun</span>
    </span>
  );
}
