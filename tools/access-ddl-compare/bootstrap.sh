#!/usr/bin/env bash
# Bootstraps the JustyBase.UCanAccessCs port (the reference implementation for
# replaying Access DDL) into tools/access-ddl-compare/.clone/.
set -euo pipefail

repo_url="${UCANACCESS_CS_REPO:-https://github.com/justybase/JustyBase.UCanAccessCs.git}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clone_dir="${script_dir}/.clone"

if [[ -d "${clone_dir}/.git" ]]; then
    echo "UCanAccessCs clone already present at ${clone_dir}"
    exit 0
fi

mkdir -p "${script_dir}"
echo "Cloning ${repo_url} into ${clone_dir}..."
git clone --depth 1 "${repo_url}" "${clone_dir}"
echo "Done. Build with: dotnet build tools/access-ddl-compare"
