"use client";

import { useActionState } from "react";
import { Button, Callout } from "@overwatch/ui";
import { sendSignInLink, type LoginState } from "./actions";
import styles from "./login.module.css";

const initialState: LoginState = { status: "idle", message: "" };

/*
  Presentation only. The action, the states it returns, and what each one
  means are exactly as before — magic link, no sign-up, no password.

  Colour follows CLAUDE.md #4: `ok` for the link that went out (positive
  state), `warn` for a sign-in that did not go through. `crit` stays reserved
  for something actually wrong out at the pens — a link the rancher can
  simply request again is not that.
*/
export function LoginForm({ urlMessage }: { urlMessage?: string }) {
  const [state, formAction, pending] = useActionState(
    sendSignInLink,
    initialState,
  );

  if (state.status === "sent") {
    return (
      <div className="ow-form" role="status">
        <Callout tone="ok" icon="✓" className={styles.notice}>
          <b>{state.message}</b> The link signs you in on this device and
          expires after one use.
        </Callout>
        <p className="ow-quiet">
          Nothing in your inbox after a minute? Check the junk folder, then
          request another link.
        </p>
      </div>
    );
  }

  // A submit that failed and a link that failed are the same kind of news to
  // the person reading, so they get one treatment rather than two.
  const problem = state.status === "error" ? state.message : urlMessage;

  return (
    <form action={formAction} className="ow-form">
      {problem ? (
        <div role="alert">
          <Callout tone="warn" icon="!" className={styles.notice}>
            {problem}
          </Callout>
        </div>
      ) : null}

      <div className="ow-field">
        <label className="lbl" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@ranch.com"
          className="ow-input"
          aria-describedby="email-hint"
        />
        <span className="hint" id="email-hint">
          We send a one-time sign-in link to this address. There is no password
          to remember.
        </span>
      </div>

      <Button type="submit" variant="primary" block disabled={pending}>
        {pending ? "Sending link…" : "Send sign-in link"}
      </Button>
    </form>
  );
}
