#!/usr/bin/env bash
# Executado no host. A parada protege a consistência entre os dois bancos SQLite.
set -Eeuo pipefail
umask 077

PROJECT_DIR=${PROJECT_DIR:-/opt/projetos/gas-cost}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/gas-cost}
CONTAINER=${CONTAINER:-gas-cost}
RETENTION_DAYS=${RETENTION_DAYS:-30}

[[ "$PROJECT_DIR" = /* && -f "$PROJECT_DIR/compose.yaml" ]] || { echo 'Diretório do projeto inválido.' >&2; exit 1; }
[[ "$BACKUP_DIR" = /* && "$BACKUP_DIR" != / && "$BACKUP_DIR" != "$PROJECT_DIR" ]] || { echo 'Diretório de backup inválido.' >&2; exit 1; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -ge 1 ]] || { echo 'Retenção inválida.' >&2; exit 1; }
for command in docker tar sha256sum flock find realpath; do command -v "$command" >/dev/null; done
PROJECT_DIR=$(realpath "$PROJECT_DIR")
mkdir -p "$BACKUP_DIR"
BACKUP_DIR=$(realpath "$BACKUP_DIR")
case "$BACKUP_DIR/" in "$PROJECT_DIR/"*) echo 'Guarde os backups fora do projeto.' >&2; exit 1;; esac
chmod 700 "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo 'Já existe um backup em andamento.' >&2; exit 1; }

work=$(mktemp -d "$BACKUP_DIR/.pending.XXXXXXXX")
restart_required=0
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$restart_required" = 1 ]]; then
    if ! docker start "$CONTAINER" >/dev/null; then
      echo "ERRO: reinicie o container $CONTAINER manualmente." >&2
      result=1
    fi
  fi
  # Somente a pasta temporária criada por esta execução.
  rm -rf -- "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER")
[[ "$state" = running || "$state" = exited || "$state" = created ]] || { echo "Estado incompatível: $state" >&2; exit 1; }
image_id=$(docker inspect --format '{{.Image}}' "$CONTAINER")
printf 'Iniciando backup de %s em %s\n' "$CONTAINER" "$(date -Is)"

# Código e .env também são confidenciais. O diretório e o arquivo final são privados.
# Não execute simultaneamente com deploy/rsync.
tar --exclude='./node_modules' --exclude='./.git' --exclude='./data' \
  -czf "$work/application.tar.gz" -C "$PROJECT_DIR" .

mkdir "$work/data"
if [[ "$state" = running ]]; then
  restart_required=1
  docker stop --time 30 "$CONTAINER" >/dev/null
fi
docker cp "$CONTAINER:/app/data/." "$work/data/"
[[ -s "$work/data/auth.db" && -s "$work/data/gascost.db" ]] || { echo 'Os dois bancos não foram encontrados; backup cancelado.' >&2; exit 1; }
if [[ "$restart_required" = 1 ]]; then
  docker start "$CONTAINER" >/dev/null
  restart_required=0
fi

printf 'created_at=%s\ncontainer=%s\nimage_id=%s\noriginal_state=%s\n' \
  "$(date -Is)" "$CONTAINER" "$image_id" "$state" > "$work/manifest.txt"
archive="gascost-$(date -u +%Y%m%dT%H%M%SZ)-${work##*.}.tar.gz"
tar -czf "$work/$archive" -C "$work" data application.tar.gz manifest.txt
tar -tzf "$work/$archive" >/dev/null
(cd "$work" && sha256sum "$archive" > "$archive.sha256")
chmod 600 "$work/$archive" "$work/$archive.sha256"
mv "$work/$archive.sha256" "$BACKUP_DIR/"
mv "$work/$archive" "$BACKUP_DIR/"

# Retenção somente depois de uma cópia concluída, com nomes gerados pela rotina.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'gascost-*.tar.gz' -mmin "+$((RETENTION_DAYS * 1440))" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'gascost-*.tar.gz.sha256' -mmin "+$((RETENTION_DAYS * 1440))" -delete
printf 'Backup concluído: %s/%s\n' "$BACKUP_DIR" "$archive"
