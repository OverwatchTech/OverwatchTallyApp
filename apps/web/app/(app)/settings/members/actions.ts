"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { MemberRole } from "@/lib/auth/claims";

export interface RoleFormState {
  status: "idle" | "saved" | "error";
  message: string;
}

const ROLES: readonly MemberRole[] = ["owner", "manager", "crew", "viewer"];

// Owner only (members_owner_update). The select is hidden from everyone
// else, but RLS is the enforcement — a denial comes back as zero updated
// rows. The protect_last_owner trigger blocks demoting the last owner.
export async function updateMemberRole(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "") as MemberRole;

  if (!userId || !ROLES.includes(role)) {
    return { status: "error", message: "Pick a role from the list." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("org_members")
    .update({ role })
    .eq("user_id", userId)
    .select("user_id");

  if (error) {
    if (/owner/i.test(error.message)) {
      return {
        status: "error",
        message: "The account needs at least one owner.",
      };
    }
    return { status: "error", message: "That change needs the owner." };
  }
  if (!data || data.length === 0) {
    return { status: "error", message: "That change needs the owner." };
  }

  revalidatePath("/settings/members");
  return { status: "saved", message: "Role saved." };
}
