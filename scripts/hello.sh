#!/bin/bash
# Example wakecron script. Try it: ./wakecron add hello.sh +3m
echo "Hello from wakecron at $(date)"
osascript -e 'display notification "hello.sh ran" with title "wakecron"' || true
