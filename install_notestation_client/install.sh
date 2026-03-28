#!/usr/bin/env bash
# Downloads and installs the notestation-client binary from blues/notestation
# GitHub Releases. Intended to be called by both the install_notestation_client
# composite action and the reserve_notestation JS action.
#
# Required env vars:
#   INPUT_VERSION  — release tag to install (e.g. v1.2.3)
#   INPUT_TOKEN    — GitHub token with access to blues/notestation
set -euo pipefail

VERSION="${INPUT_VERSION:?INPUT_VERSION is required}"
TOKEN="${INPUT_TOKEN:?INPUT_TOKEN is required}"

echo "::group::Install notestation-client ${VERSION}"

# ── Architecture detection ────────────────────────────────────────────────────

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64)  GOARCH="amd64" ;;
  aarch64) GOARCH="arm64" ;;
  *)
    echo "::error::Unsupported architecture: ${ARCH}. Only x86_64 and aarch64 are supported."
    exit 1
    ;;
esac

BINARY="notestation-client-linux-${GOARCH}"
TMP_PATH="/tmp/${BINARY}"
DEST="/usr/local/bin/notestation-client"

echo "Architecture : ${ARCH} (${GOARCH})"
echo "Asset        : ${BINARY}"
echo "Version      : ${VERSION}"
echo "Destination  : ${DEST}"

# ── Verify gh CLI is available ────────────────────────────────────────────────

if ! command -v gh &>/dev/null; then
  echo "::error::The 'gh' CLI is required but was not found on PATH. Please install it on this runner."
  exit 1
fi
echo "gh CLI       : $(gh --version | head -1)"

# ── Download release asset ────────────────────────────────────────────────────

echo ""
echo "Downloading ${BINARY} @ ${VERSION} from blues/notestation..."

if ! GH_TOKEN="${TOKEN}" gh release download "${VERSION}" \
    --repo blues/notestation \
    --pattern "${BINARY}" \
    --output "${TMP_PATH}" \
    --clobber; then
  echo "::error::Failed to download '${BINARY}' from release '${VERSION}'. " \
       "Check that the version exists and the token has access to blues/notestation."
  exit 1
fi

echo "Downloaded to ${TMP_PATH} ($(du -h "${TMP_PATH}" | cut -f1))"

# ── Install ───────────────────────────────────────────────────────────────────

echo "Installing to ${DEST}..."
if ! sudo install -m 0755 "${TMP_PATH}" "${DEST}"; then
  echo "::error::Failed to install binary to ${DEST}."
  exit 1
fi
rm -f "${TMP_PATH}"

# ── Verify ────────────────────────────────────────────────────────────────────

echo "Verifying installation..."
if ! VERSION_OUT="$(notestation-client --version 2>&1)"; then
  echo "::error::notestation-client --version failed after installation: ${VERSION_OUT}"
  exit 1
fi

echo "Installed    : ${VERSION_OUT}"
echo ""
echo "notestation-client is ready."
echo "::endgroup::"
