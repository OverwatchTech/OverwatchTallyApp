import { BrandLockup, Card } from "@overwatch/ui";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

/*
  The first screen anyone sees, on the mockup's primitives: BrandLockup for
  the mark, Card for the box, .ow-field/.ow-input for the field, .ow-btn.pri
  for submit. No AppShell — a signed-out page has no bar — so login.module.css
  carries the field the shell would otherwise have drawn.

  Auth behaviour is untouched: magic link only, no sign-up path, same states.
*/

// Every reason a link can fail, in plain language. A raw error code never
// reaches this page (CLAUDE.md #11: errors never apologise, never vague).
const URL_MESSAGES: Record<string, string> = {
  link_expired:
    "That sign-in link has expired. A link works once and only for a short while. Request a new one below.",
  link_invalid:
    "That sign-in link did not work. It was either already used or the address got cut short by your mail app. Request a new one below.",
};

// What the console covers. Rancher vocabulary, no numbers — there is nothing
// honest to report before sign-in (CLAUDE.md #8).
const COVERAGE = ["Feed", "Water", "Head count", "Movement", "Alerts"];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const { message } = await searchParams;
  const urlMessage = message ? URL_MESSAGES[message] : undefined;

  return (
    <main className={styles.field}>
      <div className={styles.column}>
        <div className={styles.brand}>
          <BrandLockup />
        </div>

        <h1 className={styles.tagline}>
          Feed, water, and head count for a working livestock operation —
          measured at the bunk and the trough, not written down after the fact.
        </h1>

        <Card
          className={styles.card}
          title="Sign in"
          sub="No password"
          padded={false}
          note="Access is set up by your installer. There is no sign-up here."
        >
          <LoginForm urlMessage={urlMessage} />
        </Card>

        <ul className={`ow-micro ${styles.coverage}`}>
          {COVERAGE.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
