import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatTier } from "@/lib/format";

export default async function FarmsPage() {
  const supabase = await createClient();

  const { data: farms } = await supabase
    .from("farms")
    .select("id, name, status, subscription_tier")
    .order("name");

  const onlyFarm = farms && farms.length === 1 ? farms[0] : undefined;
  if (onlyFarm) {
    redirect(`/farms/${onlyFarm.id}`);
  }

  if (!farms || farms.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-hairline bg-card p-6">
        <h1 className="mb-1 text-base font-medium">No farms yet</h1>
        <p className="text-sm text-muted">
          Your farm shows up here once your installer finishes setup.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="type-display mb-6 text-xl">Farms</h1>
      <ul className="grid gap-3 sm:grid-cols-2">
        {farms.map((farm) => (
          <li key={farm.id}>
            <Link
              href={`/farms/${farm.id}`}
              className="block rounded-lg border border-hairline bg-card p-4 transition-colors hover:border-accent"
            >
              <span className="block text-sm font-medium text-foreground">
                {farm.name}
              </span>
              <span className="machine mt-1 block text-xs text-muted">
                {farm.status}
                {farm.subscription_tier
                  ? ` · ${formatTier(farm.subscription_tier)}`
                  : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
