import { createClient } from "@/lib/supabase/server";
import { claimsFromSession } from "@/lib/auth/claims";
import { RoleForm } from "./role-form";

// Member list. Adding people is installer-led in v1, so there is no invite
// control here — the list plus role changes (owner only) is the whole
// surface. Email addresses live in auth.users, which the client cannot
// read; each row shows the member id, with the signed-in member's email
// shown on their own row.
export default async function MembersPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const isOwner = claims.memberRole === "owner";

  const { data: members } = await supabase
    .from("org_members")
    .select("user_id, role, created_at")
    .order("created_at");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="type-display text-xl">Members</h1>
        <p className="mt-2 text-sm text-muted">
          Everyone with access to this operation.
          {isOwner
            ? " Role changes save per person."
            : " Role changes need the owner."}{" "}
          Adding someone new is handled by your installer.
        </p>
      </header>

      <section className="rounded-lg border border-hairline bg-card">
        {!members || members.length === 0 ? (
          <p className="p-6 text-sm text-muted">No members found.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {members.map((member) => {
              const isSelf = member.user_id === user?.id;
              return (
                <li
                  key={member.user_id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      {isSelf && user?.email ? (
                        <>
                          {user.email}{" "}
                          <span className="text-xs text-muted">· you</span>
                        </>
                      ) : (
                        <span className="machine text-xs">
                          member {member.user_id.slice(0, 8)}
                        </span>
                      )}
                    </p>
                  </div>
                  {isOwner ? (
                    <RoleForm userId={member.user_id} role={member.role} />
                  ) : (
                    <span className="machine rounded border border-hairline px-2 py-0.5 text-xs text-foreground">
                      {member.role}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
