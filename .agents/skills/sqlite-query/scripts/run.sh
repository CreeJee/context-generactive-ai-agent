# Runs one read-only SQL statement against a SQLite file and prints the rows as one JSON line.
# Usage: sqlite-query <database path> <sql>   (paths relative to the project root)
set -e
db=$1
sql=$2
if [ -z "$db" ] || [ -z "$sql" ]; then
  echo "usage: sqlite-query <database path> <sql>" >&2
  exit 2
fi
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, sql] = process.argv.slice(-2);
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  process.stdout.write(JSON.stringify(db.prepare(sql).all()).slice(0, 6000) + "\n");
} finally {
  db.close();
}
' "$db" "$sql"
