#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Manual GNOME host check: bash scripts/ci/native-scroll-test.sh <scratch-directory>
# Requires installed GNOME Shell, bubblewrap and D-Bus; never installs packages or uses the host session.
set -euo pipefail

UUID=isle-scroll-regression@tests.local

fail() { printf 'Native scroll regression failed: %s\n' "$*" >&2; exit 1; }

# These entry points run only inside the offline bubblewrap namespace below.
case "${1:-}" in
    --session)
        [[ "${ISLE_NATIVE_SCROLL_SANDBOX:-}" == 1 ]] || fail 'internal session entry point'
        chmod 700 "$XDG_RUNTIME_DIR"
        dbus-daemon --session --address="$DBUS_SYSTEM_BUS_ADDRESS" --fork --nopidfile
        exec dbus-run-session -- bash /tmp/isle-repo/scripts/ci/native-scroll-test.sh --shell
        ;;
    --shell)
        [[ "${ISLE_NATIVE_SCROLL_SANDBOX:-}" == 1 ]] || fail 'internal shell entry point'
        ulimit -t 120
        ulimit -v 8388608
        ulimit -f 65536
        ulimit -n 1024
        shell_version="$(gnome-shell --version)"
        shell_version="${shell_version#GNOME Shell }"
        [[ "$shell_version" =~ ^[0-9]+(\.[[:alnum:]-]+)*$ ]] || fail "unrecognized GNOME Shell version: $shell_version"
        # A fresh private HOME must not put the first-run welcome modal over the input target.
        gsettings set org.gnome.shell welcome-dialog-last-shown-version "'$shell_version'"
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        gsettings set org.gnome.shell disable-user-extensions false
        exec timeout --signal=TERM 120 gnome-shell --headless --wayland --virtual-monitor 1280x720
        ;;
esac

[[ $# == 1 ]] || fail 'usage: bash scripts/ci/native-scroll-test.sh <scratch-directory>'
for binary in bwrap dbus-daemon dbus-run-session gsettings gnome-shell timeout realpath mktemp; do
    command -v "$binary" >/dev/null || fail "required executable not found: $binary"
done

repo="$(realpath "$(dirname "${BASH_SOURCE[0]}")/../..")"
mkdir -p -- "$1"
scratch="$(realpath "$1")"
run="$(mktemp -d "$scratch/isle-native-scroll.XXXXXX")"
cleanup() {
    # Only disposable staging owned by this invocation; leave evidence for inspection.
    rm -rf -- "${run:?}/home" "${run:?}/runtime"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

extension="$run/home/.local/share/gnome-shell/extensions/$UUID"
mkdir -p -- "$extension" "$run/runtime" "$run/evidence"
cp -- "$repo/tests/extension/native-scroll/extension.js" "$repo/tests/extension/native-scroll/metadata.json" "$extension/"
printf 'Native scroll evidence: %s/evidence\n' "$run"

status=0
bwrap --unshare-all --die-with-parent --new-session \
    --ro-bind / / --tmpfs /home --tmpfs /run --tmpfs /tmp --tmpfs /var/tmp \
    --proc /proc --dev /dev \
    --ro-bind "$repo" /tmp/isle-repo --bind "$run" /tmp/proof --chdir /tmp/proof \
    --clearenv \
    --setenv HOME /tmp/proof/home \
    --setenv USER tester --setenv LOGNAME tester --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 \
    --setenv XDG_RUNTIME_DIR /tmp/proof/runtime \
    --setenv XDG_CONFIG_HOME /tmp/proof/home/.config \
    --setenv XDG_DATA_HOME /tmp/proof/home/.local/share \
    --setenv XDG_CACHE_HOME /tmp/proof/home/.cache \
    --setenv XDG_STATE_HOME /tmp/proof/home/.local/state \
    --setenv GSETTINGS_BACKEND keyfile --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv LP_NUM_THREADS 2 \
    --setenv DBUS_SYSTEM_BUS_ADDRESS unix:path=/tmp/proof/runtime/system-bus \
    --setenv ISLE_NATIVE_SCROLL_SANDBOX 1 \
    /usr/bin/bash /tmp/isle-repo/scripts/ci/native-scroll-test.sh --session \
    >"$run/evidence/session.log" 2>&1 || status=$?

[[ $status == 0 ]] || fail "private shell exited with status $status; see $run/evidence/session.log"
[[ -f "$run/evidence/result" ]] || fail "harness did not finish; see $run/evidence/session.log"
IFS= read -r result <"$run/evidence/result"
[[ "$result" == PASS ]] || fail "native assertions failed; see $run/evidence/native-scroll-events.json"
if grep -E 'JS ERROR|CRITICAL|Unknown/invalid|"fatal"' "$run/evidence/session.log"; then
    fail "shell or harness error; see $run/evidence/session.log"
fi
printf 'PASS: 88 native scroll assertions; captures and event trace in %s/evidence\n' "$run"
