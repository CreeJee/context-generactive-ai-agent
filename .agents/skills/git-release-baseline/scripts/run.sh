# run_skill network: github.com
# Rewrite ssh remote to https so the sandbox can reach it without ssh keys.
url=$(git remote get-url origin)
echo "$url"
https=$(printf '%s\n' "$url" | sed -e 's#^git@github.com:#https://github.com/#' -e 's#^ssh://git@github.com/#https://github.com/#')
git ls-remote --tags --refs "$https" 2>/dev/null | awk -F/ '{print $NF}' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -5
