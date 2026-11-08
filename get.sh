#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Installs the latest ready-built Isle release into the user's home folder, usually piped from curl.
# ISLE_VERSION=1.0.5 picks a release, ISLE_PACKAGE=<tarball> installs a downloaded one, ISLE_FORCE=1 any GNOME.
set -euo pipefail

REPO="zickrian/isle"
ARCH="$(uname -m)"
# A release just tagged may take a few minutes to get its files.
RETRIES=6
RETRY_WAIT=20
# GitHub now and then times out or is busy for a moment (a 408, 429 or 5xx): curl asks again a few times.
# The time limit keeps an answer of "come back in an hour" from holding the install up; the API's is
# shorter, as its own limit has a way around it (web_package).
CURL_RETRY=(--retry 4 --retry-delay 3 --retry-max-time 120)
API_RETRY=(--retry 3 --retry-delay 3 --retry-max-time 20)

# A step's heading, in bold.
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
# Says what went wrong and stops.
fail() { printf 'Isle: %s\n' "$*" >&2; exit 1; }

# Turns away root, missing tools and a GNOME Shell outside 46 to 51 (unless ISLE_FORCE=1).
check() {
    # Everything goes to your own home folder: sudo would put it in root's, where your desktop never looks.
    [ "$(id -u)" -ne 0 ] || fail "run this as yourself, without sudo; Isle installs to your own home folder."
    local tool
    for tool in curl tar sha256sum gsettings glib-compile-schemas; do
        command -v "$tool" >/dev/null || fail "please install $tool first."
    done
    command -v gnome-shell >/dev/null || fail "GNOME Shell was not found; Isle is a GNOME Shell extension."
    case "${XDG_CURRENT_DESKTOP:-}" in
        *GNOME*) ;;
        *) echo "Note: this session's desktop is '${XDG_CURRENT_DESKTOP:-unknown}', not GNOME; Isle shows up once you log in to GNOME." ;;
    esac
    local version
    version="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
    if [ -z "$version" ] || [ "$version" -lt 46 ] || [ "$version" -gt 51 ]; then
        [ "${ISLE_FORCE:-}" = 1 ] ||
            fail "Isle is made for GNOME Shell 46 to 51, and this is GNOME Shell ${version:-unknown}. Nothing was changed. (ISLE_FORCE=1 installs anyway.)"
        echo "Note: GNOME Shell ${version:-unknown} is not one Isle was made for; installing anyway."
    fi
}

# The download found without GitHub's API, which answers an address 60 times an hour: the latest
# release's tag from where its page leads, and the file by its name.
web_package() {
    local tag="v${ISLE_VERSION:-}" url
    if [ -z "${ISLE_VERSION:-}" ]; then
        tag="$(curl -fsLI "${CURL_RETRY[@]}" -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" || return 1
        tag="${tag##*/}"
    fi
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    url="https://github.com/$REPO/releases/download/$tag/isle-${tag#v}-$ARCH-linux.tar.gz"
    curl -fsLI "${CURL_RETRY[@]}" -o /dev/null "$url" || return 1
    printf '%s\n' "$url"
}

# The release's download for this computer, waiting a little for one just published.
find_package() {
    local api reply url attempt
    if [ -n "${ISLE_VERSION:-}" ]; then
        api="https://api.github.com/repos/$REPO/releases/tags/v$ISLE_VERSION"
    else
        api="https://api.github.com/repos/$REPO/releases/latest"
    fi
    for attempt in $(seq "$RETRIES"); do
        if ! reply="$(curl -sSL "${API_RETRY[@]}" -w '\n%{http_code}' "$api" 2>&1)"; then
            fail "could not reach GitHub ($reply); check the internet connection and try again."
        fi
        case "${reply##*$'\n'}" in
            200) ;;
            403 | 429)
                url="$(web_package)" || fail "GitHub limits how often it is asked; try again in an hour."
                printf '%s\n' "$url"
                return ;;
            404) fail "no release ${ISLE_VERSION:+v$ISLE_VERSION }was found at github.com/$REPO/releases." ;;
            *) fail "GitHub answered ${reply##*$'\n'}; try again later." ;;
        esac
        url="$(printf '%s' "$reply" |
            grep -oE "\"browser_download_url\": *\"[^\"]*-$ARCH-linux\\.tar\\.gz\"" |
            cut -d'"' -f4 | head -n1 || true)"
        if [ -n "$url" ]; then
            printf '%s\n' "$url"
            return
        fi
        # x86_64 is always built: a release without it is still getting its files.
        if [ "$ARCH" != x86_64 ] || [ "$attempt" -ge "$RETRIES" ]; then
            break
        fi
        echo "The release is still being published; trying again in $RETRY_WAIT s." >&2
        sleep "$RETRY_WAIT"
    done
    fail "no ready-built Isle for $ARCH; build it from source instead (see github.com/$REPO#other-ways-to-install)."
}

# Downloads and checks the package (or takes ISLE_PACKAGE), then runs its installer.
main() {
    check
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT

    if [ -n "${ISLE_PACKAGE:-}" ]; then
        cp "$ISLE_PACKAGE" "$WORK/isle.tar.gz"
    else
        say "Finding the release"
        local url expected actual
        url="$(find_package)"
        say "Downloading $(basename "$url")"
        curl -fsSL "${CURL_RETRY[@]}" "$url" -o "$WORK/isle.tar.gz" || fail "the download failed; please try again."
        curl -fsSL "${CURL_RETRY[@]}" "$url.sha256" -o "$WORK/isle.tar.gz.sha256" || fail "the download failed; please try again."
        expected="$(cut -d' ' -f1 "$WORK/isle.tar.gz.sha256")"
        actual="$(sha256sum "$WORK/isle.tar.gz" | cut -d' ' -f1)"
        [ "$expected" = "$actual" ] || fail "the download is damaged (checksum mismatch); please try again."
    fi

    tar -C "$WORK" -xzf "$WORK/isle.tar.gz"
    local package
    package="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'isle-*' | head -n1)"
    [ -n "$package" ] || fail "the package has an unexpected layout."
    # Through bash: a /tmp mounted noexec runs no file in it directly.
    bash "$package/install.sh"

    # The package's uninstaller stays around as a command.
    install -Dm755 "$package/uninstall.sh" "$HOME/.local/bin/isle-uninstall"
    echo
    # Not when a speech model is there already (an update, or a voice setup it moved over).
    if ! compgen -G "${XDG_DATA_HOME:-$HOME/.local/share}/isle/models/ggml-*-q8_0.bin" >/dev/null; then
        echo "Voice assistant (optional): press Super+I and Set up, or run ~/.local/bin/isle-setup-voice once."
    fi
    echo "To check it, run ~/.local/bin/isled --doctor; to remove Isle, run ~/.local/bin/isle-uninstall."
}

# All read before anything runs: a download cut short never runs half a script.
main "$@"
