#!/bin/bash

if [[ "$(sitesctl auth whoami -o json)" =~ "anonymous" ]]; then
    echo "You are not logged in. Please run 'sitesctl auth login' first."
    exit 1
fi

if [ -n "$1" ]; then
    echo "Uploading files to site: $1"
    sitesctl site --space cems-flood --name release-planning content upload -s $1 --yes
    exit 0
else
    for f in app.js index.html settings.js style.css; do
        sitesctl site --space cems-flood --name release-planning content upload -s $f --yes
    done
fi