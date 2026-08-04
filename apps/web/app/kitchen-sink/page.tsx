import Link from "next/link";
import {
  ActivityRow,
  AlertPill,
  AppShell,
  Badge,
  BrandLockup,
  Button,
  Callout,
  Card,
  Cols,
  Cols2,
  DataTable,
  Delta,
  FarmPicker,
  Kpi,
  KpiGrid,
  Legend,
  LegendLine,
  LegendSwatch,
  LinkButton,
  Pad,
  PageHeader,
  Stat,
  StatusDot,
  TabPills,
  Tile,
  TileGrid,
  ToastProvider,
} from "@overwatch/ui";
import { OverlayBench } from "./interactive";

/*
  Kitchen sink — every primitive in @overwatch/ui with representative
  content, on one page. This is how the verify phase and every later change
  checks the design system without hunting for a screen that happens to use
  a component. Numbers here are illustrative and touch no query; nothing on
  this page should ever be read as real farm data.
*/

export const metadata = { title: "Design system — Overwatch Tally" };

interface StackRow {
  stack: string;
  type: string;
  bales: string;
  draw: string;
  last: string;
  unknownType?: boolean;
}

const STACKS: StackRow[] = [
  { stack: "HS03", type: "3×4", bales: "96", draw: "2.1", last: "06:41" },
  { stack: "HS11", type: "4×4", bales: "142", draw: "1.4", last: "08:20" },
  { stack: "HS05", type: "?", bales: "88", draw: "0.6", last: "Jul 28", unknownType: true },
  { stack: "HS17", type: "3×4", bales: "61", draw: "0.9", last: "Jul 24" },
];

const TROUGHS = [
  { id: "SP01", pct: 74, state: "ok" as const },
  { id: "SP02", pct: 61, state: "ok" as const },
  { id: "SP04", pct: 18, state: "crit" as const },
  { id: "SP07", pct: 34, state: "warn" as const },
  { id: "LP02-1", pct: 98, state: "ovf" as const },
  { id: "LP03", pct: 0, state: "off" as const },
];

export default function KitchenSinkPage() {
  return (
    <ToastProvider>
      <AppShell
        brand={<BrandLockup href="/" />}
        farmPicker={<FarmPicker current="Cedar Wash" href="/" />}
        tabs={
          <TabPills
            linkAs={Link}
            items={[
              { label: "Overview", href: "/kitchen-sink", active: true },
              { label: "Site Map", href: "/kitchen-sink#map" },
              { label: "Feed & Forecast", href: "/kitchen-sink#feed" },
              { label: "Water", href: "/kitchen-sink#water" },
            ]}
          />
        }
        status={
          <>
            <AlertPill count={4} href="/kitchen-sink#alerts" />
            <Stat>
              <StatusDot tone="ok" glow label="Online" />
              Gateway <b>online</b>
            </Stat>
            <Stat>07:44</Stat>
          </>
        }
      >
        <Pad>
          <PageHeader
            title="Design system — every primitive"
            sub={
              <>
                Cedar Wash Holding Facility · Redmond, UT · <b>212 head</b> ·
                sample content only, nothing here is a real reading
              </>
            }
          />

          <Callout
            action={
              <LinkButton size="sm" href="/kitchen-sink#feed">
                See forecast →
              </LinkButton>
            }
          >
            <b>Forecast flag — hay runs out ~9 weeks before first cutting.</b>{" "}
            Flat math says your 805 bales (≈604 tons) last to <b>Mar 18</b>. The
            model knows winter burn runs higher and projects empty on{" "}
            <b>Feb 24</b>. Gap ≈ <b>250 bales</b>.{" "}
            <b>Secure a winter hay contract by mid-January.</b>
          </Callout>

          <KpiGrid>
            <Kpi accent="ok" label="Animals" value="212" sub="184 mustangs · 28 burros" />
            <Kpi
              accent="hay"
              label="Fed yesterday"
              value="8,150"
              unit="lb"
              sub="1 load · 6 × 3×4 bales"
            />
            <Kpi
              accent="crit"
              label="Hay runway"
              badge={<Badge variant="crit">SHORT</Badge>}
              value="Feb 24"
              sub="805 bales · ≈604 tons on hand"
            />
            <Kpi
              accent="water"
              label="Water today"
              value="1,710"
              unit="gal"
              sub={
                <>
                  <Delta direction="down">▴7%</Delta> vs 7-day average (heat)
                </>
              }
            />
            <Kpi
              accent="warn"
              label="Attention"
              badge={<Badge variant="warn">6</Badge>}
              value="6"
              sub="1 empty-risk · 1 overflow · 3 low · 1 offline"
            />
          </KpiGrid>

          <Cols2>
            <Card
              title="Hay — loads delivered vs demand"
              aside={
                <Legend>
                  <LegendSwatch tone="hay">loads (6 bales ea.)</LegendSwatch>
                  <LegendLine tone="sel">forecast demand</LegendLine>
                </Legend>
              }
              note={
                <>
                  Model tracked actuals within <b>±5.8%</b> over 30 days.
                  Cold-snap ridge visible ahead.
                </>
              }
            >
              <div
                style={{
                  height: 140,
                  borderRadius: 8,
                  border: "1px dashed var(--line2)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink3)",
                  fontSize: 11.5,
                }}
              >
                chart slot
              </div>
            </Card>

            <Card
              title="Water — daily use & 7-day forecast"
              sub="canal + hauled"
              note={<>Wed heat spike forecast → pre-fill troughs on the AM route.</>}
            >
              <div
                style={{
                  height: 140,
                  borderRadius: 8,
                  border: "1px dashed var(--line2)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink3)",
                  fontSize: 11.5,
                }}
              >
                chart slot
              </div>
            </Card>
          </Cols2>

          <Cols>
            <div>
              <Card title="Live activity" sub="gates · troughs · feed truck" padded={false}>
                <ActivityRow tone="hay" meta="07:41">
                  <b>SP07</b> — 182 lb dropped
                </ActivityRow>
                <ActivityRow tone="ok" meta="07:36">
                  Gate <b>SP03 ↔ CAL</b> closed
                </ActivityRow>
                <ActivityRow tone="crit" meta="06:58">
                  Trough <b>SP04</b> draining fast — stuck float?
                </ActivityRow>
                <ActivityRow tone="sel" meta="06:44">
                  Trough <b>LP02-1</b> pinned 98% — overflow risk
                </ActivityRow>
                <ActivityRow tone="water" meta="06:30" dense>
                  Canal pump <b>running</b> · 12.1 gal/min
                </ActivityRow>
                <ActivityRow tone="off" meta="queued" dense>
                  <b>17:00</b> PM hay route
                </ActivityRow>
              </Card>

              <Card
                title="Troughs"
                sub="51 on this facility"
                padded={false}
                note={
                  <>
                    <b>LP03</b> has not reported since 04:12 — tile dimmed, not
                    counted as low.
                  </>
                }
              >
                <TileGrid>
                  {TROUGHS.map((trough) => (
                    <Tile
                      key={trough.id}
                      id={trough.id}
                      value={`${trough.pct}%`}
                      fillPct={trough.pct}
                      state={trough.state}
                      title={`Trough ${trough.id}`}
                    />
                  ))}
                </TileGrid>
              </Card>

              <OverlayBench />
            </div>

            <div>
              <Card
                title="Per-stack ledger"
                sub="18"
                padded={false}
                note={
                  <>
                    <b style={{ color: "var(--warn)" }}>? = bale type unknown</b>{" "}
                    — the one labeling task left.
                  </>
                }
              >
                <DataTable
                  caption="Hay stacks, bales on hand and daily draw"
                  rows={STACKS}
                  rowKey={(row) => row.stack}
                  maxHeight={240}
                  columns={[
                    { key: "stack", header: "Stack", mono: true, cell: (row) => row.stack },
                    {
                      key: "type",
                      header: "Type",
                      mono: true,
                      cell: (row) =>
                        row.unknownType ? (
                          <span style={{ color: "var(--warn)" }}>{row.type}</span>
                        ) : (
                          row.type
                        ),
                    },
                    { key: "bales", header: "Bales", mono: true, align: "right", cell: (row) => row.bales },
                    { key: "draw", header: "Draw/d", mono: true, align: "right", cell: (row) => row.draw },
                    { key: "last", header: "Last", mono: true, align: "right", cell: (row) => row.last },
                  ]}
                />
              </Card>

              <Card title="Badges" sub="semantic only">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Badge variant="ok">LIVE</Badge>
                  <Badge variant="warn">LOW</Badge>
                  <Badge variant="crit">SHORT</Badge>
                  <Badge>ESTIMATE</Badge>
                </div>
              </Card>

              <Card title="Buttons">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <Button>Snooze</Button>
                  <Button variant="primary">Save pen</Button>
                  <Button size="sm">Open →</Button>
                  <Button disabled>Unavailable</Button>
                </div>
              </Card>

              <Card title="Callout severities" padded={false}>
                <div style={{ padding: 16 }}>
                  <Callout tone="warn" icon="!">
                    <b>Cold snap Wed–Fri.</b> Forage demand rises about{" "}
                    <b>9%</b> on the nights below 20°F.
                  </Callout>
                  <Callout tone="ok" icon="✓">
                    <b>All containment gates closed.</b> Last change 07:36.
                  </Callout>
                  <Callout tone="info" icon="i">
                    <b>Estimate.</b> Loads are counted from tractor stops, not
                    weighed — treat as an estimate, not a scale reading.
                  </Callout>
                </div>
              </Card>
            </div>
          </Cols>
        </Pad>
      </AppShell>
    </ToastProvider>
  );
}
