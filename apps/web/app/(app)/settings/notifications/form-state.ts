// Shared shape for every form on this screen.
//
// It lives here rather than in actions.ts because a `'use server'` module may
// only export async functions — a plain object export fails the build with
// "A 'use server' file can only export async functions, found object".

export interface FormState {
  status: 'idle' | 'saved' | 'error';
  message: string;
}

export const IDLE: FormState = { status: 'idle', message: '' };
