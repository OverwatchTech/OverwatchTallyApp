"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface FarmFormState {
  status: "idle" | "saved" | "error";
  message: string;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Owner and manager may rename the farm and set its timezone. The client
// hides the form from crew and viewers, but that is UX only — RLS
// (farms_manager_update) is the enforcement, and a denial comes back as
// zero updated rows.
export async function updateFarm(
  _prev: FarmFormState,
  formData: FormData,
): Promise<FarmFormState> {
  const farmId = String(formData.get("farmId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();

  if (!farmId) {
    return { status: "error", message: "The farm could not be identified." };
  }
  if (!name || name.length > 120) {
    return {
      status: "error",
      message: "Give the farm a name under 120 characters.",
    };
  }
  if (!isValidTimezone(timezone)) {
    return {
      status: "error",
      message: "That timezone is not recognized. Use a name like America/Denver.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("farms")
    .update({ name, timezone })
    .eq("id", farmId)
    .select("id");

  if (error || !data || data.length === 0) {
    return {
      status: "error",
      message: "That change needs a manager or the owner.",
    };
  }

  revalidatePath(`/farms/${farmId}`);
  revalidatePath("/");
  return { status: "saved", message: "Farm saved." };
}
