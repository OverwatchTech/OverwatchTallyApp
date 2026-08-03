import { LoginForm } from "./login-form";

const URL_MESSAGES: Record<string, string> = {
  link_expired: "That sign-in link expired. Request a new one.",
  link_invalid: "That sign-in link did not work. Request a new one.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const { message } = await searchParams;
  const urlMessage = message ? URL_MESSAGES[message] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <p className="type-display mb-8 text-center text-lg tracking-wide text-foreground">
          Overwatch Tally
        </p>
        <div className="rounded-lg border border-hairline bg-card p-6">
          <h1 className="mb-1 text-base font-medium text-foreground">
            Sign in
          </h1>
          <p className="mb-5 text-sm text-muted">
            Enter your email and we send a sign-in link. No password.
          </p>
          <LoginForm urlMessage={urlMessage} />
        </div>
        <p className="mt-4 text-center text-xs text-faint">
          New here? Access is set up by your installer.
        </p>
      </div>
    </main>
  );
}
