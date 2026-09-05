import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, with later Tailwind utilities winning over earlier ones.
 *
 * Plain concatenation does not work: `"px-2" + "px-4"` leaves both in the class
 * list and the winner depends on stylesheet order rather than on the caller's
 * intent. `twMerge` resolves that, which is what makes a `className` prop on a
 * component actually able to override the component's own styling.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
