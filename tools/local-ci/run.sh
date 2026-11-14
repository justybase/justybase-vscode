#!/usr/bin/env bash
# Entry point for the local CI runner. Run from WSL (or any Linux shell with
# Docker). The host checkout is mounted read-only; all work happens in Docker
# volumes owned by the local CI image.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"

IMAGE="${JUSTYBASE_LOCAL_CI_IMAGE:-justybase-local-ci:node24}"

usage() {
    cat <<'EOF'
Usage:
  tools/local-ci/run.sh <stage> [options]

Stages:
  quality           docs + quality jobs (types, lint, architecture, build)
  tests             unit/coverage, UI coverage, parser and Extension Host gates
  integration       DuckDB + File SQL integration suites from the release gate
  release-dry-run   version bump + build + VSIX package + marketplace audit
  all               run quality, tests, integration, then release-dry-run

Options:
  --release-type <type>   patch|minor|major|prepatch|preminor|premajor|prerelease|exact
                          (release-dry-run only; default: patch)
  --version <x.y.z>       explicit version, required with --release-type exact
  --base <git-ref>        enable changed high-risk coverage against a git ref
  --allow-dirty           allow release-dry-run with uncommitted changes
  --refresh-deps          force npm ci even when cached dependency hashes match
  --skip-deps             reuse installed dependencies; fail if they are missing
  --rebuild               rebuild the local CI image before running
  --clean                 remove this repository's snapshot and state volumes first
  --list                  list stages and exit
  --help                  show this help

Examples:
  tools/local-ci/run.sh quality
  tools/local-ci/run.sh tests
  tools/local-ci/run.sh integration
  tools/local-ci/run.sh release-dry-run --release-type patch
  tools/local-ci/run.sh release-dry-run --release-type exact --version 3.21.0
  tools/local-ci/run.sh all --release-type minor

Outputs are written to artifacts/local-ci/.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
fi

if [[ $# -eq 0 ]]; then
    usage >&2
    exit 2
fi

command -v docker >/dev/null 2>&1 || {
    echo "error: docker is not installed or not on PATH" >&2
    exit 1
}

docker info >/dev/null 2>&1 || {
    echo "error: the Docker daemon is not reachable (is Docker running in WSL?)" >&2
    exit 1
}

# Docker Desktop paths from Git Bash need a Windows-style bind source. WSL
# paths are left untouched.
case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
        REPO_ROOT="$(cd -- "${REPO_ROOT}" && pwd -W 2>/dev/null || printf '%s' "${REPO_ROOT}")"
        ;;
esac

# Stable, short volume suffix derived from the checkout path.
REPO_HASH="$(printf '%s' "${REPO_ROOT}" | cksum | awk '{print $1}')"
WORK_VOLUME="justybase-local-ci-work-${REPO_HASH}"
STATE_VOLUME="justybase-local-ci-state-${REPO_HASH}"

RUN_ARGS=()
REBUILD=0
CLEAN=0

for arg in "$@"; do
    case "${arg}" in
        --rebuild)
            REBUILD=1
            ;;
        --clean)
            CLEAN=1
            ;;
        *)
            RUN_ARGS+=("${arg}")
            ;;
    esac
done

if (( CLEAN )); then
    echo "==> Removing local CI work volumes for ${REPO_ROOT}"
    docker volume rm -f "${WORK_VOLUME}" "${STATE_VOLUME}" >/dev/null 2>&1 || true
fi

if (( REBUILD )) || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    echo "==> Building local CI image ${IMAGE}"
    docker build --pull -f "${SCRIPT_DIR}/Dockerfile" -t "${IMAGE}" "${SCRIPT_DIR}"
fi

OUT_DIR="${REPO_ROOT}/artifacts/local-ci"
mkdir -p "${OUT_DIR}"

TTY_ARGS=(-i)
if [[ -t 0 && -t 1 ]]; then
    TTY_ARGS+=(-t)
fi

echo "==> Repository: ${REPO_ROOT}"
echo "==> Outputs:    ${OUT_DIR}"
echo "==> Stage:      ${RUN_ARGS[*]}"

exec docker run --rm --init \
    "${TTY_ARGS[@]}" \
    --shm-size=1g \
    -e LOCAL_CI_REPO_ROOT=/src \
    -e LOCAL_CI_OUT=/out \
    -e "npm_config_cache=/ci-state/npm-cache" \
    -e CI=true \
    -e GIT_TERMINAL_PROMPT=0 \
    -v "${REPO_ROOT}:/src:ro" \
    -v "${WORK_VOLUME}:/work" \
    -v "${STATE_VOLUME}:/ci-state" \
    -v "justybase-local-ci-vscode-cache:/home/node/.vscode-test" \
    -v "justybase-local-ci-electron-cache:/home/node/.cache" \
    -v "${OUT_DIR}:/out" \
    -w /src \
    "${IMAGE}" \
    node /src/tools/local-ci/run.mjs "${RUN_ARGS[@]}"
