#!/usr/bin/env bash
# Copy the bundled zero-credit sample into an isolated launcher shelf.
# Does not touch production projects/ (miraichi, matsumoto, empathy, kusakari, …).
set -euo pipefail

if [[ ! -f package.json ]] || [[ ! -f bin/pipeline ]]; then
  echo "run this from the Tsugite repository root" >&2
  exit 1
fi

if [[ ! -f examples/local-fixture/project.yaml ]] || [[ ! -f examples/local-fixture/media/clip-001.mp4 ]]; then
  echo "missing examples/local-fixture (project.yaml + media)" >&2
  exit 1
fi

SKILL_DIR=".cursor/skills/verify-tsugite"
HOME_DIR="${SKILL_DIR}/tmp/projects-home"
PROJECT_DIR="${HOME_DIR}/verify-local-fixture"

mkdir -p "${HOME_DIR}"
rm -rf "${PROJECT_DIR}"
cp -R examples/local-fixture "${PROJECT_DIR}"

# Absolute paths so later commands stay inside this isolated shelf.
ABS_HOME="$(cd "${HOME_DIR}" && pwd)"
ABS_CONFIG="$(cd "${PROJECT_DIR}" && pwd)/project.yaml"

printf '%s\n' "${ABS_HOME}" > "${SKILL_DIR}/tmp/projects-home.path"
printf '%s\n' "${ABS_CONFIG}" > "${SKILL_DIR}/tmp/config.path"

cat <<EOF
export TSUGITE_PROJECTS_HOME=${ABS_HOME}
VERIFY_CONFIG=${ABS_CONFIG}
# use: TSUGITE_PROJECTS_HOME=${ABS_HOME} node bin/pipeline <command> --config ${ABS_CONFIG} --json
EOF
