"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export interface LoginState {
  status: "idle" | "sent" | "error";
  message: string;
}

// Onboarding is installer-led: no sign-up path exists, so the magic link
// only goes to addresses that already have an account
// (shouldCreateUser: false).
export async function sendSignInLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email || !email.includes("@")) {
    return { status: "error", message: "Enter the email on your account." };
  }

  const supabase = await createClient();
  const headerList = await headers();
  const origin =
    headerList.get("origin") ?? `https://${headerList.get("host") ?? ""}`;

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    if (error.code === "otp_disabled" || /signup/i.test(error.message)) {
      return {
        status: "error",
        message:
          "No account uses that email. Access is set up by your installer.",
      };
    }
    if (error.code === "over_email_send_rate_limit") {
      return {
        status: "error",
        message:
          "A link already went out. Wait a minute before requesting another.",
      };
    }
    return {
      status: "error",
      message: "The link did not send. Try again in a minute.",
    };
  }

  return { status: "sent", message: `Link sent. Check ${email}.` };
}
