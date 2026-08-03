// Typed client for the Milesight Open API.
//
// THREE RULES THIS FILE ENFORCES
//
//  1. NEVER POLL (CLAUDE.md #1). There is no list-everything helper, no
//     interval, no refresh loop. Webhooks carry all data; this client exists
//     for provisioning and configuration only. `searchDevices` is a
//     provisioning-time confirmation, not a data source.
//  2. RESPECT THE DAILY BUDGET (ARCHITECTURE §4.1: 1,000/24 h free, 1,000 +
//     100 × devices on Professional). Milesight publishes no rate-limit
//     header and no quota endpoint, so we count our own calls: every request
//     runs through `request()`, which invokes the caller's `onCall` recorder
//     before the fetch. Access tokens are cached for their full ~1 h life so
//     a batch of registrations costs one token call, not one per device.
//     There is no batch device endpoint — N devices is N requests, and
//     `addDevices()` says so in its return value rather than hiding it.
//  3. NEVER LOG SECRETS. The client id, client secret, and access token never
//     enter a thrown message, a returned object, or a console line. Errors
//     carry Milesight's own `errCode`/`errMsg` and nothing of ours.
//
// WHAT MILESIGHT DOES NOT EXPOSE (verified 2026-08-03 against the published
// interface list — 16 endpoints total). There is no API to create a Group, to
// create or list Applications, or to register a webhook callback URI. Those
// are console-only. Calling the corresponding method throws
// MdpConsoleOnlyError with the exact console path instead of hitting a guessed
// endpoint. ARCHITECTURE §3 assumes one Application per farm; that Application
// is still created by hand, and the console records its id.
import type {
  MdpAddDeviceRequest,
  MdpAddDeviceResponse,
  MdpConsoleOnlyOperation,
  MdpDevice,
  MdpDeviceSearchRequest,
  MdpFailure,
  MdpPage,
  MdpSuccess,
  MdpTokenData,
} from './types';
import { CONSOLE_ONLY_STEPS } from './types';

export interface MdpCredentials {
  /** Base URL from the Application's Authentication panel, e.g. https://us-openapi.milesight.com */
  serverAddress: string;
  clientId: string;
  clientSecret: string;
}

/** Called before every outbound request so the caller can bill the budget. */
export type BudgetRecorder = (op: string) => Promise<void> | void;

export interface MdpClientOptions {
  onCall?: BudgetRecorder;
  fetchImpl?: typeof fetch;
  /** Refuse to send once this many calls have been made in one client life. */
  maxCallsPerRequest?: number;
}

export class MdpApiError extends Error {
  readonly status: number;
  readonly errCode: string | null;
  readonly requestId: string | null;

  constructor(status: number, failure: MdpFailure | null) {
    // Milesight's own message only. Nothing of ours is interpolated.
    super(failure?.errMsg ?? `Milesight returned ${status}.`);
    this.name = 'MdpApiError';
    this.status = status;
    this.errCode = failure?.errCode ?? null;
    this.requestId = failure?.requestId ?? null;
  }
}

export class MdpConsoleOnlyError extends Error {
  readonly operation: MdpConsoleOnlyOperation;
  readonly consoleStep: string;

  constructor(operation: MdpConsoleOnlyOperation) {
    super(`Milesight has no API for this. ${CONSOLE_ONLY_STEPS[operation]}`);
    this.name = 'MdpConsoleOnlyError';
    this.operation = operation;
    this.consoleStep = CONSOLE_ONLY_STEPS[operation];
  }
}

export class MdpBudgetError extends Error {
  constructor(limit: number) {
    super(`Stopped at ${limit} Milesight calls for this action. Split the work across runs.`);
    this.name = 'MdpBudgetError';
  }
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms. Held for the token's full life minus a safety margin. */
  expiresAt: number;
}

/**
 * Access tokens live ~1 h. Caching them per client id is the single biggest
 * budget saving available: without it every registration costs two calls.
 * Keyed on client id; the secret is never part of the key.
 */
const TOKEN_CACHE = new Map<string, CachedToken>();
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/** Test seam: drop cached tokens (also used by the rotate-credentials path). */
export function forgetToken(clientId: string): void {
  TOKEN_CACHE.delete(clientId);
}

export class MdpClient {
  private readonly credentials: MdpCredentials;
  private readonly onCall: BudgetRecorder;
  private readonly fetchImpl: typeof fetch;
  private readonly maxCalls: number;
  private calls = 0;

  constructor(credentials: MdpCredentials, options: MdpClientOptions = {}) {
    this.credentials = {
      ...credentials,
      serverAddress: credentials.serverAddress.replace(/\/+$/, ''),
    };
    this.onCall = options.onCall ?? (() => {});
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxCalls = options.maxCallsPerRequest ?? 60;
  }

  /** Calls this client has spent. Feeds the budget indicator. */
  get callsSpent(): number {
    return this.calls;
  }

  // ── auth ────────────────────────────────────────────────────────────────

  private async accessToken(): Promise<string> {
    const cached = TOKEN_CACHE.get(this.credentials.clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      grant_type: 'client_credentials',
    });

    // Documented Content-Type is the literal string `x-www-form-urlencoded`;
    // the canonical form is sent, which every conforming server accepts.
    const response = await this.send('oauth.token', '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await this.unwrap<MdpTokenData>(response);
    const lifetimeMs = Math.max(0, data.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS);
    TOKEN_CACHE.set(this.credentials.clientId, {
      accessToken: data.access_token,
      expiresAt: Date.now() + lifetimeMs,
    });
    return data.access_token;
  }

  // ── device management (the whole supported surface) ──────────────────────

  /**
   * Register one device. `snDevEUI` takes the SN or the EUI; we send the
   * upper-cased DevEUI so MDP's record and ours agree byte for byte — the
   * webhook looks devices up with an exact match on the upper-cased value.
   */
  async addDevice(input: MdpAddDeviceRequest): Promise<MdpAddDeviceResponse> {
    return this.authed<MdpAddDeviceResponse>('device.add', '/device/openapi/v1/devices', {
      method: 'POST',
      body: JSON.stringify({ ...input, snDevEUI: input.snDevEUI.toUpperCase() }),
    });
  }

  /**
   * Register several devices. Milesight publishes no batch endpoint, so this
   * is a loop and it costs one request per device — the returned `callsSpent`
   * is the honest number, and a failure stops the run rather than burning the
   * rest of the budget on a bad batch.
   */
  async addDevices(
    inputs: readonly MdpAddDeviceRequest[],
  ): Promise<{ registered: MdpAddDeviceResponse[]; failedAt: number | null; error: string | null }> {
    const registered: MdpAddDeviceResponse[] = [];
    for (const [index, input] of inputs.entries()) {
      try {
        registered.push(await this.addDevice(input));
      } catch (cause) {
        return {
          registered,
          failedAt: index,
          error: cause instanceof Error ? cause.message : 'Milesight refused the registration.',
        };
      }
    }
    return { registered, failedAt: null, error: null };
  }

  async getDevice(deviceId: string): Promise<MdpDevice> {
    return this.authed<MdpDevice>(
      'device.get',
      `/device/openapi/v1/devices/${encodeURIComponent(deviceId)}`,
      { method: 'GET' },
    );
  }

  /**
   * Confirm a registration landed. POST, not GET — that is Milesight's shape.
   * Provisioning-time only: this is not a data source and must never be put on
   * a timer (CLAUDE.md #1).
   */
  async searchDevices(input: MdpDeviceSearchRequest): Promise<MdpPage<MdpDevice>> {
    return this.authed<MdpPage<MdpDevice>>(
      'device.search',
      '/device/openapi/v1/devices/search',
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  // ── console-only operations ─────────────────────────────────────────────

  /* eslint-disable @typescript-eslint/no-unused-vars */
  createGroup(_name: string): Promise<never> {
    return Promise.reject(new MdpConsoleOnlyError('createGroup'));
  }

  listApplications(): Promise<never> {
    return Promise.reject(new MdpConsoleOnlyError('listApplications'));
  }

  registerWebhookCallback(_uri: string): Promise<never> {
    return Promise.reject(new MdpConsoleOnlyError('registerWebhookCallback'));
  }

  rotateWebhookSecret(): Promise<never> {
    return Promise.reject(new MdpConsoleOnlyError('rotateWebhookSecret'));
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ── transport ───────────────────────────────────────────────────────────

  private async authed<T>(op: string, path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const response = await this.send(op, path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    return this.unwrap<T>(response);
  }

  private async send(op: string, path: string, init: RequestInit): Promise<Response> {
    if (this.calls >= this.maxCalls) throw new MdpBudgetError(this.maxCalls);
    this.calls += 1;
    // Recorded BEFORE the call: a request that failed still spent budget.
    await this.onCall(op);
    return this.fetchImpl(`${this.credentials.serverAddress}${path}`, {
      ...init,
      cache: 'no-store',
    });
  }

  private async unwrap<T>(response: Response): Promise<T> {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new MdpApiError(response.status, asFailure(parsed));
    }

    const envelope = parsed as Partial<MdpSuccess<T>> & Partial<MdpFailure>;
    if (envelope?.status === 'Failed') {
      throw new MdpApiError(response.status, asFailure(parsed));
    }
    if (envelope?.data === undefined) {
      throw new MdpApiError(response.status, {
        status: 'Failed',
        errMsg: 'Milesight returned a response with no data.',
      });
    }
    return envelope.data as T;
  }
}

function asFailure(parsed: unknown): MdpFailure | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  return {
    status: 'Failed',
    requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
    errCode: typeof record.errCode === 'string' ? record.errCode : undefined,
    errMsg: typeof record.errMsg === 'string' ? record.errMsg : undefined,
  };
}
