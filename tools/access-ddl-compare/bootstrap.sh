#!/usr/bin/env bash
# Bootstraps the JustyBase.UCanAccessCs port (the reference implementation for
# replaying Access DDL) into tools/access-ddl-compare/.clone/.
set -euo pipefail

repo_url="${UCANACCESS_CS_REPO:-https://github.com/justybase/JustyBase.UCanAccessCs.git}"
pinned_ref="8fcf4a6e7ac485c315a204e51c383c57df09ee11"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clone_dir="${script_dir}/.clone"

if [[ -d "${clone_dir}/.git" ]]; then
    actual_ref="$(git -C "${clone_dir}" rev-parse HEAD)"
    if [[ "${actual_ref}" != "${pinned_ref}" ]]; then
        echo "Existing UCanAccessCs checkout is ${actual_ref}; expected pinned ref ${pinned_ref}." >&2
        exit 1
    fi
    echo "UCanAccessCs clone already present at ${clone_dir} (${pinned_ref})"
    exit 0
fi

mkdir -p "${script_dir}"
echo "Cloning ${repo_url} into ${clone_dir}..."
git clone "${repo_url}" "${clone_dir}"
git -C "${clone_dir}" checkout --detach "${pinned_ref}"
echo "Done at pinned ref ${pinned_ref}. Verify generated data with: node scripts/generate-index-codes.cjs"
echo "Build with: dotnet build tools/access-ddl-compare"
