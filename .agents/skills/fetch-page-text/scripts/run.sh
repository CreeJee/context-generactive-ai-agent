# run_skill network: delta.dev *.delta.dev tryboxi.xyz *.tryboxi.xyz github.com raw.githubusercontent.com
url="$1"
max="${2:-12000}"
if [ -z "$url" ]; then echo 'usage: fetch-page-text <url> [maxChars]' >&2; exit 2; fi
html=$(curl -sSL -A 'Mozilla/5.0 (Macintosh) research-fetch' --max-time 30 -w '\n__STATUS__ %{http_code} %{url_effective}' "$url") || { echo "fetch failed: $url" >&2; exit 1; }
printf '%s\n' "$html" | grep '^__STATUS__' | tail -1
echo '== links =='
printf '%s' "$html" | grep -oE 'href="[^"#]+"' | sed 's/^href="//; s/"$//' | grep -vE '\.(css|js|png|svg|ico|jpg|webp|woff2?)($|\?)' | sort -u | head -80
echo '== text =='
printf '%s' "$html" | perl -0777 -pe 's/<script\b.*?<\/script>//gis; s/<style\b.*?<\/style>//gis; s/<!--.*?-->//gs; s/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section)[^>]*>/\n/gi; s/<[^>]+>/ /g; s/&nbsp;/ /g; s/&amp;/&/g; s/&lt;/</g; s/&gt;/>/g; s/&quot;/"/g; s/&#x27;|&#39;/'"'"'/g; s/[ \t]+/ /g; s/\n\s*\n+/\n/g' | head -c "$max"
echo
