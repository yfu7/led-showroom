import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tip } from './Tooltip';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  active?: boolean;
  block?: boolean;
  icon?: ReactNode;
  tip?: string;
  kbd?: string;
}

export function Button({ variant = 'default', size = 'md', active, block, icon, tip, kbd, className = '', children, ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'default' ? variant : '', size === 'sm' ? 'sm' : '', active ? 'active' : '', block ? 'block' : '', className].filter(Boolean).join(' ');
  const btn = <button type="button" className={cls} {...rest}>{icon}{children}</button>;
  return tip ? <Tip label={tip} kbd={kbd}>{btn}</Tip> : btn;
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: 'sm' | 'md';
  round?: boolean;
  tip?: string;
  kbd?: string;
}

export function IconButton({ active, size = 'md', round, tip, kbd, className = '', children, ...rest }: IconButtonProps) {
  const cls = ['iconbtn', active ? 'active' : '', size === 'sm' ? 'sm' : '', round ? 'round' : '', className].filter(Boolean).join(' ');
  const btn = <button type="button" className={cls} aria-label={tip} {...rest}>{children}</button>;
  return tip ? <Tip label={tip} kbd={kbd}>{btn}</Tip> : btn;
}
