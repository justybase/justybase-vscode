#!/usr/bin/env bash
# Runs the Access DDL comparison harness while wiring --repo into MSBuild.
# dotnet run builds the project before Program.cs receives application args,
# so the repository path must be supplied as an MSBuild property as well.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
repo_path="$SCRIPT_DIR/.clone"
args=("$@")

for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in
        --repo)
            if ((i + 1 >= ${#args[@]})); then
                echo "--repo requires a path." >&2
                exit 2
            fi
            repo_path="${args[i + 1]}"
            i=$((i + 1))
            ;;
        --repo=*)
            repo_path="${args[i]#--repo=}"
            ;;
    esac
done

repo_project="$repo_path/src/UCanAccess/UCanAccess.csproj"
if [[ ! -f "$repo_project" ]]; then
    echo "The JustyBase.UCanAccessCs project was not found at $repo_project." >&2
    echo "Run bootstrap.sh first or pass --repo <path-to-justybase-UCanAccessCs>." >&2
    exit 2
fi

repo_path="$(cd "$repo_path" && pwd -P)"
exec dotnet run \
    --project "$SCRIPT_DIR" \
    -p:UCanAccessRepo="$repo_path" \
    -- "${args[@]}"
