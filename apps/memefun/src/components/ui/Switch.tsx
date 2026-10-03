"use client";

import { Switch as RadixSwitch } from "radix-ui";
import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

/** iOS switch: 51x31 track. Tinted Base Blue rather than green, which is reserved for prices. */
export function Switch({ checked, onCheckedChange, label, disabled, id }: SwitchProps) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-[31px] w-[51px] shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-tint-fill" : "bg-fill",
      )}
    >
      <RadixSwitch.Thumb className="block size-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_3px_1px_rgba(0,0,0,0.06)] transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=checked]:translate-x-5" />
    </RadixSwitch.Root>
  );
}
