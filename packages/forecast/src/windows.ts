// The rate window. One number, one place, every surface.
//
// ---------------------------------------------------------------------------
// Why a constant at all
// ---------------------------------------------------------------------------
// "How many days of feed are left" is inventory divided by a feeding rate, and
// the feeding rate is an average over some trailing window. The window is not a
// detail: a farm that fed heavily last weekend reads short on a 7-day window
// and comfortable on a 21-day one, from the same stack, at the same instant.
//
// This product shipped three windows at once — 7 on the farm overview, 7 on the
// feed screen, 21 on the forecast screen, 14 in the SQL alert rule — and so
// shipped four different answers to one question. A rancher who catches the app
// disagreeing with itself about how much hay is left stops believing the rest
// of it. So the window is a constant, it lives here, and every caller reads it.
//
// ---------------------------------------------------------------------------
// Why 14
// ---------------------------------------------------------------------------
//   * Two whole weeks. Feeding practice is weekly-periodic — weekend crews feed
//     differently from weekday crews, and a load lands on a delivery day. A
//     window that is a whole number of weeks does not swing by which day of the
//     week you happen to open the screen. 7 is also a whole week, but a single
//     week is one delivery cycle: one late load moves the average by a third.
//   * Short enough to follow a real change. 21 days keeps three weeks of stale
//     history in the average, so a herd moved out ten days ago is still being
//     fed on this screen. Cattle move, pens empty, rations change with the
//     weather; a forecast that takes three weeks to notice is not a forecast.
//   * It is already the alert engine's window. The one enabled
//     `days_on_hand_low` rule carries an explicit `params.rate_days = 14`
//     (rule 44f3b8e9-fcd0-46be-b25f-ec74bfa20257). Choosing 14 means the
//     screens move to meet the alert rather than the live alert threshold
//     changing underneath a customer who is already being paged against it.
//
// A shorter window is defensible for a farm feeding a single pen on a fixed
// ration, and a longer one for a big yard with many delivery cycles. If this
// ever becomes a per-farm setting, it belongs beside `feed_waste_factors` and
// it must arrive in the UI carrying `source: 'caller'`, exactly as the waste
// factor does — not as a silent change to this default.
export const RATE_WINDOW_DAYS = 14;
