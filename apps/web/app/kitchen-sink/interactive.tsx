"use client";

import { useState } from "react";
import {
  Button,
  Card,
  Drawer,
  DrawerFacts,
  Modal,
  useToast,
} from "@overwatch/ui";

/**
 * The three primitives that genuinely need interactivity, wired up so the
 * verify pass can see the entrance curves and the blur actually run.
 */
export function OverlayBench() {
  const toast = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Card
      title="Overlays"
      sub="drawer · toast · modal"
      note="All three sit on --panel with a 10–14px backdrop blur and enter on cubic-bezier(.2,.9,.3,1)."
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button onClick={() => setDrawerOpen((open) => !open)}>
          {drawerOpen ? "Hide trough drawer" : "Show trough drawer"}
        </Button>
        <Button onClick={() => setModalOpen(true)}>Open modal</Button>
        <Button
          onClick={() =>
            toast({ message: "Gate SP03 closed", tone: "ok", meta: "07:36" })
          }
        >
          Raise a toast
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            toast({
              message: "Trough SP04 draining fast",
              tone: "crit",
              meta: "06:58",
            })
          }
        >
          Raise an alert toast
        </Button>
      </div>

      <div
        style={{
          position: "relative",
          height: 300,
          marginTop: 14,
          borderRadius: 12,
          border: "1px solid var(--line)",
          background:
            "radial-gradient(1100px 750px at 60% 40%, #121822 0%, #0b0e12 72%)",
        }}
      >
        <Drawer
          open={drawerOpen}
          title="SP04"
          kind="trough"
          tone="crit"
          note="Level fell 41% in 90 minutes with the gate closed. Consistent with a stuck float."
          actions={
            <>
              <Button>Snooze</Button>
              <Button variant="primary">Log a check</Button>
            </>
          }
        >
          <DrawerFacts
            items={[
              { key: "level", label: "Level", value: "18%" },
              { key: "cap", label: "Capacity", value: "310 gal" },
              { key: "drain", label: "Drain rate", value: "4.1 gal/h" },
              { key: "seen", label: "Last reading", value: "06:58" },
            ]}
          />
        </Drawer>
      </div>

      <Modal
        open={modalOpen}
        title="Correct the bale count"
        onClose={() => setModalOpen(false)}
        actions={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>
              Save count
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.6 }}>
          The ledger says stack HS03 holds 96 bales. Enter what is actually on
          the ground and the ledger re-bases from today forward.
        </p>
      </Modal>
    </Card>
  );
}
