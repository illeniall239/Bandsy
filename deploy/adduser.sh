#!/bin/sh
# sh /opt/bandsy/deploy/adduser.sh <name> <password>   (create your own account first: it owns the history from your PC)
cd /opt/bandsy && sudo -u bandsy BANDSY_DB=/opt/bandsy/data/bandsy.db node server.js adduser "$1" "$2"
