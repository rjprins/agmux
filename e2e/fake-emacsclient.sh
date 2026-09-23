#!/bin/sh
# Logs its arguments so e2e tests can check what agmux asked Emacs to do.
printf '%s\n' "$@" >> "${AGMUX_E2E_EMACS_LOG:-/dev/null}"
