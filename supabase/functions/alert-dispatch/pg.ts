// pg.ts — the dispatcher's entire database surface: two RPC calls.
//
// This function does NOT hold service_role. CLAUDE.md #9 puts that key in
// exactly two places (mdp-webhook, stripe-webhook) and this is neither.
// It authenticates as `alert_dispatcher`, a login-less Postgres role whose
// only privileges are EXECUTE on public.alert_dispatch_queue and
// public.alert_dispatch_record (migration 0011). A leaked dispatcher token
// can read the open-alert queue and append receipts. It cannot read a farm,
// a device, a feed record, or another tenant — because the grant does not
// exist, not because a policy remembered to say no.
//
// Zero dependencies, like mdp-webhook: the function stays verifiable with
// plain tsc and ships no npm imports.

export class RpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RpcClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly dispatchJwt: string,
  ) {}

  async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.apiKey,
        Authorization: `Bearer ${this.dispatchJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });

    if (!res.ok) {
      // PostgREST error bodies can echo row values. Keep the status and the
      // SQLSTATE; drop everything else, so this is safe to log.
      let code: string | null = null;
      try {
        const body = (await res.json()) as { code?: unknown };
        if (typeof body.code === 'string') code = body.code;
      } catch {
        // unreadable body — the status alone tells the story
      }
      throw new RpcError(
        res.status,
        code,
        `rpc ${fn}: HTTP ${res.status}${code === null ? '' : ` (${code})`}`,
      );
    }

    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }
}
