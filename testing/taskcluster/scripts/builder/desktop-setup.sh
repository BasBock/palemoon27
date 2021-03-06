#!/bin/bash -ex

test $MOZCONFIG # mozconfig is required...
test -d $1 # workspace must exist at this point...
WORKSPACE=$( cd "$1" && pwd )

# Gecko source:
export GECKO_DIR=$WORKSPACE/gecko
# Gaia source:
export GAIA_DIR=$WORKSPACE/gaia
# Mozbuild config:
export MOZBUILD_STATE_PATH=$WORKSPACE/mozbuild/

# Create .mozbuild so mach doesn't complain about this
mkdir -p $MOZBUILD_STATE_PATH

### Install package dependencies
install-packages.sh $GECKO_DIR

# Ensure object-folder exists
export MOZ_OBJDIR=$(get-objdir.py $GECKO_DIR $WORKSPACE/object-folder/)
mkdir -p $MOZ_OBJDIR
