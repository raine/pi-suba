set shell := ["bash", "-euo", "pipefail", "-c"]

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
