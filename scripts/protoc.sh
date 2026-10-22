#!/bin/sh
exec /usr/bin/protoc "$@" -I. -I/usr/include
