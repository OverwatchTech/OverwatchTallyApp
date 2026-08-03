import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { claimsFromSession, isManagerOrOwner } from "@/lib/auth/claims";
import { TelemetryRail } from "@/components/telemetry-rail";
import { signOut } from "./actions";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();

  // getUser() validates the token with the auth server; middleware already
  // gates the route, this is belt and suspenders for direct renders.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);

  const { data: farms } = await supabase
    .from("farms")
    .select("id, name")
    .order("name");

  const onlyFarm = farms && farms.length === 1 ? farms[0] : undefined;
  const farmHref = onlyFarm ? `/farms/${onlyFarm.id}` : "/";
  const farmLabel = farms && farms.length > 1 ? "Farms" : "Farm";

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-hairline bg-background">
        <div className="border-b border-hairline px-4 py-4">
          <Link href="/" className="type-display text-sm text-foreground">
            Overwatch Tally
          </Link>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-3 text-sm">
          <Link
            href={farmHref}
            className="block rounded px-2 py-1.5 text-foreground hover:bg-card"
          >
            {farmLabel}
          </Link>
          <Link
            href="/alerts"
            className="block rounded px-2 py-1.5 text-foreground hover:bg-card"
          >
            Alerts
          </Link>
          {isManagerOrOwner(claims.memberRole) && (
            <Link
              href="/settings/members"
              className="block rounded px-2 py-1.5 text-foreground hover:bg-card"
            >
              Settings
            </Link>
          )}
          {claims.platformRole && (
            <Link
              href="/admin"
              className="block rounded px-2 py-1.5 text-accent hover:bg-card"
            >
              Operations
            </Link>
          )}
        </nav>

        <div className="space-y-2 border-t border-hairline px-4 py-3">
          <p className="text-xs text-muted">
            signed in as {user.email}
            {claims.memberRole && (
              <>
                {" · "}
                <span className="machine text-foreground">
                  {claims.memberRole}
                </span>
              </>
            )}
          </p>
          <form action={signOut}>
            <button
              type="submit"
              className="w-full rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/*
        The rail is a farm-scoped strip: it renders itself only on
        /farms/[farmId]/** and passes the page straight through everywhere
        else, so non-farm routes keep the full width. Its width is reserved
        from first paint (fixed w-32 aside on desktop, a 14-unit bottom bar
        under 900px), so numbers arriving over Realtime never shift the page.
      */}
      <TelemetryRail>
        <main className="min-w-0 flex-1 p-8">
          {claims.orgId ? (
            children
          ) : (
            <div className="mx-auto max-w-md rounded-lg border border-hairline bg-card p-6">
              <h1 className="mb-1 text-base font-medium">Almost there</h1>
              <p className="text-sm text-muted">
                Your account is not connected to an operation yet. Your
                installer finishes this step during setup.
              </p>
            </div>
          )}
        </main>
      </TelemetryRail>
    </div>
  );
}
