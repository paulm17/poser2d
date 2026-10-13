#!/bin/sh
set -eu

# Cargo also applies the runner to xtask; run that tool directly.
case "$1" in
  */theapp)
    shift
    exec cargo run -p xtask -- --run "$@"
    ;;
  *) exec "$@" ;;
esac
