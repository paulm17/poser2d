#!/bin/sh
# Restore local dependencies without vendoring a nested Git repository.
set -eu
cd "$(dirname "$0")"
revision=2b0f4041b368e3408cfb826f4cf09e6f8dafa164
if [ ! -d upstream ]; then
    git clone https://github.com/AHEKOT/ComfyUI_VNCCS_Utils.git upstream
    git -C upstream checkout --detach "$revision"
fi
if [ "$(git -C upstream rev-parse HEAD)" != "$revision" ]; then
    echo 'upstream is at an unexpected revision; existing files were preserved.' >&2
    exit 1
fi
if [ ! -d ../frontend/node_modules ]; then
    echo 'Install frontend dependencies first: npm --prefix frontend ci' >&2
    exit 1
fi
if [ -L source-node-modules ]; then
    if [ "$(readlink source-node-modules)" != ../frontend/node_modules ]; then
        echo 'Unexpected source-node-modules link; existing link was preserved.' >&2
        exit 1
    fi
elif [ -e source-node-modules ]; then
    echo 'source-node-modules already exists and is not a symlink; preserved.' >&2
    exit 1
else
    ln -s ../frontend/node_modules source-node-modules
fi
printf '%s\n' 'Generator dependencies ready.'
