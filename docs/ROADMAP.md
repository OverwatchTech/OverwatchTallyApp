# Roadmap — recorded, deliberately not in v1

## Feed-truck tracking (two candidate paths)

1. **`GatewayDirectSource`** — AT101 (unsupported by MDP) received by the
   gateway's *embedded* network server, forwarded via MQTT/HTTPS straight to
   our ingest endpoint, bypassing MDP. Same `readings` /
   `tracker_positions` tables via the `TelemetrySource` interface.
   **[VERIFY on hardware]** — bench test whether one UG65/UG67 can run the
   embedded NS for the tracker *and* packet-forward sensors to MDP
   simultaneously via Multi-Destination. A device must never be registered in
   both network servers (competing session/downlink management). If the test
   fails, the tracker needs its own gateway.
   AT101 note: ranch has no Wi-Fi APs, so positioning runs GNSS-only (power
   hungry). Use motion-triggered reporting, not short periodic intervals.
2. **Third-party LTE tracker with its own webhook** — simpler, cheaper per
   unit, higher position resolution, no dual-destination question. Preferable
   wherever the truck has cell coverage.

v1 ships route inference from ordered gate events with explicit confidence,
never labeled GPS.

## Segmentation fine-tuning loop

Every AI proposal stores original geometry beside the human correction
(`map_features.ai_original_geom`). That diff is a training set. Build the
fine-tuning pipeline once volume justifies it; v1 only collects.

## Analytics beyond v1

- ML weight-gain prediction and ADG modeling
- Market price integration (feed reorder cost optimization)

## Misc

- Second `TelemetrySource` implementations beyond MDP (see ARCHITECTURE §5.7)
- Satellite re-count cadence tuning for hay-stack audits once real divergence
  data exists
