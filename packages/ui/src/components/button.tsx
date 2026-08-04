import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cx } from './util';

export type ButtonVariant = 'default' | 'primary';
export type ButtonSize = 'md' | 'sm';

interface ButtonLook {
  /** `primary` takes the teal gradient with dark text. */
  variant?: ButtonVariant;
  /** `sm` is the inline 4px/12px pill used inside a Callout or a note. */
  size?: ButtonSize;
  /** Fill the container. */
  block?: boolean;
}

function look({ variant = 'default', size = 'md', block }: ButtonLook): string {
  return cx('ow-btn', variant === 'primary' && 'pri', size === 'sm' && 'sm', block && 'block');
}

export type ButtonProps = ButtonLook & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * Buttons say what happens ("Save pen", not "Submit") and keep their name
 * through the whole flow (CLAUDE.md #11).
 */
export function Button({ variant, size, block, className, type, ...rest }: ButtonProps) {
  return <button type={type ?? 'button'} className={cx(look({ variant, size, block }), className)} {...rest} />;
}

export type LinkButtonProps = ButtonLook &
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** Same look, but a real link. Use whenever the action is navigation. */
export function LinkButton({ variant, size, block, className, ...rest }: LinkButtonProps) {
  return <a className={cx(look({ variant, size, block }), className)} {...rest} />;
}
