# Scratch gh config dir inside the project (sandbox-writable); the sandbox cannot read the user config or /var/folders.
scratch=.vp-scratch/gh-config
mkdir -p "$scratch"
GH_CONFIG_DIR="$scratch" GH_NO_UPDATE_NOTIFIER=1 gh release list --limit 30 --json tagName,isDraft,isLatest \
  --jq '[.[] | select(.isDraft == false)] | .[0].tagName'
rm -rf .vp-scratch
