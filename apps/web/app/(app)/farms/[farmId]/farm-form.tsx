"use client";

import { useActionState } from "react";
import { updateFarm, type FarmFormState } from "./actions";

const initialState: FarmFormState = { status: "idle", message: "" };

export function FarmForm({
  farmId,
  name,
  timezone,
}: {
  farmId: string;
  name: string;
  timezone: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateFarm,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="farmId" value={farmId} />

      <div className="space-y-1.5">
        <label htmlFor="farm-name" className="block text-sm text-muted">
          Farm name
        </label>
        <input
          id="farm-name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={name}
          className="w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="farm-timezone" className="block text-sm text-muted">
          Timezone
        </label>
        <input
          id="farm-timezone"
          name="timezone"
          type="text"
          required
          defaultValue={timezone}
          placeholder="America/Denver"
          className="machine w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <p className="text-xs text-faint">
          Sets the clock for daily counts and reports.
        </p>
      </div>

      {state.status === "error" && (
        <p className="text-sm text-alert">{state.message}</p>
      )}
      {state.status === "saved" && (
        <p className="text-sm text-accent">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save farm"}
      </button>
    </form>
  );
}
