// JWT custom-claim access for UI gating.
// The custom access token hook stamps org_id, member_role, and (staff only)
// platform_role into every JWT. Decoding here drives navigation and which
// controls render — UX only. RLS re-checks the same claims server-side on
// every query; nothing in apps/web is trusted with enforcement (CLAUDE.md #9).
import type { Session } from "@supabase/supabase-js";

export type MemberRole = "owner" | "manager" | "crew" | "viewer";
export type PlatformRole = "installer" | "support" | "admin";

export interface AppClaims {
  orgId: string | null;
  memberRole: MemberRole | null;
  platformRole: PlatformRole | null;
}

const MEMBER_ROLES: readonly MemberRole[] = [
  "owner",
  "manager",
  "crew",
  "viewer",
];
const PLATFORM_ROLES: readonly PlatformRole[] = [
  "installer",
  "support",
  "admin",
];

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;
  try {
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function claimsFromSession(session: Session | null): AppClaims {
  const empty: AppClaims = { orgId: null, memberRole: null, platformRole: null };
  if (!session?.access_token) return empty;

  const payload = decodeJwtPayload(session.access_token);
  if (!payload) return empty;

  const orgId = typeof payload.org_id === "string" ? payload.org_id : null;
  const memberRole = MEMBER_ROLES.includes(payload.member_role as MemberRole)
    ? (payload.member_role as MemberRole)
    : null;
  const platformRole = PLATFORM_ROLES.includes(
    payload.platform_role as PlatformRole,
  )
    ? (payload.platform_role as PlatformRole)
    : null;

  return { orgId, memberRole, platformRole };
}

/** Settings (and other manager-level surfaces) show for manager and owner. */
export function isManagerOrOwner(role: MemberRole | null): boolean {
  return role === "owner" || role === "manager";
}
