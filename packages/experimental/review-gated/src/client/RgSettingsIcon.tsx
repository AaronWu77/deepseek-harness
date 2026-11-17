/** Settings navigation glyph for the RG models section. */
import { IconBranchOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionIconOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Render the RG models navigation glyph.
 * @param props - shell-provided icon size; the glyph keeps the row's text color in both selection states.
 * @returns the section glyph.
 */
export function RgSettingsIcon({ size }: SettingsSectionIconOwnerProps) {
  return <IconBranchOutlineMedium size={size} />
}
