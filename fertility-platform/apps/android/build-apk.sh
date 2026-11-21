#!/usr/bin/env bash
# Build the Android app (a debug-signed APK you can sideload):   bash apps/android/build-apk.sh
# Needs: Node 22+, JDK 21, and the Android SDK (platform 35 + build-tools 35) with ANDROID_HOME set.
# Result: apps/android/dist/cycle-tracker-demo-debug.apk
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$PWD"
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || fail "Node.js 22+ is required."
command -v java >/dev/null || fail "JDK 21 is required."
[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] || fail "Set ANDROID_HOME to your Android SDK (needs platforms;android-35 and build-tools;35.0.0)."
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

# 1. Make sure the web app's shared protocol code is built, then bundle the web app into www/
( cd ../.. && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build --silent )
rm -rf www && mkdir www
cp -r ../pwa/index.html ../pwa/app.js ../pwa/styles.css ../pwa/lib ../pwa/icons ../pwa/vendor ../pwa/manifest.webmanifest www/
# (sw.js is deliberately not bundled: the app files are local, so no service worker is needed)

# 2. Capacitor: copy www into the Android project, then build
[ -d node_modules ] || npm install --no-audit --no-fund
npx cap sync android
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
( cd android && ./gradlew --no-daemon -q assembleDebug )

mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/cycle-tracker-demo-debug.apk
echo "Built: $HERE/dist/cycle-tracker-demo-debug.apk"
