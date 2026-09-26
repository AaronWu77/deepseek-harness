/** Directory links for the temporary NodeNext consumer. */
import { symlinkSync } from 'node:fs'

/**
 * Link a workspace directory without requiring Windows symbolic-link privileges.
 * @param target - absolute workspace package directory.
 * @param link - destination inside the temporary consumer.
 */
export function linkNodeNextDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}
