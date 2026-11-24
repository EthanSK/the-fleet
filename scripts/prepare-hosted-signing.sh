#!/bin/bash
# Generated from launch-personal-project/assets/prepare-hosted-signing.sh.
# Canonical SHA-256: 79212b08b8927a6806076fc9002a7d3c2a215ee91cd04e2130a71966cd3aab5a
# Edit the canonical asset and regenerate; this committed copy keeps CI self-contained.
# Provision this hosted release's temporary Apple and Sparkle signing credentials. — GPT-6.1 Sol
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
  echo "This credential setup requires a GitHub-hosted runner." >&2
  exit 1
}
umask 077
for name in APPLE_CERTIFICATE_P12_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD SPARKLE_ED25519_PRIVATE_KEY SPARKLE_ACCOUNT SPARKLE_TOOLS; do
  [[ -n "${!name:-}" ]] || { echo "Missing required release input: $name" >&2; exit 1; }
done
keychain="$RUNNER_TEMP/release-signing.keychain-db"
certificate="$RUNNER_TEMP/release-identity.p12"
sparkle_key="$RUNNER_TEMP/release-sparkle-key"
printf 'RELEASE_KEYCHAIN=%s\nRELEASE_CERTIFICATE=%s\nRELEASE_SPARKLE_KEY=%s\n' "$keychain" "$certificate" "$sparkle_key" >> "$GITHUB_ENV"
password="$(openssl rand -hex 32)"
echo "::add-mask::$password"
printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$certificate"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$certificate" -P "$APPLE_CERTIFICATE_PASSWORD" -k "$keychain" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
rm -f "$certificate"
xcrun notarytool store-credentials ReleaseCI --keychain "$keychain" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
printf '%s' "$SPARKLE_ED25519_PRIVATE_KEY" > "$sparkle_key"
"$SPARKLE_TOOLS/generate_keys" --account "$SPARKLE_ACCOUNT" -f "$sparkle_key" >/dev/null
# Keep the restricted file for Sparkle signing tools so CI never requires an interactive Keychain access prompt.
printf 'NOTARY_PROFILE=ReleaseCI\nNOTARY_KEYCHAIN=%s\nSPARKLE_KEY_FILE=%s\n' "$keychain" "$sparkle_key" >> "$GITHUB_ENV"
