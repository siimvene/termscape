import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  telemetry: {
    title: 'Send anonymous usage data',
    keywords: ['privacy', 'telemetry', 'usage', 'analytics', 'data']
  }
}
const ENTRIES = Object.values(ROWS)

export function PrivacySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="privacy" title="Privacy" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.telemetry}>
        <FieldRow
          label="Send anonymous usage data (version/OS)"
          description="Off in Termscape builds: nothing is sent to the upstream nodeterm backend, neither this ping nor the install count, and its update notices and banners are not fetched."
          control={
            // Termscape fork: the ping and the /v1/check feed are dead switches (main/telemetry.ts,
            // core/check.ts), so the toggle renders off and inert rather than claiming a choice.
            <Switch
              checked={false}
              disabled
              onChange={(v) => update({ telemetryEnabled: v })}
              ariaLabel="Telemetry"
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
