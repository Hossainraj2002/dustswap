"use client";

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

interface FieldShellProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  counter?: { value: number; max: number };
  children: ReactNode;
  optional?: boolean;
}

function FieldShell({ id, label, hint, error, counter, children, optional }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <label htmlFor={id} className="text-footnote font-semibold text-label-2">
          {label}
          {optional ? <span className="font-normal text-label-2"> (optional)</span> : null}
        </label>
        {counter ? (
          <span
            className={cn("mf-num text-caption1 text-label-2", counter.value > counter.max && "text-down")}
            aria-hidden
          >
            {counter.value}/{counter.max}
          </span>
        ) : null}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 px-1 text-footnote text-down" role="alert">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="px-1 text-footnote text-label-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const inputClasses =
  "w-full rounded-sm bg-fill-3 px-3.5 text-body text-label placeholder:text-placeholder transition-[box-shadow,background-color] outline-none focus:bg-fill-4 focus:shadow-[0_0_0_2px_var(--mf-tint)] disabled:opacity-50";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label: string;
  hint?: ReactNode;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  showCounter?: boolean;
  optional?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, prefix, suffix, showCounter, maxLength, optional, className, id, value, ...props },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const length = typeof value === "string" ? value.length : 0;
  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      counter={showCounter && maxLength ? { value: length, max: maxLength } : undefined}
    >
      <div className="relative flex items-center">
        {prefix ? (
          <span className="pointer-events-none absolute left-3.5 text-body text-label-2" aria-hidden>
            {prefix}
          </span>
        ) : null}
        <input
          ref={ref}
          id={fieldId}
          value={value}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
          className={cn(inputClasses, "h-11", prefix ? "pl-8" : undefined, suffix ? "pr-12" : undefined, error && "shadow-[0_0_0_2px_var(--mf-down)] focus:shadow-[0_0_0_2px_var(--mf-down)]", className)}
          {...props}
        />
        {suffix ? <span className="absolute right-2 flex items-center">{suffix}</span> : null}
      </div>
    </FieldShell>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  error?: string;
  showCounter?: boolean;
  optional?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, showCounter, maxLength, optional, className, id, value, rows = 3, ...props },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const length = typeof value === "string" ? value.length : 0;
  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      counter={showCounter && maxLength ? { value: length, max: maxLength } : undefined}
    >
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        className={cn(inputClasses, "resize-none py-3 leading-snug", error && "shadow-[0_0_0_2px_var(--mf-down)]", className)}
        {...props}
      />
    </FieldShell>
  );
});
