// One shape for every console form result, so the client components stay dumb.
export interface ActionState {
  status: 'idle' | 'ok' | 'error';
  message: string;
}

export const IDLE: ActionState = { status: 'idle', message: '' };

export function ok(message: string): ActionState {
  return { status: 'ok', message };
}

export function fail(message: string): ActionState {
  return { status: 'error', message };
}

/** Trimmed string field, or '' when absent. */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function numberField(formData: FormData, name: string): number | null {
  const raw = field(formData, name);
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
