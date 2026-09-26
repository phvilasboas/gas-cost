#!/usr/bin/env bash
set -eu
printf '%s\n' "$1" >> "$TEST_DOCKER_LOG"
case "$1" in
  inspect)
    if [[ "$3" = '{{.State.Status}}' ]]; then printf '%s\n' "$TEST_CONTAINER_STATE"; else echo 'sha256:test'; fi
    ;;
  stop|start) : ;;
  cp)
    [[ "${TEST_COPY_FAIL:-0}" != 1 ]] || exit 1
    cp -a "$TEST_DATA/." "$3"
    ;;
  *) exit 1 ;;
esac
