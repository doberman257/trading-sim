"use client";

import { useActionState } from "react";
import { signup, type AuthActionState } from "@/app/(auth)/actions";

const initialState: AuthActionState = {};

const inputClassName =
  "border-default bg-elevated text-fg placeholder:text-subtle focus:border-strong focus:ring-accent w-full rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signup, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.error && (
        <div
          role="alert"
          className="border-warn/30 bg-warn/5 text-warn rounded-md border px-3 py-2 text-xs"
        >
          {state.error}
        </div>
      )}
      {state.info && (
        <div className="border-default bg-elevated text-fg rounded-md border px-3 py-2 text-xs">
          {state.info}
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          disabled={isPending}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Password</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="new-password"
          minLength={8}
          disabled={isPending}
          className={inputClassName}
        />
        <span className="text-subtle text-xs">At least 8 characters.</span>
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="bg-fg text-on-fg mt-1 rounded-md py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
