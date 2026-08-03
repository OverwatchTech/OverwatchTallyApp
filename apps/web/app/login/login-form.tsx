"use client";

import { useActionState } from "react";
import { sendSignInLink, type LoginState } from "./actions";

const initialState: LoginState = { status: "idle", message: "" };

export function LoginForm({ urlMessage }: { urlMessage?: string }) {
  const [state, formAction, pending] = useActionState(
    sendSignInLink,
    initialState,
  );

  if (state.status === "sent") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-foreground">{state.message}</p>
        <p className="text-sm text-muted">
          The link signs you in on this device and expires after one use.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-sm text-muted">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@ranch.com"
          className="w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
        />
      </div>

      {state.status === "error" && (
        <p className="text-sm text-alert">{state.message}</p>
      )}
      {state.status === "idle" && urlMessage && (
        <p className="text-sm text-alert">{urlMessage}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
      >
        {pending ? "Sending link…" : "Send sign-in link"}
      </button>
    </form>
  );
}
