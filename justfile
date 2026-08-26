set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

oxfmt_globs := "'**/*.ts' '**/*.tsx' '**/*.js' '**/*.jsx' '**/*.mjs' '**/*.cjs' '**/*.mts' '**/*.cts' '**/*.json' '**/*.jsonc'"

install:
    npm install

install-hooks:
    scripts/install-git-hook-shims

types:
    npm exec tsgo -- --noEmit

lint:
    npm exec oxlint -- --type-aware --deny-warnings

check-format:
    npm exec oxfmt -- --check {{oxfmt_globs}}

fix-format:
    npm exec oxfmt -- --write {{oxfmt_globs}}

[parallel]
check-push: check-format check

check mode="":
    node scripts/check.mjs {{mode}}

cua-setup:
    cua-sandbox setup

cua-list:
    cua-sandbox list

cua-status session:
    cua-sandbox status "{{session}}"

cua-deploy session:
    ./scripts/cua-deploy "{{session}}"

cua-fixtures session:
    ./scripts/cua-fixtures "{{session}}"

cua-auth session action="copy":
    ./scripts/cua-auth "{{session}}" "{{action}}"

cua-launch session mode="fake" model="openai-codex/gpt-5.6-luna":
    ./scripts/cua-launch "{{session}}" "{{mode}}" "{{model}}"

cua-assert session child="":
    ./scripts/cua-assert "{{session}}" "{{child}}"

cua-config session variant="valid":
    ./scripts/cua-config "{{session}}" "{{variant}}"

cua-reset session:
    ./scripts/cua-reset "{{session}}"

cua-clean session:
    ./scripts/cua-clean "{{session}}"
