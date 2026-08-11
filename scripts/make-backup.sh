#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Ya Viene — make-backup.sh
#  Respaldo de la base de datos con backup online (WAL-safe).
#  Guarda en ~/Desktop/YaViene_Backups/ y conserva las últimas 10.
#
#  Uso:
#    ./scripts/make-backup.sh                  # respaldo normal
#    BACKUP_DIR=/otra/ruta ./scripts/make-backup.sh
# ═══════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-$HOME/Desktop/YaViene_Backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/yaviene-$STAMP.db"

echo "▶ Respaldando la base..."
node scripts/backup-db.mjs "$TARGET"

# Conservar solo las últimas 10 copias.
ls -1t "$BACKUP_DIR"/yaviene-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f

# Verificación rápida: el archivo debe abrir limpio.
CHECK="$(sqlite3 "$TARGET" 'PRAGMA integrity_check;' 2>&1 | head -1)"
if [ "$CHECK" != "ok" ]; then
  echo "✗ El respaldo no pasó la verificación de integridad: $CHECK"
  exit 1
fi

echo "✔ Respaldo OK: $TARGET"
echo "  Copias guardadas: $(ls -1 "$BACKUP_DIR"/yaviene-*.db 2>/dev/null | wc -l | tr -d ' ') de 10"
echo "  Consejo: copia la carpeta $BACKUP_DIR a iCloud o una USB para que no viva solo en este Mac."