"use client";

import { useActionState } from "react";
import type { MemberRole } from "@/lib/auth/claims";
import { updateMemberRole, type RoleFormState } from "./actions";

const initialState: RoleFormState = { status: "idle", message: "" };

const ROLES: readonly MemberRole[] = ["owner", "manager", "crew", "viewer"];

export function RoleForm({
  userId,
  role,
}: {
  userId: string;
  role: MemberRole;
}) {
  const [state, formAction, pending] = useActionState(
    updateMemberRole,
    initialState,
  );

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <label className="sr-only" htmlFor={`role-${userId}`}>
        Role
      </label>
      <select
        id={`role-${userId}`}
        name="role"
        defaultValue={role}
        className="machine rounded border border-hairline bg-background px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save role"}
      </button>
      {state.status === "error" && (
        <span className="text-xs text-alert">{state.message}</span>
      )}
      {state.status === "saved" && (
        <span className="text-xs text-accent">{state.message}</span>
      )}
    </form>
  );
}
